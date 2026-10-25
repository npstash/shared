// The facade: an MCP server that forwards each tool request to Playwright MCP.
//
//   MCP client (Claude Code) <-> facade server | facade client <-> Playwright MCP (child process)
//
// Each tool call goes through these steps (see callTool()):
//   tool switch (config/tools.ini) → host check (config/hosts.ini) → placeholders (providers/)
//   → Playwright MCP → scrub of filled values → host check of the opened page → log
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListRootsRequestSchema,
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import readline from 'node:readline';
import { UPSTREAM_CLI, VERSION, configDirs, tmpDirInTool, upstreamEnv } from './config.js';
import { FillError } from './fill/provider.js';
import { FillRegistry } from './fill/registry.js';
import { FileAllowProvider } from './hosts/file-allow-provider.js';
import { HostPolicy } from './hosts/host-policy.js';
import { HostsFile } from './hosts/hosts-file.js';
import { hostOfUrl } from './hosts/patterns.js';
import { listValue, readIni, sectionValues } from './ini.js';
import { summarizeResult } from './logger.js';
import { ToolsConfig } from './tools-config.js';

// Maximum time of one tool call without progress. Playwright has its own, shorter timeouts.
const TOOL_TIMEOUT = 10 * 60 * 1000;

// Maximum time of browser_close at shutdown.
const CLOSE_TIMEOUT = 5000;

// Maximum time that the user has to answer a dialog of the ask provider.
const ASK_TIMEOUT = 5 * 60 * 1000;

// Maximum text in a debug log entry of a tool result.
const DEBUG_TEXT_MAX = 20000;

const PLACEHOLDER_NOTE = ' Do not type personal data or credentials: write a placeholder such as {{email}} or {{password}}. '
  + 'The facade types the value, and the result shows only the placeholder. fill_values_list gives the placeholders of the page.';

const INSTRUCTIONS = 'This server is a facade for Playwright MCP. Do not type personal data or credentials into forms. '
  + 'Write placeholders such as {{name}}, {{email}}, {{username}} or {{password}} as form values. '
  + 'Call fill_values_list to see the placeholders for the current page.';

// The tools of the facade itself. Each one is also in config/tools.ini.
const FACADE_TOOLS = [{
  name: 'fill_values_list',
  description: 'List the placeholders that the facade can fill on the current page, e.g. {{email}}. '
    + 'Write a placeholder as a value in browser_type, browser_fill_form or browser_select_option. '
    + 'The facade types the real value. You never see it.',
  inputSchema: { type: 'object', properties: {} },
}];

const FILL_TOOLS = new Set(['browser_type', 'browser_fill_form', 'browser_select_option']);

