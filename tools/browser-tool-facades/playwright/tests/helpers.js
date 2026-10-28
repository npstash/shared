// Shared test code: a local web server with the fixture pages, a config copy for each test,
// and an MCP client of the facade.
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

// Serve the fixture pages on 127.0.0.1. "localhost" reaches the same server as an other host.
//   POST /submit        the form data as JSON in <pre id="result">, also kept in submissions
//   GET /redirect?to=U  a redirect to U
//   GET /link?to=U      a page with a link to U
export async function startSite() {
  const submissions = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
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
    // The form data that the server got, without the facade between: the real values.
    submissions,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
}

// Make a config folder for one test. The committed config stays unchanged.
// browser_evaluate is enabled because the tests read the page with it.
export function makeConfig(name, { facade, hosts, tools, ini, ask, vault } = {}) {
  const root = path.join(TEST_CONFIG_DIR, name);
  fs.rmSync(root, { recursive: true, force: true });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(path.join(root, 'config', 'facade.ini'), facade ?? '[fill]\nproviders = vault, ini, ask\n\n[hosts]\nrecord = true\n');
  write(path.join(root, 'config', 'hosts.ini'), hosts ?? '[deny]\n\n[allow]\n*\n');
  write(path.join(root, 'playwright', 'tools.ini'), tools ?? '[tools]\nbrowser_evaluate = enabled\n');
  write(path.join(root, 'providers', 'ini', 'config.ini'), ini ?? '[all]\n');
  write(path.join(root, 'providers', 'ask', 'config.ini'), ask ?? '[ask]\nfields = phone\n');
  write(path.join(root, 'providers', 'vault', 'config.ini'), vault ?? `[vault]\ntool = ${path.join(FAKE_VAULT, 'run.sh')}\nvault_home = ${FAKE_VAULT}\n`);
  return {
    // Shared config (facade.ini, hosts.ini), config of the Playwright facade (tools.ini).
    sharedConfigDir: path.join(root, 'config'),
    facadeConfigDir: path.join(root, 'playwright'),
    providersConfigDir: path.join(root, 'providers'),
    env: {
      BROWSER_FACADES_CONFIG_DIR: path.join(root, 'config'),
      BROWSER_FACADES_PROVIDERS_CONFIG_DIR: path.join(root, 'providers'),
      PLAYWRIGHT_FACADE_CONFIG_DIR: path.join(root, 'playwright'),
    },
  };
}

// Start the facade as a child process and connect an MCP client to it.
// onElicit: answers the dialogs of the ask provider; without it, the client cannot show dialogs.
export async function startFacadeClient({ name, args = ['--headless', '--isolated'], env = {}, config = {}, onElicit }) {
  fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
  const logFile = path.join(TEST_LOG_DIR, `${name}.log`);
  fs.rmSync(logFile, { force: true });
  const testConfig = makeConfig(name, config);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(TOOL_DIR, 'playwright', 'src', 'server.js'), ...args],
    env: { ...process.env, PLAYWRIGHT_FACADE_LOG_FILE: logFile, ...testConfig.env, ...env },
    cwd: TOOL_DIR,
    stderr: 'inherit',
  });
  const capabilities = onElicit ? { elicitation: { form: {} } } : {};
  const client = new Client({ name: `test-${name}`, version: '0' }, { capabilities });
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, async (request) => onElicit(request.params));
  await client.connect(transport);
  return { client, logFile, config: testConfig, close: () => client.close() };
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
