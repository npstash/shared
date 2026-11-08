// The MCP server. It forwards each tool request to Playwright MCP, in the lane of the call.
//
//   MCP client (Claude Code) <-> server | lane client <-> Playwright MCP (in this process) -> context
//
// A lane is one browser context for one agent (see lanes.ts). Each tool, except the lane tools,
// needs the parameter lane.
// Each tool call goes through these steps (see CallPipeline):
//   tool switch (server.json) → lane → file name check → host check (sites.json) → Playwright MCP
//   → host check of the opened page → login link and form fill (sites.json, providers-form-fill/;
//   see autofill.ts), with a host check of each page after a submit
//   → scrub of masked values and of secret headers → log
// In the discovery mode, discover.ts writes the hosts, and the fields and buttons that the user
// used, into sites.json, without a call (see Discovery).
// Texts for the client do not name upstream, Playwright or the form fill.
// startServer() is the composition root: it makes the objects of the server.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolRequest, CallToolResult, ElicitResult, ListRootsRequest, Progress, ListRootsResult, ListToolsResult, ServerNotification, ServerRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConnection } from '@playwright/mcp';
import fs from 'node:fs';
import path from 'node:path';
import type { ElicitSchema, FillContext } from '../../src/fill/provider.ts';
import type { FillValues } from '../../src/fill/registry.ts';
import { FillRegistry } from '../../src/fill/registry.ts';
import type { HostCheck, HostPolicy } from '../../src/hosts/host-policy.ts';
import { SiteAccessPolicy } from '../../src/hosts/host-policy.ts';
import { hostOfUrl } from '../../src/hosts/patterns.ts';
import { errorCode, errorMessage } from '../../src/json.ts';
import type { Logger } from '../../src/logger.ts';
import { summarizeResult } from '../../src/logger.ts';
import { PROVIDERS_DIR, SERVER_CONFIG, SITES_CONFIG, VERSION, configFile } from '../../src/paths.ts';
import type { ToolSwitches } from '../../src/server-config.ts';
import { ServerConfigFile, ToolsConfig } from '../../src/server-config.ts';
import { Sites } from '../../src/sites.ts';
import type { FormFill } from './autofill.ts';
import { AutoFill } from './autofill.ts';
import type { Env } from './config.ts';
import { TMP_DIR, ignoredVariables, outputDir, renderMode, stateFile } from './config.ts';
import { Discovery } from './discover.ts';
import type { Lane, LaneManager, LanesOptions } from './lanes.ts';
import { BROWSER_SESSIONS, Lanes, cleanStaleLanes, isBrowserSession } from './lanes.ts';
import { UpstreamPageCode } from './run-code.ts';
import { LaneSession } from './session.ts';
import { cleanStaleXvfb } from './xvfb.ts';

// Maximum time of one tool call without progress. Playwright has its own, shorter timeouts.
const TOOL_TIMEOUT: number = 10 * 60 * 1000;

// Maximum time that the user has to answer a dialog of the ask provider.
const ASK_TIMEOUT: number = 5 * 60 * 1000;

// Maximum text in a debug log entry of a tool result.
const DEBUG_TEXT_MAX: number = 20000;

// The scrub also takes output files that changed this much before the call: file times are not exact.
const MTIME_SLACK: number = 2000;

// The name of the server for the client.
export const SERVER_NAME: string = 'browser-automation-x-mcp';

const INSTRUCTIONS: string = [
  'Use the tools of this server for each browser automation task when they are available. This is mandatory.',
  'First call browser_lane_open. It gives a lane ID: an own browser with its own tabs. Give this ID as the parameter lane in each other call.',
  'Each agent that works in parallel (also a subagent) opens its own lane. Do not share a lane between agents.',
  'If browser_lane_open is busy, call browser_lanes later, then try again. Call browser_lane_close at the end of the task.',
  'browser_lane_open needs browserSession: normal (with the saved logins), fresh (without the saved logins; new logins are saved) or isolated (without the saved logins; nothing is saved).',
  'When the user asks for a session of the browser, e.g. "a fresh session", this is the browserSession. Without such a request, use normal.',
  'Tell the user the browser session of each lane that you open.',
].join(' ');

