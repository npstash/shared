// The MCP server. It forwards each tool request to Playwright MCP, in the lane of the call.
//
//   MCP client (Claude Code) <-> server | lane client <-> Playwright MCP (in this process) -> context
//
// A lane is one browser context for one agent (see lanes.js). Each tool, except the lane tools,
// needs the parameter lane.
// Each tool call goes through these steps (see callTool()):
//   tool switch (tools.ini) → lane → file name check → host check (host-policy.ini); both in the
//   config folder → Playwright MCP → host check of the opened page → recorder and discovery
//   (optional; discover.js) → form fill and submit (fields.ini, providers-form-fill/; see
//   autofill.js), with a host check of each page after a submit
//   → scrub of masked values and of secret headers → log
// Texts for the client do not name upstream, Playwright or the form fill.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConnection } from '@playwright/mcp';
import fs from 'node:fs';
import path from 'node:path';
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
import { autofill } from './autofill.js';
import { DISCOVER_WAIT, discover, syncRecorder } from './discover.js';
import { TMP_DIR, TOOLS_CONFIG, TOOLS_TEMPLATE, ignoredVariables, outputDir, renderMode, stateFile } from './config.js';
import { Lanes } from './lanes.js';
import { cleanStaleXvfb } from './xvfb.js';

// Maximum time of one tool call without progress. Playwright has its own, shorter timeouts.
const TOOL_TIMEOUT = 10 * 60 * 1000;

// Maximum time that the user has to answer a dialog of the ask provider.
const ASK_TIMEOUT = 5 * 60 * 1000;

// Maximum text in a debug log entry of a tool result.
const DEBUG_TEXT_MAX = 20000;

// The scrub also takes output files that changed this much before the call: file times are not exact.
const MTIME_SLACK = 2000;

// The name of the server for the client.
export const SERVER_NAME = 'browser-automation-x-mcp';

const INSTRUCTIONS = [
  'Use the tools of this server for each browser automation task when they are available. This is mandatory.',
  'First call browser_lane_open. It gives a lane ID: an own browser with its own tabs. Give this ID as the parameter lane in each other call.',
  'Each agent that works in parallel (also a subagent) opens its own lane. Do not share a lane between agents.',
  'If browser_lane_open is busy, call browser_lanes later, then try again. Call browser_lane_close at the end of the task.',
].join(' ');

// Tools of Playwright MCP that a web page can misuse through prompt injection. Disabled by default.
export const DANGEROUS_TOOLS = {
  browser_run_code_unsafe: 'it runs any JavaScript in the server process on this computer, with access to files, programs and the network',
  browser_evaluate: 'it runs JavaScript in the web page and can read all data of the page',
  browser_file_upload: 'it sends files from this computer to a website',
  browser_drop: 'it drops files from this computer onto a web page',
};

const LANE_PARAM = { type: 'string', description: 'The lane ID from browser_lane_open, e.g. lane-3f9a.' };