export async function startFacade({ args, logger, serverTransport, cwd = process.cwd(), env = process.env, onClose }) {
  let markDownstreamReady;
  const downstreamReady = new Promise((resolve) => { markDownstreamReady = resolve; });
  let server;

  // 1. Load the config of the facade.
  const dirs = configDirs(env);
  const facadeIni = readIni(path.join(dirs.config, 'facade.ini'));
  const toolsConfig = new ToolsConfig(path.join(dirs.config, 'tools.ini'), logger);
  const hostsFile = new HostsFile(path.join(dirs.config, 'hosts.ini'));
  const record = sectionValues(facadeIni, 'hosts').record !== 'false';
  const hostPolicy = new HostPolicy({ hostsFile, allowProvider: new FileAllowProvider({ hostsFile, record, logger }) });
  const fill = await FillRegistry.load({
    names: listValue(sectionValues(facadeIni, 'fill').providers),
    providersDir: dirs.providers,
    providersConfigDir: dirs.providersConfig,
    logger,
  });

  // 2. Start Playwright MCP and connect to it.
  const tmpDir = await tmpDirInTool();
  if (!tmpDir) logger.info('tmp_dir_fallback', { reason: 'no Unix sockets in the tool folder; the OS temp folder stays' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [UPSTREAM_CLI, ...args],
    env: upstreamEnv(args, env, cwd, tmpDir),
    cwd,
    stderr: 'pipe',
  });
  readline.createInterface({ input: transport.stderr }).on('line', (line) => logger.info('upstream_stderr', { line }));

  const client = new Client(
    { name: 'playwright-facade', version: VERSION },
    { capabilities: { roots: { listChanged: true } } },
  );

  // Playwright MCP asks for the roots to find the workspace. Ask the downstream client.
  client.setRequestHandler(ListRootsRequestSchema, async (request, extra) => {
    await downstreamReady;
    if (!server.getClientCapabilities()?.roots) return { roots: [] };
    const result = await server.listRoots(request.params, { signal: extra.signal });
    logger.debug('roots', { roots: result.roots });
    return result;
  });
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    logger.info('tools_changed');
    await downstreamReady;
    await server.sendToolListChanged();
  });
  client.fallbackNotificationHandler = async (notification) => logger.debug('upstream_notification', { notification });

  logger.info('upstream_start', { args });
  await client.connect(transport);
  const upstreamInfo = client.getServerVersion();
  const upstreamCapabilities = client.getServerCapabilities() ?? {};
  logger.info('upstream_ready', { pid: transport.pid, server: upstreamInfo, capabilities: upstreamCapabilities });

  // Each tool of the facade has a line in config/tools.ini. Add the missing ones.
  toolsConfig.addMissing([...(await allTools(client)).map((tool) => tool.name), ...FACADE_TOOLS.map((tool) => tool.name)]);

  // 3. Make the server for the downstream client. It has the tools capability of upstream.
  server = new Server(
    { name: 'playwright-facade', version: VERSION },
    {
      capabilities: { tools: upstreamCapabilities.tools ?? {} },
      instructions: [client.getInstructions(), INSTRUCTIONS].filter(Boolean).join('\n\n'),
    },
  );
  server.oninitialized = () => {
    logger.info('client_ready', { client: server.getClientVersion(), capabilities: server.getClientCapabilities() });
    markDownstreamReady();
  };
  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    await client.sendRootsListChanged();
  });

  const session = { client, server, logger, toolsConfig, hostPolicy, fill, browserOpen: false, pageUrl: undefined };
  server.setRequestHandler(ListToolsRequestSchema, async (request) => listTools(session, request));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => callTool(session, request, extra));

  // 4. Close the two sides together.
  let closed = false;
  async function close(reason) {
    if (closed) return;
    closed = true;
    logger.info('shutdown', { reason });
    // Without browser_close, Chromium does not save a persistent profile (cookies, localStorage).
    // Upstream does not do this when its client goes away.
    if (session.browserOpen && reason !== 'upstream closed') {
      await client.callTool({ name: 'browser_close', arguments: {} }, undefined, { timeout: CLOSE_TIMEOUT })
        .catch((error) => logger.error('browser_close_failed', { message: error.message }));
    }
    await Promise.allSettled([client.close(), server.close(), fill.dispose()]);
    onClose?.(reason);
  }
  client.onclose = () => close('upstream closed');
  client.onerror = (error) => logger.error('upstream_error', { message: error.message });
  server.onclose = () => close('client closed');
  server.onerror = (error) => logger.error('client_error', { message: error.message });

  await server.connect(serverTransport);
  return { server, client, close };
}