// Tools of Playwright MCP that a web page can misuse through prompt injection. Disabled by default.
export const DANGEROUS_TOOLS: Readonly<Record<string, string>> = {
  browser_run_code_unsafe: 'it runs any JavaScript in the server process on this computer, with access to files, programs and the network',
  browser_evaluate: 'it runs JavaScript in the web page and can read all data of the page',
  browser_file_upload: 'it sends files from this computer to a website',
  browser_drop: 'it drops files from this computer onto a web page',
};

// The text of each browser session for the result of browser_lane_open.
const SESSION_TEXT: Readonly<Record<string, string>> = {
  normal: 'with the saved logins; its logins are saved',
  fresh: 'without the saved logins; its new logins are saved',
  isolated: 'without the saved logins; nothing is saved',
};

const LANE_PARAM = { type: 'string', description: 'The lane ID from browser_lane_open, e.g. lane-3f9a.' } as const;

// The tools of the server itself.
export const LANE_TOOLS: readonly Tool[] = [
  {
    name: 'browser_lane_open',
    title: 'Open a lane',
    description: 'Open a lane: an own browser with its own tabs, for one agent. Give its ID as the parameter lane in each other call. browserSession sets the logins of the lane. Tell the user the browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        browserSession: {
          type: 'string',
          enum: [...BROWSER_SESSIONS],
          description: 'normal: the lane has the saved logins of the earlier lanes, and saves its logins. fresh: the lane starts without saved logins; its new logins are saved for the next lanes. isolated: the lane starts without saved logins and saves nothing. A "session" that the user asks for in the browser is this browser session.',
        },
      },
      required: ['browserSession'],
    },
  },
  {
    name: 'browser_lane_close',
    title: 'Close a lane',
    description: 'Close a lane and its tabs. The logins of a normal or fresh lane stay for the next lanes.',
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
const SECRET_HEADER: RegExp = /^(\s*[-*]?\s*(?:cookie|set-cookie|authorization|proxy-authorization)\s*:\s*)(\S.*)$/gim;
const MASK: string = '***';

// The "Ran Playwright code" section of an upstream result: the code that upstream ran.
const CODE_SECTION: RegExp = /### Ran Playwright code\n```[a-z]*\n[\s\S]*?\n```\n?/g;

type ToolArgs = Record<string, unknown>;
type CallExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface StartOptions {
  // The config folder (--config-dir). See src/paths.ts.
  readonly configDir: string;
  readonly logger: Logger;
  readonly serverTransport: Transport;
  readonly cwd?: string;
  readonly env?: Env;
  readonly tmpDir?: string | undefined;
  readonly onClose?: (reason: string) => void;
  // Limits of the lanes for the tests (see lanes.ts).
  readonly laneOptions?: Partial<LanesOptions>;
}

// The running server.
export interface RunningServer {
  readonly server: Server;
  readonly lanes: LaneManager;
  close(reason: string): Promise<void>;
}

export async function startServer({ configDir, logger, serverTransport, cwd = process.cwd(), env = process.env, tmpDir, onClose, laneOptions = {} }: StartOptions): Promise<RunningServer> {
  let markDownstreamReady: () => void = () => {};
  const downstreamReady = new Promise<void>((resolve) => { markDownstreamReady = resolve; });

  // 1. Load the config of the server: server.json and sites.json.
  logger.info('config_dir', { dir: configDir });
  const serverConfig = new ServerConfigFile(configFile(configDir, SERVER_CONFIG));
  const toolsConfig = new ToolsConfig(serverConfig, logger, DANGEROUS_TOOLS);
  const sites = new Sites(configFile(configDir, SITES_CONFIG));
  sites.load();
  const discoveryMode = env.BROWSER_AUTOMATION_X_MCP_DISCOVER === '1';
  if (discoveryMode) logger.info('discovery_mode', {});
  const hostPolicy = new SiteAccessPolicy({ sites });
  const fill = await FillRegistry.load({ entries: serverConfig.providers(), providersDir: PROVIDERS_DIR, sites, logger });

  // 2. Select the render mode. The server does not use the variables of Playwright MCP.
  for (const name of ignoredVariables(env)) logger.info('ignored', { control: name, reason: 'the server does not use this variable' });
  const mode = renderMode(env);
  cleanStaleXvfb(logger);
  cleanStaleLanes(logger);
  if (tmpDir !== TMP_DIR) logger.info('tmp_dir_fallback', { dir: tmpDir ?? 'the temp folder of the OS', reason: 'the tool folder cannot hold the socket of Chromium' });
  logger.info('render_mode', { mode, display: mode === 'HEADED_INVISIBLE' ? 'Xvfb' : env.DISPLAY });

  // 3. The server for the downstream client.
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const clientName = (): string | undefined => server.getClientVersion()?.name;
  const discovery = discoveryMode ? new Discovery({ sites, fill, logger, clientName }) : undefined;
  const autofill = new AutoFill({ sites, fill, logger, discovery: discoveryMode });

  // 4. The lanes, and a connection to Playwright MCP that only gives the tool list.
  const output = outputDir(cwd);
  const roots = async (request: ListRootsRequest, extra: { signal: AbortSignal }): Promise<ListRootsResult> => {
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
    keepIndexedDb: (host: string): boolean => sites.has(host),
    roots,
    afterOpen: async (lane: Lane): Promise<void> => {
      if (!lane.client) throw new Error(`the lane ${lane.id} has no upstream connection`);
      lane.session = new LaneSession({ lane: lane.id, client: lane.client, notes: lane.notes, pageCode: new UpstreamPageCode(lane.client) });
      if (discovery && lane.context) await discovery.start(lane.session, lane.context);
    },
    beforeClose: async (lane: Lane): Promise<void> => {
      if (discovery && lane.session) await discovery.stop(lane.session);
    },
    ...laneOptions,
  });
  const catalog = await catalogClient(output);
  const upstreamTools = await allTools(catalog);
  toolsConfig.addMissing([...upstreamTools.map((tool) => tool.name), ...LANE_TOOLS.map((tool) => tool.name)]);
  logger.info('upstream_ready', { tools: upstreamTools.length, version: catalog.getServerVersion()?.version });

  // The log files open in the folder of the client name. A client can send its first notification
  // before the server has the name: then the first request opens them.
  const openLog = (): void => {
    const name = clientName();
    if (!logger.files && name) logger.open(name);
  };
  server.oninitialized = (): void => {
    openLog();
    logger.info('client_ready', { client: server.getClientVersion(), capabilities: server.getClientCapabilities() });
    markDownstreamReady();
  };

  const pipeline = new CallPipeline({ server, logger, toolSwitches: toolsConfig, hostPolicy, fill, autofill, lanes, cwd, outputDir: output, upstreamTools });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    openLog();
    return pipeline.listTools();
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    openLog();
    return pipeline.callTool(request, extra);
  });

  // 5. Close the lanes and the browser with the server.
  let closed = false;
  async function close(reason: string): Promise<void> {
    if (closed) return;
    closed = true;
    logger.open();
    logger.info('shutdown', { reason });
    await lanes.closeAll(reason);
    await Promise.allSettled([catalog.close(), server.close(), fill.dispose()]);
    onClose?.(reason);
  }
  server.onclose = (): void => { void close('client closed'); };
  server.onerror = (error: Error): void => logger.error('client_error', { message: error.message });

  await server.connect(serverTransport);
  return { server, close, lanes };
}

