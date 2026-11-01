// The facade: an MCP server that forwards each tool request to Playwright MCP.
//
//   MCP client (Claude Code) <-> facade server | facade client <-> Playwright MCP (child process)
//
// Each tool call goes through these steps (see callTool()):
//   tool switch (playwright-tools.ini) → host check (host-policy.ini); both in the config folder
//   → Playwright MCP → host check of the opened page → discovery (optional)
//   → form fill and submit (fields.ini, providers-form-fill/; see autofill.js)
//   → scrub of masked values → log
// The client does not see that the server is a facade: texts for the client do not name the
// facade, Playwright or the form fill.
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
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { FieldsConfig } from '../../src/fill/fields.js';
import { FillRegistry } from '../../src/fill/registry.js';
import { FileAllowProvider } from '../../src/hosts/file-allow-provider.js';
import { HostPolicy } from '../../src/hosts/host-policy.js';
import { HostsFile } from '../../src/hosts/hosts-file.js';
import { hostOfUrl } from '../../src/hosts/patterns.js';
import { listValue, readIni, sectionValues } from '../../src/ini.js';
import { summarizeResult } from '../../src/logger.js';
import { PROVIDERS_DIR, VERSION, configFile } from '../../src/paths.js';
import { ToolsConfig } from '../../src/tools-config.js';
import { autofill, discover } from './autofill.js';
import { CHROMIUM_BROWSERS, writeChromePrefs } from './chrome-prefs.js';
import { DEFAULT_BROWSER, TMP_DIR, TOOLS_CONFIG, TOOLS_TEMPLATE, UPSTREAM_CLI, argValue, connectsToBrowser, renderMode, tmpDirForChromium, upstreamEnv, withoutHeadless } from './config.js';
import { cleanStaleXvfb, startXvfb } from './xvfb.js';

// Maximum time of one tool call without progress. Playwright has its own, shorter timeouts.
const TOOL_TIMEOUT = 10 * 60 * 1000;

// Maximum time of browser_close at shutdown.
const CLOSE_TIMEOUT = 5000;

// Maximum time that the user has to answer a dialog of the ask provider.
const ASK_TIMEOUT = 5 * 60 * 1000;

// Maximum text in a debug log entry of a tool result.
const DEBUG_TEXT_MAX = 20000;

// The scrub also takes output files that changed this much before the call: file times are not exact.
const MTIME_SLACK = 2000;

// The name of the server for the client.
export const SERVER_NAME = 'browser-automation-x-mcp';

const INSTRUCTIONS = 'Use the tools of this server for each browser automation task when they are available. This is mandatory.';

// Tools of Playwright MCP that a web page can misuse through prompt injection. Disabled by default.
export const DANGEROUS_TOOLS = {
  browser_run_code_unsafe: 'it runs any JavaScript in the server process on this computer, with access to files, programs and the network',
  browser_evaluate: 'it runs JavaScript in the web page and can read all data of the page',
  browser_file_upload: 'it sends files from this computer to a website',
  browser_drop: 'it drops files from this computer onto a web page',
};

// The "Ran Playwright code" section of an upstream result: the code that upstream ran.
const CODE_SECTION = /### Ran Playwright code\n```[a-z]*\n[\s\S]*?\n```\n?/g;

