// Shared test code: a local web server with the fixture pages, a config copy for each test,
// and an MCP client of the server.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_DIR, TOOL_DIR } from '../src/paths.ts';

export const FIXTURES: string = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pages');
export const FAKE_VAULT: string = path.join(TOOL_DIR, 'tests', 'fixtures', 'fake-vault');
export const TEST_LOG_DIR: string = path.join(ASSETS_DIR, 'test-logs');
const TEST_CONFIG_DIR: string = path.join(ASSETS_DIR, 'test-config');
export const TEST_STATE_DIR: string = path.join(ASSETS_DIR, 'test-state');

// Serve the fixture pages on 127.0.0.1. "localhost" reaches the same server as an other host.
//   POST /submit        the form data as JSON in <pre id="result">, also kept in submissions
//   GET /redirect?to=U  a redirect to U
//   GET /link?to=U      a page with a link to U
//   POST /login-again   kept in submissions; the login page again, as after a wrong password
// The form data of one submit: a field with more values gives an array.
export type Submission = Record<string, string | string[]>;

// The local web server of the tests.
export interface TestSite {
  readonly port: number;
  readonly url: string;
  readonly otherUrl: string;
  // The form data that the server got, without the server between: the real values.
  readonly submissions: Submission[];
  close(): Promise<void>;
}

