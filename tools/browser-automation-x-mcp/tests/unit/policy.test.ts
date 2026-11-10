// Unit tests of the shared parts: server.json, hosts.json, host access, tool switches, the plugin
// host and the plugins.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HostsFile, covers, hostChain, rootDomain } from '../../src/hosts.ts';
import { SiteAccessPolicy } from '../../src/hosts/host-policy.ts';
import { hostOfUrl } from '../../src/hosts/patterns.ts';
import type { JsonObject } from '../../src/json.ts';
import { readJson } from '../../src/json.ts';
import { FileLogger, LOG_LINE_MAX, compactUrl, folderName, formatLine, redact } from '../../src/logger.ts';
import { ASSETS_DIR, CONFIG_TEMPLATES, HOSTS_CONFIG, PLUGINS_DIR, SERVER_CONFIG, TOOL_DIR, configFile } from '../../src/paths.ts';
import type { ApprovalPlugin, ApprovalRequest, Dialog, DialogAnswer, DialogForm } from '../../src/plugins/approval-plugin.ts';
import { ApprovalError, FillError, MASK, PluginHost } from '../../src/plugins/host.ts';
import type { SourceInstance } from '../../src/plugins/host.ts';
import type { KeyValueSource } from '../../src/plugins/key-value-source.ts';
import { SourceError } from '../../src/plugins/key-value-source.ts';
import { pageInfo } from '../../src/plugins/page-info.ts';
import type { PageInfo, PluginContext } from '../../src/plugins/plugin.ts';
import { ServerConfigFile, ToolsConfig, parsePlugins } from '../../src/server-config.ts';
import ApproveDialog from '../../plugins/approval-plugin/approve-dialog/index.ts';
import ApproveHttps, { normalizeFingerprint } from '../../plugins/approval-plugin/approve-https/index.ts';
import { DiscoveryFile } from '../../plugins/common/discovery/index.ts';
import ValuesSource from '../../plugins/key-value-source/values/index.ts';
import VaultSource from '../../plugins/key-value-source/vault/index.ts';
import Propagate from '../../plugins/match-strategy/propagate/index.ts';

const FAKE_VAULT = path.join(TOOL_DIR, 'tests', 'fixtures', 'fake-vault');

// The server gives this map. The tests use their own, in the same form.
const DANGEROUS = { browser_evaluate: 'it runs JavaScript in the web page and can read all data of the page' };

const TMP = path.join(ASSETS_DIR, 'test-unit');
const logger = new FileLogger({ dir: path.join(ASSETS_DIR, 'test-logs', 'unit'), level: 'error' });