// configDir: the config folder (--config-dir). See src/paths.js.
export async function startFacade({ args: givenArgs, configDir, logger, serverTransport, cwd = process.cwd(), env = process.env, onClose }) {
  let markDownstreamReady;
  const downstreamReady = new Promise((resolve) => { markDownstreamReady = resolve; });
  let server;

  // 1. Load the config of the facade.
  logger.info('config_dir', { dir: configDir });
  const facadeIni = readIni(configFile(configDir, 'facade.ini'));
  const toolsConfig = new ToolsConfig(configFile(configDir, TOOLS_CONFIG, TOOLS_TEMPLATE), logger, DANGEROUS_TOOLS);
  const hostsFile = new HostsFile(configFile(configDir, 'host-policy.ini'));
  const record = sectionValues(facadeIni, 'hosts').record !== 'false';
  const hostPolicy = new HostPolicy({ hostsFile, allowProvider: new FileAllowProvider({ hostsFile, record, logger }) });
  const fill = await FillRegistry.load({
    names: listValue(sectionValues(facadeIni, 'fill').providers),
    providersDir: PROVIDERS_DIR,
    configDir,
    logger,
    mask: sectionValues(facadeIni, 'mask'),
  });
  const fields = new FieldsConfig(configFile(configDir, 'fields.ini'));
  const discovery = env.BROWSER_AUTOMATION_X_MCP_DISCOVER === '1';
  if (discovery) logger.info('discovery_mode', {});

  // 2. Select the render mode. RENDER_MODE replaces --headless and PLAYWRIGHT_MCP_HEADLESS:
  //    the facade ignores them, without an error.
  const args = withoutHeadless(givenArgs);
  if (args.length !== givenArgs.length) logger.info('ignored', { control: '--headless', reason: 'RENDER_MODE selects the render mode' });
  if (env.PLAYWRIGHT_MCP_HEADLESS !== undefined) logger.info('ignored', { control: 'PLAYWRIGHT_MCP_HEADLESS', reason: 'RENDER_MODE selects the render mode' });
  const mode = connectsToBrowser(args) ? undefined : renderMode(env);
  cleanStaleXvfb(logger);

  // 3. Start Playwright MCP and connect to it.
  const tmpDir = await tmpDirForChromium();
  if (tmpDir !== TMP_DIR) logger.info('tmp_dir_fallback', { dir: tmpDir ?? 'the temp folder of the OS', reason: 'the tool folder cannot hold the socket of Chromium' });
  const childEnv = upstreamEnv(args, env, cwd, tmpDir);
  delete childEnv.PLAYWRIGHT_MCP_HEADLESS;
  if (mode) childEnv.PLAYWRIGHT_MCP_HEADLESS = mode === 'HEADLESS' ? 'true' : 'false';
  const xvfb = mode === 'HEADED_INVISIBLE' ? await startXvfb({ logger }) : undefined;
  if (xvfb) {
    childEnv.DISPLAY = xvfb.display;
    delete childEnv.WAYLAND_DISPLAY;
  }
  logger.info('render_mode', { mode: mode ?? 'none: upstream connects to a running browser', display: childEnv.DISPLAY });
  const outputDir = argValue(args, '--output-dir') ?? childEnv.PLAYWRIGHT_MCP_OUTPUT_DIR;
  // The persistent profile of a Chromium browser gets CHROME_PREFS. An isolated profile has no folder.
  const browser = argValue(args, '--browser') ?? childEnv.PLAYWRIGHT_MCP_BROWSER ?? DEFAULT_BROWSER;
  const userDataDir = argValue(args, '--user-data-dir') ?? childEnv.PLAYWRIGHT_MCP_USER_DATA_DIR;
  const profileDir = userDataDir && CHROMIUM_BROWSERS.has(browser) ? path.resolve(cwd, userDataDir) : undefined;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [UPSTREAM_CLI, ...args],
    env: childEnv,
    cwd,
    stderr: 'pipe',
  });
  readline.createInterface({ input: transport.stderr }).on('line', (line) => logger.info('upstream_stderr', { line }));

  const client = new Client(
    { name: SERVER_NAME, version: VERSION },
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
  try {
    await client.connect(transport);
  } catch (error) {
    xvfb?.stop();
    throw error;
  }
  const upstreamInfo = client.getServerVersion();
  const upstreamCapabilities = client.getServerCapabilities() ?? {};
  logger.info('upstream_ready', { pid: transport.pid, server: upstreamInfo, capabilities: upstreamCapabilities });

  // Each tool of the facade has a line in playwright-tools.ini. Add the missing ones.
  toolsConfig.addMissing((await allTools(client)).map((tool) => tool.name));

  // 4. Make the server for the downstream client. It has the tools capability of upstream.
  server = new Server(
    { name: SERVER_NAME, version: VERSION },
    {
      capabilities: { tools: upstreamCapabilities.tools ?? {} },
      instructions: [client.getInstructions() && neutral(client.getInstructions()), INSTRUCTIONS].filter(Boolean).join('\n\n'),
    },
  );
  server.oninitialized = () => {
    logger.info('client_ready', { client: server.getClientVersion(), capabilities: server.getClientCapabilities() });
    markDownstreamReady();
  };
  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    await client.sendRootsListChanged();
  });

  const session = {
    client, server, logger, toolsConfig, hostPolicy, fill, fields, discovery, cwd,
    outputDir: outputDir && path.resolve(cwd, outputDir), profileDir, browserOpen: false, pageUrl: undefined,
    fillState: { attempts: new Set(), failed: new Set(), waitedUrl: undefined },
  };
  server.setRequestHandler(ListToolsRequestSchema, async (request) => listTools(session, request));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => callTool(session, request, extra));

  // 5. Close the two sides together.
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
    xvfb?.stop();
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
  const tools = result.tools.map((tool) => toolsConfig.describe(JSON.parse(neutral(JSON.stringify(tool)))));
  logger.info('list_tools', { count: tools.length });
  logger.debug('list_tools_names', { tools: tools.map((tool) => tool.name) });
  return { ...result, tools };
}