// The tools of the server itself.
export const LANE_TOOLS = [
  {
    name: 'browser_lane_open',
    title: 'Open a lane',
    description: 'Open a lane: an own browser with its own tabs, for one agent. Give its ID as the parameter lane in each other call. The lane has the logins of the earlier lanes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_lane_close',
    title: 'Close a lane',
    description: 'Close a lane and its tabs. The logins of the lane stay for the next lanes.',
    inputSchema: { type: 'object', properties: { lane: LANE_PARAM }, required: ['lane'] },
  },
  {
    name: 'browser_lanes',
    title: 'List the lanes',
    description: 'Give the open lanes and the maximum. If browser_lane_open is busy, call this tool later, then try again.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// Header lines that hold secrets: the value becomes *** in results and output files.
const SECRET_HEADER = /^(\s*[-*]?\s*(?:cookie|set-cookie|authorization|proxy-authorization)\s*:\s*)(\S.*)$/gim;
const MASK = '***';

// The "Ran Playwright code" section of an upstream result: the code that upstream ran.
const CODE_SECTION = /### Ran Playwright code\n```[a-z]*\n[\s\S]*?\n```\n?/g;

// configDir: the config folder (--config-dir). See src/paths.js.
// laneOptions: limits of the lanes for the tests (see lanes.js).
export async function startServer({ configDir, logger, serverTransport, cwd = process.cwd(), env = process.env, tmpDir, onClose, laneOptions = {} }) {
  let markDownstreamReady;
  const downstreamReady = new Promise((resolve) => { markDownstreamReady = resolve; });
  let server;

  // 1. Load the config of the server.
  logger.info('config_dir', { dir: configDir });
  const serverIni = readIni(configFile(configDir, 'server.ini'));
  const toolsConfig = new ToolsConfig(configFile(configDir, TOOLS_CONFIG, TOOLS_TEMPLATE), logger, DANGEROUS_TOOLS);
  const hostsFile = new HostsFile(configFile(configDir, 'host-policy.ini'));
  const record = sectionValues(serverIni, 'hosts').record !== 'false';
  const hostPolicy = new HostPolicy({ hostsFile, allowProvider: new FileAllowProvider({ hostsFile, record, logger }) });
  const fill = await FillRegistry.load({
    names: listValue(sectionValues(serverIni, 'fill').providers),
    providersDir: PROVIDERS_DIR,
    configDir,
    logger,
    mask: sectionValues(serverIni, 'mask'),
  });
  const fields = new FieldsConfig(configFile(configDir, 'fields.ini'));
  const discovery = env.BROWSER_AUTOMATION_X_MCP_DISCOVER === '1';
  if (discovery) logger.info('discovery_mode', {});

  // 2. Select the render mode. The server does not use the variables of Playwright MCP.
  for (const name of ignoredVariables(env)) logger.info('ignored', { control: name, reason: 'the server does not use this variable' });
  const mode = renderMode(env);
  cleanStaleXvfb(logger);
  if (tmpDir !== TMP_DIR) logger.info('tmp_dir_fallback', { dir: tmpDir ?? 'the temp folder of the OS', reason: 'the tool folder cannot hold the socket of Chromium' });
  logger.info('render_mode', { mode, display: mode === 'HEADED_INVISIBLE' ? 'Xvfb' : env.DISPLAY });

  // 3. The lanes, and a connection to Playwright MCP that only gives the tool list.
  const output = outputDir(cwd);
  const roots = async (request, extra) => {
    await downstreamReady;
    if (!server.getClientCapabilities()?.roots) return { roots: [] };
    const result = await server.listRoots(request.params, { signal: extra.signal });
    logger.debug('roots', { roots: result.roots });
    return result;
  };
  const lanes = new Lanes({
    mode,
    logger,
    outputDir: output,
    stateFile: stateFile(env, cwd),
    indexedDbHosts: listValue(sectionValues(serverIni, 'storage').indexeddb),
    roots,
    beforeClose: async (lane) => {
      if (discovery && lane.session) await syncRecorder(lane.session).catch(() => {});
    },
    ...laneOptions,
  });
  const catalog = await catalogClient(output);
  const upstreamTools = await allTools(catalog);
  toolsConfig.addMissing([...upstreamTools.map((tool) => tool.name), ...LANE_TOOLS.map((tool) => tool.name)]);
  logger.info('upstream_ready', { tools: upstreamTools.length, version: catalog.getServerVersion()?.version });

  // 4. Make the server for the downstream client.
  server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  // The log files open in the folder of the client name. A client can send its first notification
  // before the server has the name: then the first request opens them.
  const openLog = () => {
    const name = server.getClientVersion()?.name;
    if (!logger.files && name) logger.open(name);
  };
  server.oninitialized = () => {
    openLog();
    logger.info('client_ready', { client: server.getClientVersion(), capabilities: server.getClientCapabilities() });
    markDownstreamReady();
  };

  const session = {
    server, logger, toolsConfig, hostPolicy, fill, fields, discovery, cwd, lanes,
    outputDir: output, upstreamTools,
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    openLog();
    return listTools(session);
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    openLog();
    return callTool(session, request, extra);
  });

  // 5. Close the lanes and the browser with the server.
  let closed = false;
  async function close(reason) {
    if (closed) return;
    closed = true;
    logger.open();
    logger.info('shutdown', { reason });
    await lanes.closeAll(reason);
    await Promise.allSettled([catalog.close(), server.close(), fill.dispose()]);
    onClose?.(reason);
  }
  server.onclose = () => close('client closed');
  server.onerror = (error) => logger.error('client_error', { message: error.message });

  await server.connect(serverTransport);
  return { server, close, lanes };
}

// A connection to Playwright MCP without a browser: it gives only the tool list.
async function catalogClient(output) {
  const upstream = await createConnection({ browser: { browserName: 'chromium', isolated: false }, outputDir: output }, async () => {
    throw new Error('open a lane first');
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await upstream.connect(serverTransport);
  const client = new Client({ name: SERVER_NAME, version: VERSION }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
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

// The tools for the client: the lane tools, and each upstream tool with the parameter lane.
function listTools({ logger, toolsConfig, upstreamTools }) {
  const withLane = upstreamTools.map((tool) => {
    const schema = tool.inputSchema ?? { type: 'object' };
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: { ...(schema.properties ?? {}), lane: LANE_PARAM },
        required: [...new Set([...(schema.required ?? []), 'lane'])],
      },
    };
  });
  const tools = [...LANE_TOOLS, ...withLane].map((tool) => toolsConfig.describe(JSON.parse(neutral(JSON.stringify(tool)))));
  logger.info('list_tools', { count: tools.length });
  logger.debug('list_tools_names', { tools: tools.map((tool) => tool.name) });
  return { tools };
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

function textResult(text) {
  return { content: [{ type: 'text', text: `### Result\n${text}` }] };
}

// Replace the values of secret headers with MASK.
export function maskHeaders(text) {
  return text.replace(SECRET_HEADER, `$1${MASK}`);
}

function maskResult(result) {
  const content = result.content?.map((part) => (part.type === 'text' ? { ...part, text: maskHeaders(part.text) } : part));
  return { ...result, content };
}

// The same for the text files of a call. Binary files stay.
function maskFiles(files, logger) {
  for (const file of files) {
    let text;
    try {
      const data = fs.readFileSync(file);
      if (data.includes(0)) continue;
      text = data.toString('utf8');
    } catch {
      continue;
    }
    const masked = maskHeaders(text);
    if (masked === text) continue;
    fs.writeFileSync(file, masked);
    logger.info('mask_file', { file });
  }
}

// A file name of the agent must be in the output folder. A relative name is relative to it.
// Give the absolute path, or undefined if the file is outside.
export function fileInOutput(outputDir, name) {
  const file = path.resolve(outputDir, name);
  const relative = path.relative(outputDir, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return file;
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
  const { client, hostPolicy, fill, logger } = session;
  const { name } = request.params;
  let args = request.params.arguments;

  if (typeof args?.filename === 'string') {
    const file = fileInOutput(session.outputDir, args.filename);
    if (!file) return errorResult(`The file name ${args.filename} is not allowed. Give a file name in the output folder, e.g. a name without a folder.`);
    args = { ...args, filename: file };
  }

  const target = targetUrl(name, args);
  if (target) {
    const check = await hostPolicy.check(target, { tool: name });
    if (!check.allowed) return blockedResult(session, name, target, check, false);
  }

  const progressToken = request.params._meta?.progressToken;
  const started = Date.now();
  session.agentCalls.push({ start: started });
  if (session.agentCalls.length > 20) session.agentCalls.shift();
  let raw = await client.callTool({ ...request.params, arguments: args }, undefined, {
    signal: extra.signal,
    timeout: TOOL_TIMEOUT,
    resetTimeoutOnProgress: true,
    onprogress: progressToken === undefined ? undefined : (progress) => extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, ...progress },
    }),
  });

  // The recorder: the fills and submits in the browser since the last call (discovery mode).
  const call = session.agentCalls.at(-1);
  if (call) call.end = Date.now();
  const userSubmitted = session.discovery ? await syncRecorder(session) : false;

  // A click, a redirect or a script can open a page of a blocked host. Close it.
  // Each page after a submit of the form fill gets the same check (see autofill.js).
  const checkPage = async (url) => {
    session.pageUrl = url;
    const check = await hostPolicy.check(url, { tool: name });
    if (check.allowed) await hostPolicy.opened(url, { tool: name });
    return check;
  };
  const opened = pageUrlOf(raw);
  if (opened) {
    const previous = session.pageUrl;
    const check = await checkPage(opened);
    if (!check.allowed) return blockedResult(session, name, opened, check, true);
    if (opened !== previous) logger.info('page_opened', { url: opened, via: userSubmitted ? 'user_submit' : 'tool' });
    if (session.discovery) await discover(session, opened, { wait: userSubmitted ? DISCOVER_WAIT : 0 });
    const outcome = await autofill(session, opened, (url) => fillContext(session, url), checkPage);
    if (outcome.blocked) return blockedResult(session, name, outcome.blocked.url, outcome.blocked.check, true);
    if (outcome.submitted) {
      raw = await client.callTool({ name: 'browser_snapshot', arguments: {} }, undefined, { timeout: TOOL_TIMEOUT });
      const last = pageUrlOf(raw);
      if (last && last !== session.pageUrl) {
        const lastCheck = await checkPage(last);
        if (!lastCheck.allowed) return blockedResult(session, name, last, lastCheck, true);
      }
    }
  }
  const files = writtenFiles(session, raw, started);
  fill.scrubFiles(files);
  maskFiles(files, logger);
  return forClient(maskResult(fill.scrub(raw)));
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

// The calls of the lane tools.
async function laneTool(session, name, args) {
  const { lanes } = session;
  if (name === 'browser_lanes') return textResult(lanes.status());
  if (name === 'browser_lane_open') {
    const lane = await lanes.open();
    if (!lane) return errorResult(`Busy: ${lanes.size} of ${lanes.maxLanes} lanes are open. Call browser_lanes later, then try again.`);
    lane.session = laneSession(session, lane);
    return textResult(`Lane: ${lane.id}\nGive lane="${lane.id}" in each other call. Close the lane with browser_lane_close at the end.`);
  }
  // browser_lane_close, and browser_close of a lane.
  if (!await lanes.close(args?.lane, 'tool')) return unknownLane(args?.lane);
  return textResult(`The lane ${args.lane} is closed.`);
}

function unknownLane(id) {
  if (!id) return errorResult('Give the parameter lane: the ID from browser_lane_open. Call browser_lane_open first.');
  return errorResult(`The lane ${id} is not open. Call browser_lane_open, and use the new ID.`);
}

// The state of one lane for the call steps, the form fill and the discovery.
function laneSession(session, lane) {
  return Object.assign(Object.create(session), {
    lane: lane.id,
    client: lane.client,
    pageUrl: undefined,
    fillState: { attempts: new Set(), failed: new Set(), waitedUrl: undefined },
    // The time of the recent agent calls: the recorder gives their events to the agent.
    agentCalls: [],
  });
}

// One call in a lane.
async function laneCall(session, request, extra) {
  const { lanes, toolsConfig } = session;
  const { name, arguments: given } = request.params;
  if (!toolsConfig.isEnabled(name)) return toolsConfig.disabledResult(name);
  if (LANE_TOOLS.some((tool) => tool.name === name)) return laneTool(session, name, given);
  const lane = lanes.get(given?.lane);
  if (!lane) return unknownLane(given?.lane);
  if (name === 'browser_close') return laneTool(session, 'browser_lane_close', given);
  if (name === 'browser_tabs' && given?.action === 'new' && lanes.tabCount(lane) >= lanes.maxTabs) {
    return errorResult(`The lane ${lane.id} has the maximum of ${lanes.maxTabs} tabs. Close a tab first.`);
  }
  const { lane: _, ...args } = given;
  lane.busy++;
  lane.lastUsed = Date.now();
  try {
    const result = await runSteps(lane.session, { ...request, params: { ...request.params, arguments: args } }, extra);
    const notes = lane.notes.splice(0);
    if (!notes.length) return result;
    return { ...result, content: [...(result.content ?? []), { type: 'text', text: `### Note\n${notes.join('\n')}` }] };
  } finally {
    lane.busy--;
    lane.lastUsed = Date.now();
  }
}

async function callTool(session, request, extra) {
  const { logger } = session;
  const { name, arguments: toolArgs } = request.params;
  const id = extra.requestId;
  const start = Date.now();
  logger.info('tool_call', { id, tool: name, args: logger.args(toolArgs) });

  try {
    const result = await laneCall(session, request, extra);
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