function tmpFile(name: string, data?: unknown): string {
  const file = path.join(TMP, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (data === undefined) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

function hostsOf(data: unknown): HostsFile {
  return new HostsFile(tmpFile(`hosts/${Math.random().toString(16).slice(2)}.json`, data));
}

// The context of a plugin instance in a test.
function contextOf(name: string, config: JsonObject): PluginContext {
  return { name, config, configDir: TMP, logger: { info(): void {}, error(): void {} } };
}

const page = (url: string): PageInfo => pageInfo(url);

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

describe('hosts.json: access', () => {
  test('a deny above wins over an allow below; else the nearest node; else defaultAccess', async () => {
    const sites = hostsOf({ defaultAccess: 'deny', hosts: {
      'evil.example': { access: 'deny', subdomains: { 'www.evil.example': { access: 'allow' } } },
      'good.example': { access: 'allow', subdomains: { 'no.good.example': { access: 'deny' } } },
      'pages.example': {},
    } });
    assert.deepEqual(sites.access('www.evil.example'), { allowed: false, reason: 'the host www.evil.example is denied', site: 'evil.example' });
    assert.equal(sites.access('a.good.example').allowed, true);
    assert.deepEqual(sites.access('other.org'), { allowed: false, reason: 'the host other.org is not allowed' });
    assert.equal(sites.access('pages.example').allowed, false, 'a site without access gets defaultAccess');
    assert.deepEqual(sites.access('a.no.good.example'), { allowed: false, reason: 'the host a.no.good.example is denied', site: 'no.good.example' });
  });

  test('the root domain of a host: the Public Suffix List, also private suffixes; an IP or localhost stays', () => {
    assert.equal(rootDomain('www.amazon.pl'), 'amazon.pl');
    assert.equal(rootDomain('a.b.amazon.co.uk'), 'amazon.co.uk');
    assert.equal(rootDomain('user.github.io'), 'user.github.io');
    assert.equal(rootDomain('127.0.0.1'), '127.0.0.1');
    assert.equal(rootDomain('localhost'), 'localhost');
  });

  test('a host key must be a root domain; a subdomain key must be under its parent; a node has only access and subdomains', () => {
    assert.throws(() => hostsOf({ hosts: { 'www.amazon.pl': {} } }).load(), /"www.amazon.pl" is not a root domain; put it into "subdomains" of "amazon.pl"/);
    assert.throws(() => hostsOf({ hosts: { 'amazon.pl': { subdomains: { 'www.other.pl': {} } } } }).load(), /"www.other.pl" in "subdomains" is not a subdomain of "amazon.pl"/);
    for (const key of ['forms', 'login', 'provider-config', 'credentials']) {
      assert.throws(() => hostsOf({ hosts: { 'amazon.pl': { [key]: [] } } }).load(), new RegExp(`has "${key}"; a node has only "access" and "subdomains"`));
    }
    assert.throws(() => hostsOf({ sites: {} }).load(), /"sites" is not known/);
  });

  test('a missing file allows each host; a wrong defaultAccess is an error', () => {
    assert.equal(new HostsFile(tmpFile('hosts/missing.json')).access('a.example').allowed, true);
    assert.throws(() => hostsOf({ defaultAccess: 'maybe' }).load(), /defaultAccess must be "allow" or "deny"/);
  });

  test('the host policy checks the access; onOpened gets only the allowed hosts', async () => {
    const recorded: string[] = [];
    const hosts = hostsOf({ hosts: { 'evil.example': { access: 'deny' } } });
    const policy = new SiteAccessPolicy({ hosts, onOpened: (host: string): void => { recorded.push(host); } });
    assert.equal((await policy.check('https://www.evil.example/x')).reason, 'the host www.evil.example is denied');
    assert.equal((await policy.check('https://good.example/')).allowed, true);
    assert.equal((await policy.check('about:blank')).allowed, true);
    await policy.opened('https://www.evil.example/');
    await policy.opened('https://good.example/');
    assert.deepEqual(recorded, ['good.example']);
    await new SiteAccessPolicy({ hosts }).opened('https://good.example/');
  });

  test('record: the root domain of an allowed host gets "access": "allow"; an access of the file stays', () => {
    const file = tmpFile('hosts/record.json', { defaultAccess: 'allow', hosts: { 'evil.example': { access: 'deny' }, 'kept.example': { access: 'deny', subdomains: {} } } });
    const hosts = new HostsFile(file);
    assert.equal(hosts.record('www.new.example'), true);
    assert.equal(hosts.record('www.new.example'), false);
    assert.equal(hosts.record('www.evil.example'), false);
    assert.deepEqual((readJson(file) as { hosts: unknown }).hosts, { 'evil.example': { access: 'deny' }, 'kept.example': { access: 'deny', subdomains: {} }, 'new.example': { access: 'allow' } });
  });

  test('the chain of a host for the plugins: the host, then its parents, to the root domain', () => {
    assert.deepEqual(hostChain('a.b.amazon.co.uk'), ['a.b.amazon.co.uk', 'b.amazon.co.uk', 'amazon.co.uk']);
    assert.deepEqual(hostChain('127.0.0.1'), ['127.0.0.1']);
    assert.deepEqual(hostChain(undefined), []);
    assert.deepEqual(pageInfo('https://WWW.Example.com/x').hosts, ['www.example.com', 'example.com']);
  });
});

describe('server.json', () => {
  const entry = (name: string, plugin: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name, plugin, description: `the ${plugin}`, config: {}, ...extra });

  test('the plugin instances by category, in the order of the file; mask and approval of a source', () => {
    const config = new ServerConfigFile(tmpFile('server/plugins.json', { recordHosts: true, plugins: {
      'key-value-source': [entry('v', 'values', { mask: false }), entry('vault', 'vault', { enabled: false, approval: { plugin: 'approve-dialog' } })],
      'dom-classifier': [entry('d', 'discovery'), entry('h', 'heuristic')],
    } }));
    const plugins = config.plugins();
    assert.deepEqual(plugins['key-value-source'].map(({ name, mask, enabled }) => [name, mask, enabled]), [['v', false, true], ['vault', true, false]]);
    assert.deepEqual(plugins['key-value-source'][1]?.approval, { plugin: 'approve-dialog', enabled: true, config: {} });
    assert.deepEqual(plugins['dom-classifier'].map(({ name }) => name), ['d', 'h']);
    assert.deepEqual(plugins['match-strategy'], []);
    assert.equal(config.recordHosts(), true);
    assert.equal(new ServerConfigFile(tmpFile('server/empty.json', {})).recordHosts(), false);
  });

  test('an instance needs name, plugin, description and config; names are unique; approval only for a source', () => {
    const bad = (plugins: unknown): string => {
      try {
        parsePlugins('server.json', plugins);
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    assert.match(bad({ 'key-value-source': [{ plugin: 'values', description: 'd', config: {} }] }), /needs "name"/);
    assert.match(bad({ 'key-value-source': [{ name: 'a', plugin: 'values', config: {} }] }), /needs "description"/);
    assert.match(bad({ 'key-value-source': [{ name: 'a', plugin: 'values', description: 'd' }] }), /needs "config"/);
    assert.match(bad({ 'key-value-source': [entry('a', 'values')], 'match-strategy': [entry('a', 'propagate')] }), /two instances have the name "a"/);
    assert.match(bad({ 'dom-classifier': [entry('a', 'heuristic', { approval: { plugin: 'approve-dialog' } })] }), /is not a key-value-source; remove "approval"/);
    assert.match(bad({ 'approval-plugin': [] }), /unknown category "approval-plugin"/);
    assert.match(bad([]), /"plugins" must be an object/);
    assert.throws(() => new ServerConfigFile(tmpFile('server/old.json', { providers: [] })).plugins(), /"providers" is removed; use "plugins"/);
  });

  test('adds the missing tools with defaults; keeps the user values and the other keys', () => {
    const file = tmpFile('server/tools.json', { recordHosts: true, tools: { browser_click: { enabled: false } } });
    const tools = new ToolsConfig(new ServerConfigFile(file), logger, DANGEROUS);
    tools.addMissing(['browser_click', 'browser_navigate', 'browser_evaluate']);
    const data = readJson(file) as { tools: unknown; recordHosts: unknown };
    assert.deepEqual(data.tools, { browser_click: { enabled: false }, browser_evaluate: { enabled: false }, browser_navigate: { enabled: true } });
    assert.equal(data.recordHosts, true);
    assert.equal(tools.isEnabled('browser_navigate'), true);
    assert.equal(tools.isEnabled('browser_click'), false);
  });

  test('a value that is not true or false disables the tool', () => {
    const tools = new ToolsConfig(new ServerConfigFile(tmpFile('server/bad.json', { tools: { browser_click: { enabled: 'yes' } } })), logger, DANGEROUS);
    assert.equal(tools.isEnabled('browser_click'), false);
  });

  test('a disabled tool gets a note and an error with the reason', () => {
    const tools = new ToolsConfig(new ServerConfigFile(tmpFile('server/reason.json', { tools: { browser_evaluate: { enabled: false } } })), logger, DANGEROUS);
    assert.equal(tools.describe({ name: 'browser_evaluate', description: 'Evaluate.', inputSchema: { type: 'object' } }).description,
      'DISABLED: this tool is turned off in the configuration. Reason: it runs JavaScript in the web page and can read all data of the page. Evaluate.');
    const result = tools.disabledResult('browser_evaluate');
    assert.equal(result.isError, true);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    assert.match(text, /^### Error\nThe tool browser_evaluate did not run: this tool is turned off in the configuration\./);
    assert.doesNotMatch(text, /upstream|\.json/);
  });
});

// A key-value-source with fixed values. reads: the keys that it gave.
class StubSource implements KeyValueSource {
  readonly entries: Record<string, string | Error>;
  readonly reads: string[] = [];

  constructor(entries: Record<string, string | Error>) {
    this.entries = entries;
  }

  async keys(): Promise<readonly string[]> {
    return Object.keys(this.entries);
  }

  async values(keys: readonly string[]): Promise<Readonly<Record<string, string>>> {
    const result: Record<string, string> = {};
    for (const key of keys) {
      const value = this.entries[key];
      if (value instanceof Error) throw value;
      if (value === undefined) continue;
      this.reads.push(key);
      result[key] = value;
    }
    return result;
  }

  async keysOf(value: string): Promise<readonly string[]> {
    return Object.keys(this.entries).filter((key) => this.entries[key] === value);
  }
}

// An approval plugin that gives the answer and records each request.
class StubApproval implements ApprovalPlugin {
  readonly answer: boolean;
  readonly requests: ApprovalRequest[] = [];

  constructor(answer: boolean) {
    this.answer = answer;
  }

  async approve(request: ApprovalRequest): Promise<boolean> {
    this.requests.push(request);
    return this.answer;
  }
}

describe('plugin host', () => {
  const source = (name: string, plugin: KeyValueSource, masked: boolean, approval?: ApprovalPlugin): SourceInstance => ({ name, plugin, masked, approval: approval ? { name: `${name}.approval`, plugin: approval } : undefined });
  const hostOf = (sources: SourceInstance[]): PluginHost => new PluginHost({ sources, classifiers: [], strategies: [], pageScripts: [], logger });
  const request = { page: page('https://a.example/login'), client: 'claude-code', dialog: undefined };

  test('the first source with the key gives the value; the case of a key has no effect; the keys without duplicates', async () => {
    const host = hostOf([source('vault', new StubSource({ password: 'p1' }), true), source('values', new StubSource({ password: 'p2', Name: 'Anna' }), false)]);
    assert.deepEqual([...await host.values(['password', 'name', 'phone'], request)], [['password', 'p1'], ['name', 'Anna']]);
    assert.deepEqual(await host.keys(request.page), ['password', 'Name']);
  });

  test('one approval for all keys of a source in one fill; the values come after it', async () => {
    const approval = new StubApproval(true);
    const vault = new StubSource({ username: 'u', password: 'p' });
    const host = hostOf([source('vault', vault, true, approval), source('values', new StubSource({ name: 'Anna' }), false)]);
    assert.deepEqual([...await host.values(['username', 'password', 'name'], request)], [['username', 'u'], ['password', 'p'], ['name', 'Anna']]);
    assert.deepEqual(approval.requests, [{ host: 'a.example', keys: ['username', 'password'], client: 'claude-code' }]);
  });

  test('a refused approval stops the fill; no later source gives the keys; no value is read', async () => {
    const approval = new StubApproval(false);
    const vault = new StubSource({ password: 'p' });
    const values = new StubSource({ password: 'other' });
    const host = hostOf([source('vault', vault, true, approval), source('values', values, false)]);
    await assert.rejects(host.values(['password'], request), ApprovalError);
    assert.deepEqual([vault.reads, values.reads], [[], []]);
  });

  test('a source error stops the fill', async () => {
    const host = hostOf([source('vault', new StubSource({ password: new SourceError('the vault tool failed') }), true)]);
    await assert.rejects(host.values(['password'], request), FillError);
  });

  test('keysOf: all keys of all sources in order; a value of a masked source goes into the scrub', async () => {
    const host = hostOf([source('vault', new StubSource({ username: 'a@x', email: 'a@x' }), true), source('values', new StubSource({ mail: 'a@x', name: 'Anna' }), false)]);
    assert.deepEqual(await host.keysOf('a@x', request.page), ['username', 'email', 'mail']);
    assert.deepEqual(await host.keysOf('Anna', request.page), ['name']);
    assert.deepEqual(await host.keysOf('', request.page), []);
    assert.equal(host.clean('to a@x and Anna'), `to ${MASK} and Anna`);
  });

  test('scrubs only the values of masked sources', async () => {
    const host = hostOf([source('vault', new StubSource({ email: 'a@first.example' }), true), source('values', new StubSource({ name: 'Anna' }), false)]);
    await host.values(['email', 'name'], request);
    const result = host.scrub({ content: [{ type: 'text', text: '- textbox "Name": Anna a@first.example' }, { type: 'image', data: 'a@first.example', mimeType: 'image/png' }] });
    const [text, image] = result.content;
    assert.equal(text?.type === 'text' ? text.text : undefined, `- textbox "Name": Anna ${MASK}`);
    assert.equal(image?.type === 'image' ? image.data : undefined, 'a@first.example');
  });

  test('loads the instances that are on; the approval of a source; "enabled": false turns the approval off; an unknown plugin is an error', async () => {
    const entries = (approvalEnabled: boolean): ReturnType<typeof parsePlugins> => parsePlugins('server.json', {
      'key-value-source': [
        { name: 'values', plugin: 'values', description: 'd', mask: false, config: { values: { a: '1' } }, approval: { plugin: 'approve-dialog', enabled: approvalEnabled } },
        { name: 'off', plugin: 'values', description: 'd', enabled: false, config: {} },
      ],
      'dom-classifier': [{ name: 'heuristic', plugin: 'heuristic', description: 'd', config: {} }],
      'match-strategy': [{ name: 'propagate', plugin: 'propagate', description: 'd', config: {} }],
    });
    const host = await PluginHost.load({ entries: entries(true), pluginsDir: PLUGINS_DIR, configDir: TMP, logger });
    assert.deepEqual(host.sources.map((s) => [s.name, s.masked, s.approval?.name]), [['values', false, 'values.approval']]);
    assert.deepEqual([host.classifiers.map((c) => c.name), host.strategies.map((m) => m.name), host.pageScripts.length], [['heuristic'], ['propagate'], 0]);
    assert.equal((await PluginHost.load({ entries: entries(false), pluginsDir: PLUGINS_DIR, configDir: TMP, logger })).sources[0]?.approval, undefined);
    const unknown = parsePlugins('server.json', { 'match-strategy': [{ name: 'x', plugin: 'nope', description: 'd', config: {} }] });
    await assert.rejects(PluginHost.load({ entries: unknown, pluginsDir: PLUGINS_DIR, configDir: TMP, logger }), /the plugin "nope" of server.json is not in plugins\/match-strategy\//);
    const wrong = parsePlugins('server.json', { 'key-value-source': [{ name: 'x', plugin: 'values', description: 'd', config: {}, approval: { plugin: 'values' } }] });
    await assert.rejects(PluginHost.load({ entries: wrong, pluginsDir: PLUGINS_DIR, configDir: TMP, logger }), /is not in plugins\/approval-plugin\//);
  });
});

describe('values source', () => {
  const source = new ValuesSource(contextOf('values', { values: { Name: 'Anna', email: 'anna@x', age: 30, mail: 'anna@x' } }));

  test('gives the values of "values"; the case of a key has no effect; the same keys on each page', async () => {
    assert.deepEqual(await source.values(['name', 'EMAIL', 'age', 'phone', 'constructor']), { name: 'Anna', EMAIL: 'anna@x', age: '30' });
    assert.deepEqual(await source.keys(), ['name', 'email', 'age', 'mail']);
  });

  test('gives all keys of a value', async () => {
    assert.deepEqual(await source.keysOf('anna@x'), ['email', 'mail']);
    assert.deepEqual(await source.keysOf('nobody'), []);
  });
});

describe('propagate match-strategy', () => {
  test('the key of a field is its hint, if a source has the key; the case has no effect', async () => {
    const matches = await new Propagate().match([{ ref: '0:1', hint: 'Password' }, { ref: '0:2', hint: 'q' }], ['username', 'password']);
    assert.deepEqual(matches, [{ ref: '0:1', key: 'password' }]);
  });
});

describe('discovery file', () => {
  test('the forms of the host, then of its parents; the login links of the chain without duplicates; a wrong entry is an error', () => {
    const file = new DiscoveryFile(tmpFile('discovery/forms.json', { hosts: {
      'example.com': {
        forms: [{ fields: { '#root': 'username' } }],
        login: ['#signin', { css: 'a', text: 'Sign in' }],
        subdomains: { 'login.example.com': { forms: [{ fields: { '#user': 'username' }, submit: ['#next', 'enter'] }, { fields: {} }], login: ['#signin'] } },
      },
    } }));
    assert.deepEqual(file.forPage(page('https://login.example.com/a')), {
      forms: [{ fields: { '#user': 'username' }, submit: ['#next', 'enter'] }, { fields: { '#root': 'username' } }],
      logins: ['#signin', { css: 'a', text: 'Sign in' }],
    });
    assert.deepEqual(file.forPage(page('https://other.example/')), { forms: [], logins: [] });
    assert.throws(() => new DiscoveryFile(tmpFile('discovery/bad.json', { hosts: { 'a.example': { forms: [{ submit: [] }] } } })).load(), /form 1 needs "fields"/);
    assert.throws(() => new DiscoveryFile(tmpFile('discovery/bad2.json', { hosts: { 'a.example': { login: [{ css: 'a' }] } } })).load(), /"login" must be an array of matchers/);
  });
});

describe('config folder', () => {
  test('a missing config file is a copy of its template; an existing file stays', () => {
    const dir = path.join(TMP, 'config-folder');
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(fs.readFileSync(configFile(dir, SERVER_CONFIG), 'utf8'), fs.readFileSync(CONFIG_TEMPLATES[SERVER_CONFIG] ?? '', 'utf8'));
    fs.writeFileSync(path.join(dir, HOSTS_CONFIG), '{}\n');
    assert.equal(fs.readFileSync(configFile(dir, HOSTS_CONFIG), 'utf8'), '{}\n');
    assert.equal(fs.existsSync(configFile(dir, 'other.json')), false);   // no template: no file
  });

  test('the server template has an instance of each plugin, except the approval plugins; each instance has a description', () => {
    const template = readJson(CONFIG_TEMPLATES[SERVER_CONFIG] ?? '') as { plugins: unknown };
    const entries = parsePlugins('server.template.json', template.plugins);
    for (const category of ['key-value-source', 'dom-classifier', 'match-strategy', 'page-script'] as const) {
      const plugins = entries[category].map(({ plugin }) => plugin).sort();
      const folders = fs.readdirSync(path.join(PLUGINS_DIR, category)).sort();
      assert.deepEqual(plugins, folders, category);
    }
  });
});

describe('vault source', () => {
  const callLog = path.join(TMP, 'vault-calls.log');
  const vaultFile = tmpFile('vault/vault.json', { hosts: {
    '127.0.0.1': { system: 'Fixture site' },
    'example.com': { system: 'Example', subdomains: { 'missing.example.com': { system: 'Missing' } } },
  } });
  const make = (vault: string = 'vault-test'): VaultSource => new VaultSource(contextOf('vault', { vault, file: path.relative(TMP, vaultFile) }));
  const calls = async (action: () => Promise<unknown>): Promise<unknown[]> => {
    fs.rmSync(callLog, { force: true });
    process.env.FAKE_VAULT_LOG = callLog;
    try {
      await action();
    } finally {
      delete process.env.FAKE_VAULT_LOG;
    }
    return fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown) : [];
  };
  before(() => { process.env.BROWSER_AUTOMATION_X_MCP_VAULT_TOOL = path.join(FAKE_VAULT, 'run.sh'); });
  after(() => { delete process.env.BROWSER_AUTOMATION_X_MCP_VAULT_TOOL; });

  test('the system of a page: the nearest node of the file with a system; the keys are its secret names', async () => {
    const source = make();
    assert.deepEqual(await source.keys(page('http://127.0.0.1:8080/login')), ['username', 'password']);
    assert.deepEqual(await source.values(['PassWord', 'username', 'token'], page('http://127.0.0.1:8080/')), { PassWord: 'Fixture-Pa55-word', username: 'fixture-user' });
    assert.deepEqual(await source.keys(page('https://unknown.example/')), []);
    assert.deepEqual(await source.keys(page('about:blank')), []);
  });

  test('asks the vault only for the system of the page, with the vault name', async () => {
    const log = await calls(async () => {
      const source = make();
      await source.values(['password'], page('http://127.0.0.1/'));
      await source.values(['password'], page('https://other.example/'));
    });
    assert.deepEqual(log, [['--vault', 'vault-test', 'get-system', 'Fixture site'],
      ['--vault', 'vault-test', 'get-secret', 'Fixture site', 'password']]);
  });

  test('keysOf gives each secret name with the value, only in the system of the page', async () => {
    const source = make();
    assert.deepEqual(await source.keysOf('Fixture-Pa55-word', page('http://127.0.0.1/')), ['password']);
    assert.deepEqual(await source.keysOf('other-token', page('http://127.0.0.1/')), []);
    assert.deepEqual(await source.keysOf('fixture-user', page('https://other.example/')), []);
  });

  test('needs the vault name and the file; an unknown system is an error of the vault tool', async () => {
    assert.throws(() => make(''), /needs "vault": "vault-<name>"/);
    assert.throws(() => new VaultSource(contextOf('vault', { vault: 'vault-test' })), /needs "file"/);
    await assert.rejects(make().keys(page('https://missing.example.com/')), /the vault tool failed \(get-system\): error: unknown system 'Missing'/);
  });

  test('a missing file is a new empty file', async () => {
    const file = tmpFile('vault/new.json');
    const source = new VaultSource(contextOf('vault', { vault: 'vault-test', file: path.relative(TMP, file) }));
    assert.deepEqual(readJson(file), { hosts: {} });
    assert.deepEqual(await source.keys(page('http://127.0.0.1/')), []);
  });
});

// The fake vault cannot see a change of the real vault tool. This test compares the commands.
describe('vault tool contract', () => {
  const tool = path.resolve(TOOL_DIR, '..', 'auth', 'run.sh');
  const help = (...args: string[]): string => {
    return execFileSync(tool, args, { encoding: 'utf8' });
  };

  test('the vault tool has the options and commands of the vault provider', { skip: !fs.existsSync(tool) && `no vault tool at ${tool}` }, () => {
    const usage = help('--help');
    assert.match(usage, /--vault NAME/);
    const commands = (usage.match(/\{([a-z,-]+)\}/)?.[1] ?? '').split(',');
    for (const command of ['get-system', 'get-secret']) assert.ok(commands.includes(command), `the vault tool has no command ${command}`);
    assert.ok(!commands.includes('list'), 'the vault tool lists its systems');
    assert.match(help('get-system', '--help'), /get-system \[-h\] system/);
    assert.match(help('get-secret', '--help'), /get-secret \[-h\] system key/);
  });
});

describe('approve-dialog plugin', () => {
  const make = (): ApproveDialog => new ApproveDialog(contextOf('approve-dialog', {}));
  const request = { host: 'a.example', keys: ['username', 'password'], client: 'claude-code' };

  test('shows the host, the keys and the client, with the approval timeout; approves only an accepted approval', async () => {
    const asked: { message: string; form: DialogForm; timeout: number }[] = [];
    const dialog = (answer: DialogAnswer): Dialog => ({
      ask: async (message: string, form: DialogForm, timeout: number): Promise<DialogAnswer> => {
        asked.push({ message, form, timeout });
        return answer;
      },
    });
    assert.equal(await make().approve(request, dialog({ action: 'accept', content: { approve: true } })), true);
    assert.match(asked[0]?.message ?? '', /fills username, password on a\.example for claude-code/);
    assert.deepEqual(asked[0]?.form.required, ['approve']);
    assert.equal(asked[0]?.timeout, 15000);
    assert.equal(await make().approve(request, dialog({ action: 'accept', content: { approve: false } })), false);
    assert.equal(await make().approve(request, dialog({ action: 'decline' })), false);
    assert.equal(await make().approve(request, { ask: async () => { throw new Error('timeout'); } }), false);
  });

  test('refuses without dialogs', async () => {
    assert.equal(await make().approve(request, undefined), false);
  });
});

describe('approve-https plugin', () => {
  const hasOpenssl = ((): boolean => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  const dir = path.join(TMP, 'approve-https');
  let server: https.Server | undefined;
  let address = '';
  let fingerprint = '';
  const requests: unknown[] = [];
  let answer: unknown = { approved: true };

  before(async () => {
    if (!hasOpenssl) return;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert,
      '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    fingerprint = new crypto.X509Certificate(fs.readFileSync(cert)).fingerprint256;
    const created = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, body: JSON.parse(body || 'null'), auth: req.headers.authorization });
        if (answer === 'hang') return;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      });
    });
    server = created;
    await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', () => resolve()));
    address = `https://127.0.0.1:${(created.address() as AddressInfo).port}`;
  });
  after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); });
  });

  const make = (config: JsonObject, { timeout }: { timeout?: number } = {}): ApproveHttps => {
    if (timeout) process.env.BROWSER_AUTOMATION_X_MCP_APPROVAL_TIMEOUT = String(timeout);
    try {
      return new ApproveHttps(contextOf('approve-https', config));
    } finally {
      delete process.env.BROWSER_AUTOMATION_X_MCP_APPROVAL_TIMEOUT;
    }
  };
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
    const logger = new FileLogger({ dir, session: '7' });
    logger.info('early', { a: 1 });
    const files = logger.open('KILO');
    assert.ok(files);
    logger.info('late', { url: 'https://a.example/' });
    assert.match(path.basename(files.text), /^\d\d-\d\d_\d{6}_7\.log$/);
    assert.equal(fs.readdirSync(folder).length, 10);
    assert.ok(!fs.existsSync(path.join(folder, '01-00_000000_1.log')));
    const json = fs.readFileSync(files.json, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event: string });
    assert.deepEqual(json.map((entry) => entry.event), ['early', 'late']);
    assert.match(fs.readFileSync(files.text, 'utf8'), /^\d\d:\d\d:\d\d early a=1\n\d\d:\d\d:\d\d late a\.example\/\n$/);
  });
});