// A connection to Playwright MCP without a browser: it gives only the tool list.
async function catalogClient(output: string): Promise<Client> {
  const upstream = await createConnection({ browser: { browserName: 'chromium', isolated: false }, outputDir: output }, async () => {
    throw new Error('open a lane first');
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await upstream.connect(serverTransport);
  const client = new Client({ name: SERVER_NAME, version: VERSION }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function allTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

// A text of upstream for the client, without the name Playwright.
export function neutral(text: string): string {
  return text
    .replace(/Playwright MCP/g, 'this server')
    .replace(/Playwright (code|server)/g, '$1')
    .replace(/(a|A) Playwright /g, '$1 ')
    .replace(/Playwright /g, '');
}

// A result of upstream for the client: without the "Ran Playwright code" sections.
export function forClient(result: CallToolResult): CallToolResult {
  const content = result.content?.map((part) => (part.type === 'text' ? { ...part, text: part.text.replace(CODE_SECTION, '') } : part));
  return { ...result, content };
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `### Error\n${text}` }] };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text: `### Result\n${text}` }] };
}

// Replace the values of secret headers with MASK.
export function maskHeaders(text: string): string {
  return text.replace(SECRET_HEADER, `$1${MASK}`);
}

function maskResult(result: CallToolResult): CallToolResult {
  const content = result.content?.map((part) => (part.type === 'text' ? { ...part, text: maskHeaders(part.text) } : part));
  return { ...result, content };
}

