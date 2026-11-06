// Unit tests of the shared parts: server.json, sites.json, host access, tool switches, fill providers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ASSETS_DIR, CONFIG_TEMPLATES, SERVER_CONFIG, SITES_CONFIG, TOOL_DIR, configFile } from '../src/paths.js';
import { ApprovalProvider, FillError, FillProvider, KeyValueProvider } from '../src/fill/provider.js';
import { FillRegistry, MASK } from '../src/fill/registry.js';
import { HostPolicy } from '../src/hosts/host-policy.js';
import { hostOfUrl } from '../src/hosts/patterns.js';
import { readJson } from '../src/json.js';
import { LOG_LINE_MAX, compactUrl, createLogger, folderName, formatLine, redact } from '../src/logger.js';
import { ServerConfig, ToolsConfig } from '../src/server-config.js';
import { Sites, covers, pageOf, pathMatches, updateSites } from '../src/sites.js';
import ApproveDialogProvider from '../providers-form-fill/approve-dialog/index.js';
import ApproveHttpsProvider, { normalizeFingerprint } from '../providers-form-fill/approve-https/index.js';
import AskProvider from '../providers-form-fill/ask/index.js';
import ValuesProvider from '../providers-form-fill/values/index.js';
import VaultProvider from '../providers-form-fill/vault/index.js';

const FAKE_VAULT = path.join(TOOL_DIR, 'tests', 'fixtures', 'fake-vault');

// The server gives this map. The tests use their own, in the same form.
const DANGEROUS = { browser_evaluate: 'it runs JavaScript in the web page and can read all data of the page' };

const TMP = path.join(ASSETS_DIR, 'test-unit');
const logger = createLogger({ dir: path.join(ASSETS_DIR, 'test-logs', 'unit'), level: 'error' });

