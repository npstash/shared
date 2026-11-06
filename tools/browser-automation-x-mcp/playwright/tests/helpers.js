// Shared test code: a local web server with the fixture pages, a config copy for each test,
// and an MCP client of the server.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_DIR, TOOL_DIR } from '../../src/paths.js';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const FAKE_VAULT = path.join(TOOL_DIR, 'tests', 'fixtures', 'fake-vault');
export const TEST_LOG_DIR = path.join(ASSETS_DIR, 'test-logs');
const TEST_CONFIG_DIR = path.join(ASSETS_DIR, 'test-config');
export const TEST_STATE_DIR = path.join(ASSETS_DIR, 'test-state');

// Serve the fixture pages on 127.0.0.1. "localhost" reaches the same server as an other host.
//   POST /submit        the form data as JSON in <pre id="result">, also kept in submissions
//   GET /redirect?to=U  a redirect to U
//   GET /link?to=U      a page with a link to U
//   POST /login-again   kept in submissions; the login page again, as after a wrong password
export async function startSite() {
  const submissions = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
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
        const data = {};
        for (const [key, value] of new URLSearchParams(body)) {
          data[key] = key in data ? [].concat(data[key], value) : value;
        }
        submissions.push(data);
        html(res, `<!doctype html><title>Submitted</title><h1>Submitted</h1><pre id="result">${escapeHtml(JSON.stringify(data))}</pre>`);
      });
      return;
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: url.searchParams.get('to') }).end();
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    otherUrl: `http://localhost:${port}`,
    // The form data that the server got, without the server between: the real values.
    submissions,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
}

// Make a config folder for one test (see src/paths.js). The config of the repository stays unchanged.
// sites: the "sites" of sites.json, merged into the default sites: 127.0.0.1 and localhost with
// the systems of the fake vault. tools: { <tool>: true | false }; browser_evaluate is on because the
// tests read the page with it. values, ask, vault: the settings of the providers.
export function makeConfig(name, { sites = {}, defaultAccess = 'allow', tools = {}, values = {}, ask = ['phone'], vault = 'vault-test', credentials = true, providers } = {}) {
  const root = path.join(TEST_CONFIG_DIR, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const write = (file, data) => fs.writeFileSync(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`);
  write('server.json', {
    providers: providers ?? [
      { type: 'vault', enabled: true, mask: true, vault },
      { type: 'values', enabled: true, mask: false, values },
      { type: 'ask', enabled: true, mask: true, fields: ask },
    ],
    tools: Object.fromEntries(Object.entries({ browser_evaluate: true, ...tools }).map(([tool, enabled]) => [tool, { enabled }])),
  });
  const base = credentials
    ? { '127.0.0.1': { credentials: { vault: 'Fixture site' } }, localhost: { credentials: { vault: 'Fixture other' } } }
    : {};
  const merged = { ...base };
  for (const [host, site] of Object.entries(sites)) merged[host] = { ...base[host], ...site };
  write('sites.json', { defaultAccess, sites: merged });
  return {
    configDir: root,
    env: { BROWSER_AUTOMATION_X_MCP_VAULT_TOOL: path.join(FAKE_VAULT, 'run.sh') },
  };
}

// The tools of the server that need no lane.
export const LANE_TOOL_NAMES = new Set(['browser_lane_open', 'browser_lane_close', 'browser_lanes']);

// A client that opens a lane at the first call that needs one, and gives its ID in each call.
// A call that gives lane itself, and the lane tools, go without a change. client.raw is the client
// without this. client.lane is the ID of the current lane.
function laneClient(client) {
  let lane;
  const callTool = async (params, ...rest) => {
    if (LANE_TOOL_NAMES.has(params.name) || params.arguments?.lane !== undefined) return client.callTool(params, ...rest);
    if (!lane) {
      const opened = await client.callTool({ name: 'browser_lane_open', arguments: {} });
      lane = opened.content?.[0]?.text.match(/Lane: (lane-[0-9a-f]+)/)?.[1];
      if (!lane) throw new Error(`no lane: ${JSON.stringify(opened)}`);
    }
    const result = await client.callTool({ ...params, arguments: { ...params.arguments, lane } }, ...rest);
    if (params.name === 'browser_close') lane = undefined;
    return result;
  };
  return new Proxy(client, {
    get(target, property) {
      if (property === 'callTool') return callTool;
      if (property === 'raw') return target;
      if (property === 'lane') return lane;
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// Start the server as a child process and connect an MCP client to it. The browser is headless,
// except when env gives an other RENDER_MODE. Each test has its own storage-state file.
// onElicit: answers the dialogs of the ask provider; without it, the client cannot show dialogs.
export async function startServerClient({ name, args = [], env = {}, config = {}, onElicit, keepState = false }) {
  const logDir = path.join(TEST_LOG_DIR, name);
  fs.rmSync(logDir, { recursive: true, force: true });
  const testConfig = makeConfig(name, config);
  const stateFile = path.join(TEST_STATE_DIR, `${name}.json`);
  if (!keepState) fs.rmSync(stateFile, { force: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(TOOL_DIR, 'playwright', 'src', 'server.js'), '--config-dir', testConfig.configDir, ...args],
    env: { ...process.env, RENDER_MODE: 'HEADLESS', BROWSER_AUTOMATION_X_MCP_LOG_DIR: logDir, BROWSER_AUTOMATION_X_MCP_STORAGE_STATE: stateFile, ...testConfig.env, ...env },
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
    get sites() { return JSON.parse(fs.readFileSync(path.join(testConfig.configDir, 'sites.json'), 'utf8')); },
    get logFile() { return findLog(logDir, '.log.json'); },
    get textLogFile() { return findLog(logDir, '.log'); },
    config: testConfig,
    close: () => client.close(),
  };
}

// The newest log file with the suffix in the folders of logDir.
export function findLog(logDir, suffix) {
  const files = [];
  for (const folder of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) {
    for (const name of fs.readdirSync(path.join(logDir, folder))) {
      if (name.endsWith(suffix) && !(suffix === '.log' && name.endsWith('.log.json'))) files.push(path.join(logDir, folder, name));
    }
  }
  return files.sort().at(-1);
}

// Call a tool. Fail when the tool reports an error. Give the text of the result.
export async function call(client, name, args = {}) {
  const text = await callText(client, name, args);
  if (text.isError) throw new Error(`${name} failed: ${text.text}`);
  return text.text;
}

// Call a tool. Give { text, isError } without a failure.
export async function callText(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  return { text, isError: Boolean(result.isError) };
}

// Find the ref of an element in a snapshot, e.g. ref(snapshot, 'textbox', 'Email').
export function ref(snapshot, role, name) {
  const pattern = new RegExp(`- ${role} "${escapeRegExp(name)}"[^\\n]*\\[ref=(\\w+)\\]`);
  const match = snapshot.match(pattern);
  if (!match) throw new Error(`no ${role} "${name}" in the snapshot:\n${snapshot}`);
  return match[1];
}

// Give the return value of a function in the page.
export async function evaluate(client, fn) {
  const text = await call(client, 'browser_evaluate', { function: fn });
  const match = text.match(/### Result\n([\s\S]*?)(\n###|$)/);
  if (!match) throw new Error(`no result in:\n${text}`);
  return JSON.parse(match[1].trim());
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