// The same for the text files of a call. Binary files stay.
function maskFiles(files: readonly string[], logger: Logger): void {
  for (const file of files) {
    let text: string;
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
export function fileInOutput(outputDir: string, name: string): string | undefined {
  const file = path.resolve(outputDir, name);
  const relative = path.relative(outputDir, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return file;
}

// The URL that a call opens, if the arguments give it.
function targetUrl(name: string, args: ToolArgs | undefined): string | undefined {
  if (name === 'browser_navigate') return typeof args?.url === 'string' ? args.url : undefined;
  if (name === 'browser_tabs' && args?.action === 'new') return typeof args.url === 'string' ? args.url : undefined;
  return undefined;
}

// The URL of the current page, from the "- Page URL:" line of a Playwright result.
function pageUrlOf(result: CallToolResult): string | undefined {
  const text = result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '';
  const matches = [...text.matchAll(/^- Page URL: (\S+)/gm)];
  return matches.at(-1)?.[1];
}

function textOf(result: CallToolResult): string {
  return result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function unknownLane(id: unknown): CallToolResult {
  if (!id) return errorResult('Give the parameter lane: the ID from browser_lane_open. Call browser_lane_open first.');
  return errorResult(`The lane ${String(id)} is not open. Call browser_lane_open, and use the new ID.`);
}

export interface CallPipelineOptions {
  readonly server: Server;
  readonly logger: Logger;
  readonly toolSwitches: ToolSwitches;
  readonly hostPolicy: HostPolicy;
  readonly fill: FillValues;
  readonly autofill: FormFill;
  readonly lanes: LaneManager;
  readonly cwd: string;
  readonly outputDir: string;
  readonly upstreamTools: readonly Tool[];
}

// The steps of the tool calls of the client.
export class CallPipeline {
  private readonly server: Server;
  private readonly logger: Logger;
  private readonly toolSwitches: ToolSwitches;
  private readonly hostPolicy: HostPolicy;
  private readonly fill: FillValues;
  private readonly autofill: FormFill;
  private readonly lanes: LaneManager;
  private readonly cwd: string;
  private readonly outputDir: string;
  private readonly upstreamTools: readonly Tool[];

  constructor(options: CallPipelineOptions) {
    this.server = options.server;
    this.logger = options.logger;
    this.toolSwitches = options.toolSwitches;
    this.hostPolicy = options.hostPolicy;
    this.fill = options.fill;
    this.autofill = options.autofill;
    this.lanes = options.lanes;
    this.cwd = options.cwd;
    this.outputDir = options.outputDir;
    this.upstreamTools = options.upstreamTools;
  }

  // The tools for the client: the lane tools, and each upstream tool with the parameter lane.
  listTools(): ListToolsResult {
    const withLane = this.upstreamTools.map((tool): Tool => {
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
    const tools = [...LANE_TOOLS, ...withLane].map((tool) => this.toolSwitches.describe(JSON.parse(neutral(JSON.stringify(tool))) as Tool));
    this.logger.info('list_tools', { count: tools.length });
    this.logger.debug('list_tools_names', { tools: tools.map((tool) => tool.name) });
    return { tools };
  }

  async callTool(request: CallToolRequest, extra: CallExtra): Promise<CallToolResult> {
    const { logger } = this;
    const { name, arguments: toolArgs } = request.params;
    const id = extra.requestId;
    const start = Date.now();
    logger.info('tool_call', { id, tool: name, args: logger.args(toolArgs) });

    try {
      const result = await this.laneCall(request, extra);
      logger.info('tool_result', { id, tool: name, ms: Date.now() - start, ...summarizeResult(result) });
      if (logger.isDebug) {
        const text = textOf(result);
        logger.debug('tool_result_text', { id, tool: name, text: text.slice(0, DEBUG_TEXT_MAX), truncated: text.length > DEBUG_TEXT_MAX });
      }
      return result;
    } catch (error) {
      logger.error('tool_error', { id, tool: name, ms: Date.now() - start, message: errorMessage(error), code: errorCode(error) });
      throw error;
    }
  }

  // The context of a provider for the page url (see src/fill/provider.ts).
  private fillContext(url: string | undefined): FillContext {
    const { server } = this;
    const elicitation = server.getClientCapabilities()?.elicitation;
    const canAsk = Boolean(elicitation && (elicitation.form || Object.keys(elicitation).length === 0));
    return {
      host: hostOfUrl(url ?? ''),
      url,
      client: server.getClientVersion()?.name,
      elicit: canAsk
        ? (message: string, requestedSchema: ElicitSchema, timeout: number = ASK_TIMEOUT): Promise<ElicitResult> => server.elicitInput({ message, requestedSchema }, { timeout })
        : undefined,
    };
  }

  // One call in a lane.
  private async laneCall(request: CallToolRequest, extra: CallExtra): Promise<CallToolResult> {
    const { lanes, toolSwitches } = this;
    const { name } = request.params;
    const given: ToolArgs = request.params.arguments ?? {};
    if (!toolSwitches.isEnabled(name)) return toolSwitches.disabledResult(name);
    if (LANE_TOOLS.some((tool) => tool.name === name)) return this.laneTool(name, given);
    const lane = lanes.get(typeof given.lane === 'string' ? given.lane : undefined);
    if (!lane?.session) return unknownLane(given.lane);
    if (name === 'browser_close') return this.laneTool('browser_lane_close', given);
    if (name === 'browser_tabs' && given.action === 'new' && lanes.tabCount(lane) >= lanes.maxTabs) {
      return errorResult(`The lane ${lane.id} has the maximum of ${lanes.maxTabs} tabs. Close a tab first.`);
    }
    const { lane: _, ...args } = given;
    lane.busy++;
    lane.lastUsed = Date.now();
    try {
      const result = await this.runSteps(lane.session, { ...request, params: { ...request.params, arguments: args } }, extra);
      const notes = lane.notes.splice(0);
      if (!notes.length) return result;
      return { ...result, content: [...(result.content ?? []), { type: 'text', text: `### Note\n${notes.join('\n')}` }] };
    } finally {
      lane.busy--;
      lane.lastUsed = Date.now();
    }
  }

  // The calls of the lane tools.
  private async laneTool(name: string, args: ToolArgs): Promise<CallToolResult> {
    const { lanes } = this;
    if (name === 'browser_lanes') return textResult(lanes.status());
    if (name === 'browser_lane_open') {
      const browserSession = args.browserSession;
      if (!isBrowserSession(browserSession)) {
        return errorResult(`Give the parameter browserSession: ${BROWSER_SESSIONS.join(', ')}. Use normal if the user did not ask for an other browser session.`);
      }
      const lane: Lane | undefined = await lanes.open(browserSession);
      if (!lane) return errorResult(`Busy: ${lanes.size} of ${lanes.maxLanes} lanes are open. Call browser_lanes later, then try again.`);
      return textResult(`Lane: ${lane.id}\nBrowser session: ${browserSession} (${SESSION_TEXT[browserSession]}). Tell the user the browser session.\nGive lane="${lane.id}" in each other call. Close the lane with browser_lane_close at the end.`);
    }
    // browser_lane_close, and browser_close of a lane.
    const id = typeof args.lane === 'string' ? args.lane : undefined;
    if (!await lanes.close(id, 'tool')) return unknownLane(args.lane);
    return textResult(`The lane ${id} is closed.`);
  }

  // The steps of one call. Each step can stop the call with an error result.
  private async runSteps(lane: LaneSession, request: CallToolRequest, extra: CallExtra): Promise<CallToolResult> {
    const { hostPolicy, fill, logger } = this;
    const { client } = lane;
    const { name } = request.params;
    let args: ToolArgs | undefined = request.params.arguments;

    if (typeof args?.filename === 'string') {
      const file = fileInOutput(this.outputDir, args.filename);
      if (!file) return errorResult(`The file name ${args.filename} is not allowed. Give a file name in the output folder, e.g. a name without a folder.`);
      args = { ...args, filename: file };
    }

    const target = targetUrl(name, args);
    if (target) {
      const check = await hostPolicy.check(target);
      if (!check.allowed) return this.blockedResult(lane, name, target, check, false);
    }

    const progressToken = request.params._meta?.progressToken;
    const started = Date.now();
    const call = lane.startAgentCall(started);
    let raw = await client.callTool({ ...request.params, arguments: args }, undefined, {
      signal: extra.signal,
      timeout: TOOL_TIMEOUT,
      resetTimeoutOnProgress: true,
      onprogress: progressToken === undefined ? undefined : (progress: Progress): void => {
        void extra.sendNotification({ method: 'notifications/progress', params: { progressToken, ...progress } });
      },
    }) as CallToolResult;

    // The end of the call: the discovery gives the events of this time to the agent.
    call.end = Date.now();

    // A click, a redirect or a script can open a page of a blocked host. Close it.
    // Each page after a submit of the form fill gets the same check (see autofill.ts).
    const checkPage = async (url: string): Promise<HostCheck> => {
      lane.pageUrl = url;
      const check = await hostPolicy.check(url);
      if (check.allowed) await hostPolicy.opened(url, { tool: name });
      return check;
    };
    const opened = pageUrlOf(raw);
    if (opened) {
      const previous = lane.pageUrl;
      const check = await checkPage(opened);
      if (!check.allowed) return this.blockedResult(lane, name, opened, check, true);
      if (opened !== previous) logger.info('page_opened', { url: opened, via: 'tool' });
      const outcome = await this.autofill.run(lane, opened, (url) => this.fillContext(url), checkPage);
      if (outcome.blocked) return this.blockedResult(lane, name, outcome.blocked.url, outcome.blocked.check, true);
      if (outcome.submitted) {
        raw = await client.callTool({ name: 'browser_snapshot', arguments: {} }, undefined, { timeout: TOOL_TIMEOUT }) as CallToolResult;
        const last = pageUrlOf(raw);
        if (last && last !== lane.pageUrl) {
          const lastCheck = await checkPage(last);
          if (!lastCheck.allowed) return this.blockedResult(lane, name, last, lastCheck, true);
        }
      }
    }
    const files = this.writtenFiles(raw, started);
    fill.scrubFiles(files);
    maskFiles(files, logger);
    return forClient(maskResult(fill.scrub(raw)));
  }

  // The files of a call: each file link in the result, and each file of the output folder that
  // changed since the call started. Upstream writes snapshots and console logs there.
  private writtenFiles(result: CallToolResult, since: number): string[] {
    const files = new Set<string>();
    for (const part of result.content ?? []) {
      if (part.type !== 'text') continue;
      for (const [, link = ''] of part.text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const file = path.resolve(this.cwd, link.replace(/#.*$/, ''));
        if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) files.add(file);
      }
    }
    if (this.outputDir && fs.existsSync(this.outputDir)) {
      for (const entry of fs.readdirSync(this.outputDir, { recursive: true, withFileTypes: true })) {
        const file = path.join(entry.parentPath, entry.name);
        if (entry.isFile() && fs.statSync(file).mtimeMs >= since - MTIME_SLACK) files.add(file);
      }
    }
    return [...files];
  }

  // The error result for a blocked host. closePage: the browser shows the page; replace it with about:blank.
  private async blockedResult(lane: LaneSession, tool: string, url: string, check: HostCheck, closePage: boolean): Promise<CallToolResult> {
    this.logger.info('host_blocked', { tool, url, reason: check.reason });
    const reason = capitalize(check.reason ?? '');
    if (!closePage) return errorResult(`Navigation blocked: ${url} is not allowed. ${reason}.`);
    await lane.client.callTool({ name: 'browser_navigate', arguments: { url: 'about:blank' } }, undefined, { timeout: TOOL_TIMEOUT });
    lane.pageUrl = 'about:blank';
    return errorResult(`Navigation blocked: ${url} is not allowed. ${reason}. The browser shows about:blank.`);
  }
}