function tmpFile(name, data) {
  const file = path.join(TMP, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (data === undefined) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

function sitesOf(data) {
  return new Sites(tmpFile(`sites/${Math.random().toString(16).slice(2)}.json`, data));
}

describe('hosts', () => {
  test('a site covers its host and its subdomains', () => {
    assert.equal(covers('example.com', 'example.com'), true);
    assert.equal(covers('example.com', 'a.b.example.com'), true);
    assert.equal(covers('Example.COM', 'www.example.com.'), true);
    assert.equal(covers('example.com', 'badexample.com'), false);
    assert.equal(covers('www.example.com', 'example.com'), false);
  });

  test('gives no host for pages without one', () => {
    assert.equal(hostOfUrl('https://Example.com:8080/x'), 'example.com');
    for (const url of ['about:blank', 'data:text/html,x', 'chrome://version', 'not a url']) assert.equal(hostOfUrl(url), undefined);
  });
});

describe('sites.json: access', () => {
  test('a denied site wins over each other site; else the most specific site; else defaultAccess', async () => {
    const sites = sitesOf({ defaultAccess: 'deny', sites: { 'evil.example': { access: 'deny' }, 'www.evil.example': { access: 'allow' }, 'good.example': { access: 'allow' }, 'pages.example': {} } });
    assert.deepEqual(sites.access('www.evil.example'), { allowed: false, reason: 'the host www.evil.example is denied', site: 'evil.example' });
    assert.equal(sites.access('a.good.example').allowed, true);
    assert.deepEqual(sites.access('other.org'), { allowed: false, reason: 'the host other.org is not allowed' });
    assert.equal(sites.access('pages.example').allowed, false, 'a site without access gets defaultAccess');
  });

  test('a missing file allows each host; a wrong defaultAccess is an error', () => {
    assert.equal(new Sites(tmpFile('sites/missing.json')).access('a.example').allowed, true);
    assert.throws(() => sitesOf({ defaultAccess: 'maybe' }).load(), /defaultAccess must be "allow" or "deny"/);
  });

  test('the host policy checks the access; only the discovery records an opened host', async () => {
    const recorded = [];
    const sites = sitesOf({ sites: { 'evil.example': { access: 'deny' } } });
    const policy = new HostPolicy({ sites, onOpened: (host) => recorded.push(host) });
    assert.equal((await policy.check('https://www.evil.example/x')).reason, 'the host www.evil.example is denied');
    assert.equal((await policy.check('https://good.example/')).allowed, true);
    assert.equal((await policy.check('about:blank')).allowed, true);
    await policy.opened('https://www.evil.example/');
    await policy.opened('https://good.example/');
    assert.deepEqual(recorded, ['good.example']);
    await new HostPolicy({ sites }).opened('https://good.example/');
  });
});

describe('sites.json: pages', () => {
  test('the page of a URL: the host and the path, each ID segment replaced with *', () => {
    assert.deepEqual(pageOf('https://Login.Example.com/u/login/identifier?state=x'), { host: 'login.example.com', path: '/u/login/identifier' });
    assert.deepEqual(pageOf('https://a.example/t/12345/user/0f8fad5b-d9cb-469f-a165-70867728950e/x'), { host: 'a.example', path: '/t/*/user/*/x' });
    assert.deepEqual(pageOf('https://a.example/'), { host: 'a.example', path: '/' });
  });

  test('a path pattern: * is each sequence of characters, also /', () => {
    assert.equal(pathMatches('/u/*/login', '/u/abc/def/login'), true);
    assert.equal(pathMatches('/u/*/login', '/u/abc/login/next'), false);
    assert.equal(pathMatches('/*', '/any/path'), true);
    assert.equal(pathMatches('/', '/x'), false);
  });

  test('all matching pages apply; the more specific page wins; submit and login keep their order; login is not a field', () => {
    const sites = sitesOf({
      sites: {
        'example.com': { pages: { '/*': { fields: { '#user': 'username', '#pass': 'password' }, submit: ['#generic'] } } },
        'login.example.com': { pages: { '/admin/*': { fields: { '#pass': 'Secret', 'input[name="admin-pass"]': 'Password' }, submit: ['#next', 'enter'], login: ['#signin'] } } },
        'other.example': { pages: {} },
      },
    });
    assert.deepEqual(sites.match('https://login.example.com/admin/login'), {
      key: 'example.com/* login.example.com/admin/*',
      fields: [{ name: 'username', selector: '#user' }, { name: 'secret', selector: '#pass' }, { name: 'password', selector: 'input[name="admin-pass"]' }],
      submits: ['#next', 'enter', '#generic'],
      logins: ['#signin'],
    });
    assert.equal(sites.match('https://other.example/'), undefined);
    assert.equal(sites.match('https://unknown.example/'), undefined);
    assert.deepEqual(sitesOf({ sites: { 'shop.example': { pages: { '/': { login: ['a'] } } } } }).match('https://shop.example/'),
      { key: 'shop.example/', fields: [], submits: [], logins: ['a'] });
  });

  test('the vault system: of the most specific page with credentials, else of the most specific site', () => {
    const sites = sitesOf({
      sites: {
        'example.com': { credentials: { vault: 'Example' }, pages: { '/a/*': { credentials: { vault: 'Example A' } } } },
        'b.example.com': { credentials: { vault: 'Example B' } },
      },
    });
    assert.equal(sites.vaultSystem('https://www.example.com/'), 'Example');
    assert.equal(sites.vaultSystem('https://example.com/a/x'), 'Example A');
    assert.equal(sites.vaultSystem('https://b.example.com/a/x'), 'Example A');
    assert.equal(sites.vaultSystem('https://b.example.com/'), 'Example B');
    assert.equal(sites.vaultSystem('https://other.example/'), undefined);
  });

  test('updateSites reads the file again, keeps the other entries, and writes only on a change', () => {
    const file = tmpFile('sites/update.json', { defaultAccess: 'deny', sites: { 'a.example': { access: 'allow', note: 'mine' } } });
    const sites = new Sites(file);
    assert.equal(sites.access('b.example').allowed, false);
    const before = fs.statSync(file).mtimeMs;
    assert.equal(updateSites(file, () => false), false);
    assert.equal(fs.statSync(file).mtimeMs, before);
    updateSites(file, (data) => { data.sites['b.example'] = { access: 'allow' }; return true; });
    assert.deepEqual(readJson(file), { defaultAccess: 'deny', sites: { 'a.example': { access: 'allow', note: 'mine' }, 'b.example': { access: 'allow' } } });
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(sites.access('b.example').allowed, true, 'the Sites object reads the file again');
  });
});

describe('server.json', () => {
  test('the providers that are on, in the order of the file; a provider without mask is masked', () => {
    const config = new ServerConfig(tmpFile('server/providers.json', { providers: [
      { type: 'values', mask: false, values: { a: 1 } }, { type: 'vault', enabled: false }, { type: 'ask', fields: ['phone'] },
    ] }), logger);
    assert.deepEqual(config.providers().map(({ type, mask }) => [type, mask]), [['values', false], ['ask', true]]);
    assert.deepEqual(config.providers()[0].settings.values, { a: 1 });
  });

  test('providers must be an array; each provider needs a type', () => {
    assert.throws(() => new ServerConfig(tmpFile('server/object.json', { providers: {} }), logger).providers(), /"providers" must be an array/);
    assert.throws(() => new ServerConfig(tmpFile('server/notype.json', { providers: [{}] }), logger).providers(), /needs a "type"/);
  });

  test('adds the missing tools with defaults; keeps the user values and the other keys', () => {
    const file = tmpFile('server/tools.json', { providers: [{ type: 'ask' }], tools: { browser_click: { enabled: false } } });
    const tools = new ToolsConfig(new ServerConfig(file, logger), logger, DANGEROUS);
    tools.addMissing(['browser_click', 'browser_navigate', 'browser_evaluate']);
    const data = readJson(file);
    assert.deepEqual(data.tools, { browser_click: { enabled: false }, browser_evaluate: { enabled: false }, browser_navigate: { enabled: true } });
    assert.deepEqual(data.providers, [{ type: 'ask' }]);
    assert.equal(tools.isEnabled('browser_navigate'), true);
    assert.equal(tools.isEnabled('browser_click'), false);
  });

  test('a value that is not true or false disables the tool', () => {
    const tools = new ToolsConfig(new ServerConfig(tmpFile('server/bad.json', { tools: { browser_click: { enabled: 'yes' } } }), logger), logger, DANGEROUS);
    assert.equal(tools.isEnabled('browser_click'), false);
  });

  test('a disabled tool gets a note and an error with the reason', () => {
    const tools = new ToolsConfig(new ServerConfig(tmpFile('server/reason.json', { tools: { browser_evaluate: { enabled: false } } }), logger), logger, DANGEROUS);
    assert.equal(tools.describe({ name: 'browser_evaluate', description: 'Evaluate.' }).description,
      'DISABLED: this tool is turned off in the configuration. Reason: it runs JavaScript in the web page and can read all data of the page. Evaluate.');
    const result = tools.disabledResult('browser_evaluate');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^### Error\nThe tool browser_evaluate did not run: this tool is turned off in the configuration\./);
    assert.doesNotMatch(result.content[0].text, /upstream|\.json/);
  });
});

// A key-value provider with fixed values. reads: the keys that it gave.
class StubProvider extends KeyValueProvider {
  constructor(name, values, masked = false) {
    super({ name });
    this.values = values;
    this.masked = masked;
    this.reads = [];
  }

  async has(name) {
    return Object.hasOwn(this.values, name);
  }

  async resolve(name) {
    if (this.values[name] instanceof Error) throw this.values[name];
    if (Object.hasOwn(this.values, name)) this.reads.push(name);
    return this.values[name];
  }

  async match(value) {
    return Object.keys(this.values).find((key) => this.values[key] === value);
  }
}

class StubValueProvider extends FillProvider {
  constructor(name, values) {
    super({ name });
    this.values = values;
  }

  async resolve(name) {
    return this.values[name];
  }
}

// An approval provider that gives the answer and records each request.
class StubApproval extends ApprovalProvider {
  constructor(inner, answer) {
    super({ name: 'approve', inner });
    this.masked = inner.masked;
    this.answer = answer;
    this.requests = [];
  }

  async approve(request) {
    this.requests.push(request);
    return this.answer;
  }
}

describe('fill registry', () => {
  const registry = () => new FillRegistry({
    providers: [new StubProvider('first', { email: 'a@first.example' }, true), new StubProvider('second', { email: 'b@second', name: 'Anna' })],
    logger,
  });

  test('the first provider with a value wins; no value gives undefined', async () => {
    const r = registry();
    assert.equal(await r.resolve('email', { host: 'h' }), 'a@first.example');
    assert.equal(await r.resolve('name', { host: 'h' }), 'Anna');
    assert.equal(await r.resolve('phone', { host: 'h' }), undefined);
  });

  test('the provider kinds', () => {
    assert.equal(new StubProvider('a', {}).kind, 'key-value');
    assert.equal(new StubValueProvider('a', {}).kind, 'value');
    assert.equal(new StubApproval(new StubProvider('a', {}), true).kind, 'approval');
  });

  test('one approval for all keys of an approval provider in one fill; the values come after it', async () => {
    const vault = new StubProvider('vault', { username: 'u', password: 'p' }, true);
    const approval = new StubApproval(vault, true);
    const r = new FillRegistry({ providers: [approval, new StubProvider('values', { name: 'Anna', password: 'other' })], logger });
    const values = await r.resolveAll(['username', 'password', 'name'], { host: 'a.example', url: 'https://a.example/x', client: 'claude-code' });
    assert.deepEqual([...values], [['name', 'Anna'], ['username', 'u'], ['password', 'p']]);
    assert.deepEqual(approval.requests, [{ host: 'a.example', keys: ['username', 'password'], client: 'claude-code' }]);
    assert.equal(r.clean('u p Anna'), `${MASK} ${MASK} Anna`);
  });

  test('a refused approval stops the fill; no later provider gives the keys; no value is read', async () => {
    const vault = new StubProvider('vault', { password: 'p' });
    const later = new StubProvider('values', { password: 'other' });
    const r = new FillRegistry({ providers: [new StubApproval(vault, false), later], logger });
    await assert.rejects(r.resolveAll(['password'], { host: 'a.example' }), /was not approved/);
    assert.deepEqual(vault.reads, []);
    assert.deepEqual(later.reads, []);
  });

  test('the discovery mode: no value providers, no approvals', async () => {
    const approval = new StubApproval(new StubProvider('vault', { password: 'p' }), false);
    const r = new FillRegistry({ providers: [new StubValueProvider('ask', { phone: '1' }), approval], logger });
    assert.deepEqual([...await r.resolveAll(['phone', 'password'], {}, { discovery: true })], [['password', 'p']]);
    assert.deepEqual(approval.requests, []);
    assert.equal(await r.resolve('phone', {}), '1');
  });

  test('match: the first key-value provider with the value gives its first key; a masked value goes into the scrub', async () => {
    const vault = new StubProvider('vault', { login: 'anna@x', email: 'anna@x', password: 'p' }, true);
    const r = new FillRegistry({
      providers: [new StubValueProvider('ask', { phone: 'anna@x' }), new StubProvider('values', { name: 'Anna' }), new StubApproval(vault, false)],
      logger,
    });
    assert.equal(await r.match('anna@x', {}), 'login');
    assert.equal(await r.match('Anna', {}), 'name');
    assert.equal(await r.match('nothing', {}), undefined);
    assert.equal(await r.match('', {}), undefined);
    assert.equal(r.clean('anna@x Anna'), `${MASK} Anna`);
  });

  test('a provider error stops the fill', async () => {
    const r = new FillRegistry({ providers: [new StubProvider('bad', { email: new FillError('declined') })], logger });
    await assert.rejects(r.resolve('email', {}), /declined/);
  });

  test('scrubs only the values of masked providers', async () => {
    const r = registry();
    await r.resolveAll(['email', 'name'], {});
    const result = r.scrub({ content: [{ type: 'text', text: '- textbox "Name": Anna a@first.example' }, { type: 'image', data: 'a@first.example' }] });
    assert.equal(result.content[0].text, `- textbox "Name": Anna ${MASK}`);
    assert.equal(result.content[1].data, 'a@first.example');
  });

  test('can log in only with a provider that has a system for the page', () => {
    const vault = new StubProvider('vault', {});
    vault.system = (ctx) => ({ 'a.example': 'System A' })[ctx.host];
    const r = new FillRegistry({ providers: [new StubProvider('values', {}), vault], logger });
    assert.equal(r.canLogIn({ host: 'a.example' }), true);
    assert.equal(r.canLogIn({ host: 'c.example' }), false);
    assert.equal(new FillRegistry({ providers: [new StubProvider('values', {})], logger }).canLogIn({ host: 'a.example' }), false);
  });

  test('loads the providers of server.json; the masked ones; an unknown type is an error', async () => {
    const providersDir = path.join(TOOL_DIR, 'providers-form-fill');
    const r = await FillRegistry.load({ entries: [{ type: 'values', mask: false, settings: {} }, { type: 'ask', mask: true, settings: {} }], providersDir, logger });
    assert.deepEqual(r.providers.map((provider) => provider.name), ['values', 'ask']);
    assert.deepEqual(r.providers.map((provider) => provider.masked), [false, true]);
    await assert.rejects(FillRegistry.load({ entries: [{ type: 'nope', mask: true, settings: {} }], providersDir, logger }), /the provider type "nope"/);
  });

  test('loads an approval provider with its wrapped key-value provider; the mask of the wrapped entry applies', async () => {
    const providersDir = path.join(TOOL_DIR, 'providers-form-fill');
    const load = (settings, mask = true) => FillRegistry.load({ entries: [{ type: settings.type, mask, settings }], providersDir, logger });
    const r = await load({ type: 'approve-https', mask: true, address: '', provider: { type: 'values', mask: false, values: { a: '1' } } });
    assert.equal(r.providers[0].kind, 'approval');
    assert.equal(r.providers[0].inner.name, 'values');
    assert.equal(r.providers[0].masked, false);
    await assert.rejects(load({ type: 'approve-dialog' }), /needs "provider"/);
    await assert.rejects(load({ type: 'approve-dialog', provider: { type: 'ask' } }), /can wrap only a key-value provider/);
    await assert.rejects(load({ type: 'values', provider: { type: 'values' } }), /is not an approval provider/);
  });
});

describe('values provider', () => {
  const provider = new ValuesProvider({ name: 'values', settings: { values: { Name: 'Anna', email: 'anna@x', age: 30 } } });

  test('gives the values of "values"', async () => {
    assert.equal(await provider.resolve('name', { host: 'a.example' }), 'Anna');
    assert.equal(await provider.resolve('email', {}), 'anna@x');
    assert.equal(await provider.resolve('age', {}), '30');
    assert.equal(await provider.resolve('phone', {}), undefined);
    assert.equal(await provider.resolve('constructor', {}), undefined);
    assert.equal(await provider.resolve('NAME', {}), 'Anna');
  });

  test('gives the first key of a value', async () => {
    assert.equal(await provider.match('anna@x'), 'email');
    assert.equal(await provider.match('30'), 'age');
    assert.equal(await provider.match('nobody'), undefined);
  });
});

describe('config folder', () => {
  test('a missing config file is a copy of its template; an existing file stays', () => {
    const dir = path.join(TMP, 'config-folder');
    fs.rmSync(dir, { recursive: true, force: true });
    for (const name of [SERVER_CONFIG, SITES_CONFIG]) {
      const file = configFile(dir, name);
      assert.equal(file, path.join(dir, name));
      assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(CONFIG_TEMPLATES[name], 'utf8'));
      readJson(file);
    }
    fs.writeFileSync(path.join(dir, SITES_CONFIG), '{}\n');
    assert.equal(fs.readFileSync(configFile(dir, SITES_CONFIG), 'utf8'), '{}\n');
    assert.equal(fs.existsSync(configFile(dir, 'other.json')), false);   // no template: no file
  });

  test('the server template has a provider for each provider folder', () => {
    const types = readJson(CONFIG_TEMPLATES[SERVER_CONFIG]).providers.map(({ type }) => type).sort();
    assert.deepEqual(types, fs.readdirSync(path.join(TOOL_DIR, 'providers-form-fill')).sort());
  });
});

describe('vault provider', () => {
  const callLog = path.join(TMP, 'vault-calls.log');
  const sites = sitesOf({ sites: { '127.0.0.1': { credentials: { vault: 'Fixture site' } }, 'missing.example': { credentials: { vault: 'Missing' } } } });
  const make = (vault = 'vault-test') => new VaultProvider({ name: 'vault', settings: { vault }, sites });
  const calls = async (action) => {
    fs.rmSync(callLog, { force: true });
    process.env.FAKE_VAULT_LOG = callLog;
    try {
      await action();
    } finally {
      delete process.env.FAKE_VAULT_LOG;
    }
    return fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  };
  before(() => { process.env.BROWSER_AUTOMATION_X_MCP_VAULT_TOOL = path.join(FAKE_VAULT, 'run.sh'); });
  after(() => { delete process.env.BROWSER_AUTOMATION_X_MCP_VAULT_TOOL; });

  test('selects the system by the credentials of the site', async () => {
    const provider = make();
    assert.equal(await provider.resolve('password', { host: '127.0.0.1', url: 'http://127.0.0.1:8080/login' }), 'Fixture-Pa55-word');
    assert.equal(await provider.resolve('username', { host: '127.0.0.1', url: 'http://127.0.0.1:8080/' }), 'fixture-user');
    assert.equal(await provider.resolve('token', { host: '127.0.0.1', url: 'http://127.0.0.1/' }), undefined);
    assert.equal(await provider.resolve('password', { host: 'unknown.example', url: 'https://unknown.example/' }), undefined);
    assert.equal(await provider.resolve('password', {}), undefined);
  });

  test('asks the vault only for the system of the site, with the vault name', async () => {
    const log = await calls(async () => {
      const provider = make();
      await provider.resolve('password', { host: '127.0.0.1', url: 'http://127.0.0.1/' });
      await provider.resolve('password', { host: 'other.example', url: 'https://other.example/' });
    });
    assert.deepEqual(log, [['--vault', 'vault-test', 'get-system', 'Fixture site'],
      ['--vault', 'vault-test', 'get-secret', 'Fixture site', 'password']]);
  });

  test('gives the first secret name with the value, only in the system of the site; the key has no case', async () => {
    const provider = make();
    const ctx = { host: '127.0.0.1', url: 'http://127.0.0.1/' };
    assert.equal(await provider.match('Fixture-Pa55-word', ctx), 'password');
    assert.equal(await provider.match('fixture-user', ctx), 'username');
    assert.equal(await provider.match('other-token', ctx), undefined);
    assert.equal(await provider.match('fixture-user', { host: 'other.example', url: 'https://other.example/' }), undefined);
    assert.equal(await provider.resolve('PassWord', ctx), 'Fixture-Pa55-word');
    assert.equal(await provider.has('USERNAME', ctx), true);
    assert.equal(await provider.has('token', ctx), false);
  });

  test('needs the vault name; an unknown system is an error of the vault tool', async () => {
    assert.match(await make('').resolve('password', { host: '127.0.0.1', url: 'http://127.0.0.1/' }).catch((e) => e.message),
      /the vault provider needs "vault": "vault-<name>"/);
    assert.match(await make().resolve('password', { host: 'missing.example', url: 'https://missing.example/' }).catch((e) => e.message),
      /the vault tool failed \(get-system\): error: unknown system 'Missing'/);
  });
});

// The fake vault cannot see a change of the real vault tool. This test compares the commands.
describe('vault tool contract', () => {
  const tool = path.resolve(TOOL_DIR, '..', 'auth', process.platform === 'win32' ? 'run.bat' : 'run.sh');
  const help = (...args) => {
    const [command, prefix] = process.platform === 'win32' ? ['cmd', ['/c', tool]] : [tool, []];
    return execFileSync(command, [...prefix, ...args], { encoding: 'utf8', windowsHide: true });
  };

  test('the vault tool has the options and commands of the vault provider', { skip: !fs.existsSync(tool) && `no vault tool at ${tool}` }, () => {
    const usage = help('--help');
    assert.match(usage, /--vault NAME/);
    const commands = usage.match(/\{([a-z,-]+)\}/)[1].split(',');
    for (const command of ['get-system', 'get-secret']) assert.ok(commands.includes(command), `the vault tool has no command ${command}`);
    assert.ok(!commands.includes('list'), 'the vault tool lists its systems');
    assert.match(help('get-system', '--help'), /get-system \[-h\] system/);
    assert.match(help('get-secret', '--help'), /get-secret \[-h\] system key/);
  });
});

describe('ask provider', () => {
  const make = () => new AskProvider({ name: 'ask', settings: { fields: ['phone', 'Name'] } });

  test('asks once for each host and field, and only for the listed fields', async () => {
    const provider = make();
    const asked = [];
    const elicit = async (message, schema) => {
      asked.push(message);
      assert.deepEqual(schema.required, ['value']);
      return { action: 'accept', content: { value: '+48 600 000 000' } };
    };
    assert.equal(await provider.resolve('phone', { host: 'a.example', elicit }), '+48 600 000 000');
    assert.equal(await provider.resolve('phone', { host: 'a.example', elicit }), '+48 600 000 000');
    assert.equal(asked.length, 1);
    assert.match(asked[0], /fills the field "phone" on a\.example/);
    assert.equal(await provider.resolve('email', { host: 'a.example', elicit }), undefined);
  });

  test('does nothing without dialogs; a declined dialog stops the call', async () => {
    const provider = make();
    assert.equal(await provider.resolve('phone', { host: 'a.example' }), undefined);
    await assert.rejects(provider.resolve('phone', { host: 'a.example', elicit: async () => ({ action: 'decline' }) }), /did not give phone \(decline\)/);
  });
});

describe('approve-dialog provider', () => {
  const make = () => new ApproveDialogProvider({ name: 'approve-dialog', inner: new StubProvider('vault', {}), logger });
  const request = { host: 'a.example', keys: ['username', 'password'], client: 'claude-code' };

  test('shows the host, the keys and the client, with the approval timeout; approves only an accepted approval', async () => {
    const asked = [];
    const elicit = (answer) => async (message, schema, timeout) => {
      asked.push({ message, schema, timeout });
      return answer;
    };
    assert.equal(await make().approve(request, { elicit: elicit({ action: 'accept', content: { approve: true } }) }), true);
    assert.match(asked[0].message, /fills username, password on a\.example for claude-code/);
    assert.deepEqual(asked[0].schema.required, ['approve']);
    assert.equal(asked[0].timeout, 15000);
    assert.equal(await make().approve(request, { elicit: elicit({ action: 'accept', content: { approve: false } }) }), false);
    assert.equal(await make().approve(request, { elicit: elicit({ action: 'decline' }) }), false);
    assert.equal(await make().approve(request, { elicit: async () => { throw new Error('timeout'); } }), false);
  });

  test('refuses without dialogs', async () => {
    assert.equal(await make().approve(request, {}), false);
  });
});

describe('approve-https provider', () => {
  const hasOpenssl = (() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  const dir = path.join(TMP, 'approve-https');
  let server;
  let address;
  let fingerprint;
  const requests = [];
  let answer = { approved: true };

  before(async () => {
    if (!hasOpenssl) return;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert,
      '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    fingerprint = new crypto.X509Certificate(fs.readFileSync(cert)).fingerprint256;
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, body: JSON.parse(body || 'null'), auth: req.headers.authorization });
        if (answer === 'hang') return;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    address = `https://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  });

  const make = (settings, options = {}) => new ApproveHttpsProvider({ name: 'approve-https', settings, inner: new StubProvider('vault', {}), logger, ...options });
  const request = { host: 'a.example', keys: ['password'], client: 'claude-code' };

  test('refuses with an empty address or fingerprint, without a connection', async () => {
    assert.equal(await make({ address: '', fingerprint: 'AB' }).approve(request), false);
    assert.equal(await make({ address: 'https://127.0.0.1:1', fingerprint: '' }).approve(request), false);
    assert.equal(await make({ address: 'http://127.0.0.1:1', fingerprint: 'AB' }).approve(request), false);
    assert.equal(normalizeFingerprint('ab:cd:0F'), 'ABCD0F');
  });

  test('sends host, keys and client to /approve with the pinned certificate; no authentication', { skip: !hasOpenssl && 'no openssl' }, async () => {
    requests.length = 0;
    answer = { approved: true };
    assert.equal(await make({ address, fingerprint: fingerprint.toLowerCase() }).approve(request), true);
    assert.deepEqual(requests, [{ method: 'POST', url: '/approve', body: request, auth: undefined }]);
    answer = { approved: false };
    assert.equal(await make({ address: `${address}/`, fingerprint }).approve(request), false);
  });

  test('sends nothing to an other certificate; refuses without an answer in time', { skip: !hasOpenssl && 'no openssl' }, async () => {
    requests.length = 0;
    answer = { approved: true };
    assert.equal(await make({ address, fingerprint: 'AA'.repeat(32) }).approve(request), false);
    assert.deepEqual(requests, []);
    answer = 'hang';
    const started = Date.now();
    assert.equal(await make({ address, fingerprint }, { timeout: 300 }).approve(request), false);
    assert.ok(Date.now() - started < 2000);
  });
});

describe('logger', () => {
  test('redacts typed text and form values', () => {
    assert.deepEqual(redact({ text: 'secret', element: 'Name', fields: [{ name: 'A', value: 'x {{a}}' }] }),
      { text: '<redacted 6 chars>', element: 'Name', fields: [{ name: 'A', value: '<redacted 7 chars>' }] });
  });

  test('a short URL cuts long path segments and query values', () => {
    assert.equal(compactUrl('https://www.amazon.pl/ax/claim?arb=7a415ec9-1e5a&openid.mode=checkid_setup#top'),
      'www.amazon.pl/ax/claim?arb=7a41…&openid.mode=chec…');
    assert.equal(compactUrl('http://127.0.0.1:8080/a/abcdefghijklmnopqrstuvwxyz0123/b'), '127.0.0.1:8080/a/abcdefghijklmnopqrstuvwx…/b');
    assert.equal(compactUrl('about:blank'), 'about:blank');
  });

  test('a line of the human log has the time, the event and the fields, without level and session', () => {
    const ts = new Date(2026, 10, 3, 20, 18, 8, 16).toISOString();
    const line = formatLine({ ts, level: 'info', session: '42', event: 'page_opened', url: 'https://a.example/x?q=123456', via: 'tool' });
    assert.equal(line, '20:18:08 page_opened a.example/x?q=1234… via=tool');
    const long = formatLine({ ts, level: 'info', session: '42', event: 'fields_discovered', new: Array(40).fill('username=input[name="u"]'), stack: 'x' });
    assert.equal(long.length, LOG_LINE_MAX);
    assert.ok(long.endsWith('…'));
    assert.doesNotMatch(long, /stack/);
  });

  test('two files for each start in the folder of the client; the newest pairs stay', () => {
    const dir = path.join(ASSETS_DIR, 'test-unit', 'logs');
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(folderName('Claude Code'), 'claude-code');
    assert.equal(folderName(undefined), 'unknown');
    const folder = path.join(dir, 'kilo');
    fs.mkdirSync(folder, { recursive: true });
    for (let i = 0; i < 6; i++) {
      for (const suffix of ['.log', '.log.json']) {
        const file = path.join(folder, `01-0${i}_000000_1${suffix}`);
        fs.writeFileSync(file, '');
        fs.utimesSync(file, i + 1, i + 1);
      }
    }
    const logger = createLogger({ dir, session: '7' });
    logger.info('early', { a: 1 });
    const files = logger.open('KILO');
    logger.info('late', { url: 'https://a.example/' });
    assert.match(path.basename(files.text), /^\d\d-\d\d_\d{6}_7\.log$/);
    assert.equal(fs.readdirSync(folder).length, 10);
    assert.ok(!fs.existsSync(path.join(folder, '01-00_000000_1.log')));
    const json = fs.readFileSync(files.json, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(json.map((entry) => entry.event), ['early', 'late']);
    assert.match(fs.readFileSync(files.text, 'utf8'), /^\d\d:\d\d:\d\d early a=1\n\d\d:\d\d:\d\d late a\.example\/\n$/);
  });
});