export async function startSite(): Promise<TestSite> {
  const submissions: Submission[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/login-again') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        submissions.push(Object.fromEntries(new URLSearchParams(body)));
        html(res, fs.readFileSync(path.join(FIXTURES, 'login.html'), 'utf8'));
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/submit') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const data: Submission = {};
        for (const [key, value] of new URLSearchParams(body)) {
          const before = data[key];
          data[key] = before === undefined ? value : [before, value].flat();
        }
        submissions.push(data);
        html(res, `<!doctype html><title>Submitted</title><h1>Submitted</h1><pre id="result">${escapeHtml(JSON.stringify(data))}</pre>`);
      });
      return;
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: url.searchParams.get('to') ?? '/' }).end();
      return;
    }
    if (url.pathname === '/link') {
      html(res, `<!doctype html><title>Link</title><a href="${escapeHtml(url.searchParams.get('to'))}">Go there</a>`);
      return;
    }
    const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    fs.readFile(path.join(FIXTURES, name), (error, content) => {
      if (error) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(content);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    otherUrl: `http://localhost:${port}`,
    // The form data that the server got, without the server between: the real values.
    submissions,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
}

// Make a config folder for one test (see src/paths.js). The config of the repository stays unchanged.
// sites: the "sites" of sites.json, merged into the default sites: 127.0.0.1 and localhost with
// the systems of the fake vault (providerConfig: false leaves them out). tools: { <tool>: true | false }; browser_evaluate is on because the
// tests read the page with it. values, ask, vault: the settings of the providers.
export interface TestConfig {
  readonly sites?: Record<string, Record<string, unknown>>;
  readonly defaultAccess?: 'allow' | 'deny';
  readonly tools?: Record<string, boolean>;
  readonly values?: Record<string, string>;
  readonly ask?: readonly string[];
  readonly vault?: string;
  readonly providerConfig?: boolean;
  readonly providers?: readonly Record<string, unknown>[];
}

export interface TestConfigDir {
  readonly configDir: string;
  readonly env: Record<string, string>;
}

export function makeConfig(name: string, { sites = {}, defaultAccess = 'allow', tools = {}, values = {}, ask = ['phone'], vault = 'vault-test', providerConfig = true, providers }: TestConfig = {}): TestConfigDir {
  const root = path.join(TEST_CONFIG_DIR, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const write = (file: string, data: unknown): void => fs.writeFileSync(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`);
  write('server.json', {
    providers: providers ?? [
      { type: 'vault', enabled: true, mask: true, vault },
      { type: 'values', enabled: true, mask: false, values },
      { type: 'ask', enabled: true, mask: true, fields: ask },
    ],
    tools: Object.fromEntries(Object.entries({ browser_evaluate: true, ...tools }).map(([tool, enabled]) => [tool, { enabled }])),
  });
  const vaultConfig = (entry: string): Record<string, unknown> => ({ 'provider-config': { vault: { vault, entry } } });
  const base: Record<string, Record<string, unknown>> = providerConfig ? { '127.0.0.1': vaultConfig('Fixture site'), localhost: vaultConfig('Fixture other') } : {};
  const merged = { ...base };
  for (const [host, site] of Object.entries(sites)) merged[host] = { ...base[host], ...site };
  write('sites.json', { defaultAccess, sites: merged });
  return {
    configDir: root,
    env: { BROWSER_AUTOMATION_X_MCP_VAULT_TOOL: path.join(FAKE_VAULT, 'run.sh') },
  };
}

// The tools of the server that need no lane.
export const LANE_TOOL_NAMES: ReadonlySet<string> = new Set(['browser_lane_open', 'browser_lane_close', 'browser_lanes']);

// A client that opens a lane at the first call that needs one, and gives its ID in each call.
// A call that gives lane itself, and the lane tools, go without a change. client.raw is the client
// without this. client.lane is the ID of the current lane.
export type CallParams = Parameters<Client['callTool']>[0];

// A client of the tests: the MCP client with automatic lanes.
export interface LaneClient {
  callTool(params: CallParams): Promise<CallToolResult>;
  listTools: Client['listTools'];
  getServerVersion: Client['getServerVersion'];
  getInstructions: Client['getInstructions'];
  close(): Promise<void>;
  // The client without automatic lanes.
  readonly raw: LaneClient;
  // The ID of the current lane.
  readonly lane: string | undefined;
}

function rawClient(client: Client): LaneClient {
  const value: LaneClient = {
    callTool: async (params) => await client.callTool(params) as CallToolResult,
    listTools: (...args) => client.listTools(...args),
    getServerVersion: () => client.getServerVersion(),
    getInstructions: () => client.getInstructions(),
    close: () => client.close(),
    get raw(): LaneClient { return value; },
    lane: undefined,
  };
  return value;
}

function laneClient(client: Client): LaneClient {
  const raw = rawClient(client);
  let lane: string | undefined;
  const callTool = async (params: CallParams): Promise<CallToolResult> => {
    if (LANE_TOOL_NAMES.has(params.name) || params.arguments?.lane !== undefined) return raw.callTool(params);
    if (!lane) {
      const opened = await raw.callTool({ name: 'browser_lane_open', arguments: { browserSession: 'normal' } });
      const first = opened.content?.[0];
      lane = first?.type === 'text' ? first.text.match(/Lane: (lane-[0-9a-f]+)/)?.[1] : undefined;
      if (!lane) throw new Error(`no lane: ${JSON.stringify(opened)}`);
    }
    const result = await raw.callTool({ ...params, arguments: { ...params.arguments, lane } });
    if (params.name === 'browser_close') lane = undefined;
    return result;
  };
  return {
    ...raw,
    callTool,
    raw,
    get lane(): string | undefined { return lane; },
  };
}

export interface ServerClientOptions {
  readonly name: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly config?: TestConfig;
  // Answers the dialogs of the server; without it, the client cannot show dialogs.
  readonly onElicit?: (params: ElicitRequest['params']) => Promise<ElicitResult>;
  readonly keepState?: boolean;
}

// A form of sites.json in a test.
export interface TestForm {
  fields?: Record<string, string>;
  submit?: string[];
}

// A node of sites.json in a test.
export interface TestNode {
  access?: string;
  forms?: TestForm[];
  login?: string[];
  subdomains?: Record<string, TestNode>;
  [key: string]: unknown;
}

// sites.json in a test.
export interface TestSitesFile {
  sites: Record<string, TestNode>;
  [key: string]: unknown;
}

// The server of a test and its client.
export interface ServerClient {
  readonly client: LaneClient;
  readonly logDir: string;
  readonly stateFile: string;
  readonly sitesFile: string;
  // sites.json of the test config as an object: the discovery mode writes it.
  readonly sites: TestSitesFile;
  readonly logFile: string;
  readonly textLogFile: string;
  readonly config: TestConfigDir;
  close(): Promise<void>;
}

// Start the server as a child process and connect an MCP client to it. The browser is headless,
// except when env gives an other RENDER_MODE. Each test has its own storage-state file.
// onElicit: answers the dialogs of the ask provider; without it, the client cannot show dialogs.
export async function startServerClient({ name, args = [], env = {}, config = {}, onElicit, keepState = false }: ServerClientOptions): Promise<ServerClient> {
  const logDir = path.join(TEST_LOG_DIR, name);
  fs.rmSync(logDir, { recursive: true, force: true });
  const testConfig = makeConfig(name, config);
  const stateFile = path.join(TEST_STATE_DIR, `${name}.json`);
  if (!keepState) fs.rmSync(stateFile, { force: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(TOOL_DIR, 'playwright', 'src', 'server.ts'), '--config-dir', testConfig.configDir, ...args],
    env: { ...process.env as Record<string, string>, RENDER_MODE: 'HEADLESS', BROWSER_AUTOMATION_X_MCP_LOG_DIR: logDir, BROWSER_AUTOMATION_X_MCP_STORAGE_STATE: stateFile, ...testConfig.env, ...env },
    cwd: TOOL_DIR,
    stderr: 'inherit',
  });
  const capabilities = onElicit ? { elicitation: { form: {} } } : {};
  const client = new Client({ name: `test-${name}`, version: '0' }, { capabilities });
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, async (request) => onElicit(request.params));
  await client.connect(transport);
  // The server opens its log files after initialize, in <logDir>/<client name>/.
  return {
    client: laneClient(client),
    logDir,
    stateFile,
    sitesFile: path.join(testConfig.configDir, 'sites.json'),
    // sites.json of the test config as an object: the discovery mode writes it.
    get sites(): ServerClient['sites'] { return JSON.parse(fs.readFileSync(path.join(testConfig.configDir, 'sites.json'), 'utf8')) as ServerClient['sites']; },
    get logFile(): string { return findLog(logDir, '.log.json') ?? ''; },
    get textLogFile(): string { return findLog(logDir, '.log') ?? ''; },
    config: testConfig,
    close: () => client.close(),
  };
}

// The newest log file with the suffix in the folders of logDir.
export function findLog(logDir: string, suffix: string): string | undefined {
  const files: string[] = [];
  for (const folder of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) {
    for (const name of fs.readdirSync(path.join(logDir, folder))) {
      if (name.endsWith(suffix) && !(suffix === '.log' && name.endsWith('.log.json'))) files.push(path.join(logDir, folder, name));
    }
  }
  return files.sort().at(-1);
}

// Call a tool. Fail when the tool reports an error. Give the text of the result.
export async function call(client: LaneClient, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const text = await callText(client, name, args);
  if (text.isError) throw new Error(`${name} failed: ${text.text}`);
  return text.text;
}

// Call a tool. Give { text, isError } without a failure.
export interface CallText {
  readonly text: string;
  readonly isError: boolean;
}

export async function callText(client: LaneClient, name: string, args: Record<string, unknown> = {}): Promise<CallText> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((part) => (part.type === 'text' ? part.text : undefined)).filter((part) => part !== undefined).join('\n');
  return { text, isError: Boolean(result.isError) };
}

// Find the ref of an element in a snapshot, e.g. ref(snapshot, 'textbox', 'Email').
export function ref(snapshot: string, role: string, name: string): string {
  const pattern = new RegExp(`- ${role} "${escapeRegExp(name)}"[^\\n]*\\[ref=(\\w+)\\]`);
  const match = snapshot.match(pattern);
  if (!match) throw new Error(`no ${role} "${name}" in the snapshot:\n${snapshot}`);
  return match[1] ?? '';
}

// Give the return value of a function in the page.
export async function evaluate(client: LaneClient, fn: string): Promise<unknown> {
  const text = await call(client, 'browser_evaluate', { function: fn });
  const match = text.match(/### Result\n([\s\S]*?)(\n###|$)/);
  if (!match) throw new Error(`no result in:\n${text}`);
  return JSON.parse((match[1] ?? '').trim());
}

function escapeHtml(text: unknown): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The entries of a JSON Lines log file.
export function readLog(file: string): LogLine[] {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as LogLine);
}

// One entry of the JSON log.
export interface LogLine {
  readonly event: string;
  readonly [field: string]: unknown;
}