// A text of upstream for the client, without the name Playwright.
export function neutral(text) {
  return text
    .replace(/Playwright MCP/g, 'this server')
    .replace(/Playwright (code|server)/g, '$1')
    .replace(/(a|A) Playwright /g, '$1 ')
    .replace(/Playwright /g, '');
}

// A result of upstream for the client: without the "Ran Playwright code" sections.
export function forClient(result) {
  const content = result.content?.map((part) => (part.type === 'text' ? { ...part, text: part.text.replace(CODE_SECTION, '') } : part));
  return { ...result, content };
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
// The files of a call: each file link in the result, and each file of the output folder that
// changed since the call started. Upstream writes snapshots and console logs there.
function writtenFiles(session, result, since) {
  if (!session.fill.secrets.size) return [];
  const files = new Set();
  for (const part of result.content ?? []) {
    if (part.type !== 'text') continue;
    for (const [, link] of part.text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const file = path.resolve(session.cwd, link.replace(/#.*$/, ''));
      if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) files.add(file);
    }
  }
  if (session.outputDir && fs.existsSync(session.outputDir)) {
    for (const entry of fs.readdirSync(session.outputDir, { recursive: true, withFileTypes: true })) {
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isFile() && fs.statSync(file).mtimeMs >= since - MTIME_SLACK) files.add(file);
    }
  }
  return [...files];
}

function pageUrlOf(result) {
  const text = result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '';
  const matches = [...text.matchAll(/^- Page URL: (\S+)/gm)];
  return matches.length ? matches[matches.length - 1][1] : undefined;
}

// The context of a provider for the page url (see src/fill/provider.js).
function fillContext(session, url) {
  const { server } = session;
  const elicitation = server.getClientCapabilities()?.elicitation;
  const canAsk = elicitation && (elicitation.form || Object.keys(elicitation).length === 0);
  return {
    host: hostOfUrl(url ?? ''),
    url,
    elicit: canAsk
      ? (message, requestedSchema) => server.elicitInput({ message, requestedSchema }, { timeout: ASK_TIMEOUT })
      : undefined,
  };
}

// The steps of one call. Each step can stop the call with an error result.
async function runSteps(session, request, extra) {
  const { client, toolsConfig, hostPolicy, fill } = session;
  const { name, arguments: args } = request.params;

  if (!toolsConfig.isEnabled(name)) return toolsConfig.disabledResult(name);

  const target = targetUrl(name, args);
  if (target) {
    const check = await hostPolicy.check(target, { tool: name });
    if (!check.allowed) return blockedResult(session, name, target, check, false);
  }

  // The browser starts with the next call. Its profile gets the settings first.
  if (!session.browserOpen && session.profileDir) {
    const file = writeChromePrefs(session.profileDir);
    session.logger.info('chrome_prefs', { file });
  }

  const progressToken = request.params._meta?.progressToken;
  const started = Date.now();
  let raw = await client.callTool(request.params, undefined, {
    signal: extra.signal,
    timeout: TOOL_TIMEOUT,
    resetTimeoutOnProgress: true,
    onprogress: progressToken === undefined ? undefined : (progress) => extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, ...progress },
    }),
  });
  session.browserOpen = name !== 'browser_close';

  // A click, a redirect or a script can open a page of a blocked host. Close it.
  // After a submit of the form fill, the new page gets the same steps.
  let opened = pageUrlOf(raw);
  for (let step = 0; opened; step++) {
    session.pageUrl = opened;
    const check = await hostPolicy.check(opened, { tool: name });
    if (!check.allowed) return blockedResult(session, name, opened, check, true);
    await hostPolicy.opened(opened, { tool: name });
    if (step > 0) break;
    if (session.discovery) await discover(session, opened);
    const filled = await autofill(session, opened, (url) => fillContext(session, url));
    if (!filled) break;
    raw = filled;
    opened = pageUrlOf(raw);
  }
  fill.scrubFiles(writtenFiles(session, raw, started));
  return forClient(fill.scrub(raw));
}

// The error result for a blocked host. closePage: the browser shows the page; replace it with about:blank.
async function blockedResult(session, tool, url, check, closePage) {
  const { client, logger } = session;
  logger.info('host_blocked', { tool, url, reason: check.reason });
  if (!closePage) return errorResult(`Navigation blocked: ${url} is not allowed. ${capitalize(check.reason)}.`);
  await client.callTool({ name: 'browser_navigate', arguments: { url: 'about:blank' } }, undefined, { timeout: TOOL_TIMEOUT });
  session.pageUrl = 'about:blank';
  return errorResult(`Navigation blocked: ${url} is not allowed. ${capitalize(check.reason)}. The browser shows about:blank.`);
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