async function allTools(client) {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function listTools({ client, logger, toolsConfig }, request) {
  const result = await client.listTools(request.params);
  const tools = result.tools.map((tool) => {
    const described = toolsConfig.describe(tool);
    return FILL_TOOLS.has(tool.name) ? { ...described, description: `${described.description}${PLACEHOLDER_NOTE}` } : described;
  });
  // The facade tools come after the last page of upstream.
  if (!result.nextCursor) tools.push(...FACADE_TOOLS.map((tool) => toolsConfig.describe(tool)));
  logger.info('list_tools', { count: tools.length });
  logger.debug('list_tools_names', { tools: tools.map((tool) => tool.name) });
  return { ...result, tools };
}

function errorResult(text) {
  return { isError: true, content: [{ type: 'text', text: `### Error\n${text}` }] };
}

// The URL that a call opens, if the arguments give it.
function targetUrl(name, args) {
  if (name === 'browser_navigate') return args?.url;
  if (name === 'browser_tabs' && args?.action === 'new') return args.url;
  return undefined;
}

// The URL of the current page, from the "- Page URL:" line of a Playwright result.
function pageUrlOf(result) {
  const text = result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '';
  const matches = [...text.matchAll(/^- Page URL: (\S+)/gm)];
  return matches.length ? matches[matches.length - 1][1] : undefined;
}

function fillContext(session) {
  const { server } = session;
  const elicitation = server.getClientCapabilities()?.elicitation;
  const canAsk = elicitation && (elicitation.form || Object.keys(elicitation).length === 0);
  return {
    host: hostOfUrl(session.pageUrl ?? ''),
    url: session.pageUrl,
    elicit: canAsk
      ? (message, requestedSchema) => server.elicitInput({ message, requestedSchema }, { timeout: ASK_TIMEOUT })
      : undefined,
  };
}

// The steps of one call. Each step can stop the call with an error result.
async function runSteps(session, request, extra) {
  const { client, logger, toolsConfig, hostPolicy, fill } = session;
  const { name, arguments: args } = request.params;

  if (!toolsConfig.isEnabled(name)) return toolsConfig.disabledResult(name);

  if (name === 'fill_values_list') {
    const lines = await fill.list(fillContext(session));
    const where = fillContext(session).host ?? 'the current page (no host)';
    return { content: [{ type: 'text', text: lines.length ? `Placeholders for ${where}:\n${lines.join('\n')}` : `No placeholders for ${where}.` }] };
  }

  const target = targetUrl(name, args);
  if (target) {
    const check = await hostPolicy.check(target, { tool: name });
    if (!check.allowed) return errorResult(`The facade did not open ${target}: ${check.reason}.`);
  }

  let forwardArgs = args;
  if (fill.handles(name)) {
    try {
      forwardArgs = await fill.fill(name, args, fillContext(session));
    } catch (error) {
      if (!(error instanceof FillError)) throw error;
      return errorResult(`The facade did not run ${name}: ${error.message}`);
    }
  }

  const progressToken = request.params._meta?.progressToken;
  const raw = await client.callTool({ ...request.params, arguments: forwardArgs }, undefined, {
    signal: extra.signal,
    timeout: TOOL_TIMEOUT,
    resetTimeoutOnProgress: true,
    onprogress: progressToken === undefined ? undefined : (progress) => extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, ...progress },
    }),
  });
  session.browserOpen = name !== 'browser_close';
  const result = fill.scrub(raw);

  // A click, a redirect or a script can open a page of a blocked host. Close it.
  const opened = pageUrlOf(result);
  if (opened) {
    session.pageUrl = opened;
    const check = await hostPolicy.check(opened, { tool: name });
    if (!check.allowed) {
      await client.callTool({ name: 'browser_navigate', arguments: { url: 'about:blank' } }, undefined, { timeout: TOOL_TIMEOUT });
      session.pageUrl = 'about:blank';
      logger.info('host_blocked', { tool: name, url: opened, reason: check.reason });
      return errorResult(`The facade closed the page ${opened}: ${check.reason}. The browser shows about:blank.`);
    }
    await hostPolicy.opened(opened, { tool: name });
  }
  return result;
}

async function callTool(session, request, extra) {
  const { logger } = session;
  const { name, arguments: toolArgs } = request.params;
  const id = extra.requestId;
  const start = Date.now();
  logger.info('tool_call', { id, tool: name, args: logger.args(toolArgs) });

  try {
    const result = await runSteps(session, request, extra);
    logger.info('tool_result', { id, tool: name, ms: Date.now() - start, ...summarizeResult(result) });
    if (logger.isDebug) {
      const text = result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '';
      logger.debug('tool_result_text', { id, tool: name, text: text.slice(0, DEBUG_TEXT_MAX), truncated: text.length > DEBUG_TEXT_MAX });
    }
    return result;
  } catch (error) {
    logger.error('tool_error', { id, tool: name, ms: Date.now() - start, message: error.message, code: error.code });
    throw error;
  }
}
