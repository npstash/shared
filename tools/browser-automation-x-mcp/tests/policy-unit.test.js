// Unit tests of the shared parts: INI files, host patterns and lists, tool switches, form fields, fill providers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ASSETS_DIR, CONFIG_TEMPLATES, TOOL_DIR, configFile } from '../src/paths.js';
import { FillError, FillProvider } from '../src/fill/provider.js';
import { FieldsConfig, urlMatches, urlPattern } from '../src/fill/fields.js';
import { FillRegistry, MASK } from '../src/fill/registry.js';
import { FileAllowProvider } from '../src/hosts/file-allow-provider.js';
import { HostPolicy } from '../src/hosts/host-policy.js';
import { HostsFile } from '../src/hosts/hosts-file.js';
import { bySpecificity, hostMatches, hostOfUrl } from '../src/hosts/patterns.js';
import { formatIni, parseIni, readIni } from '../src/ini.js';
import { createLogger, redact } from '../src/logger.js';
import { ToolsConfig } from '../src/tools-config.js';
import AskProvider from '../providers-form-fill/ask/index.js';
import IniProvider from '../providers-form-fill/ini/index.js';
import VaultProvider from '../providers-form-fill/vault/index.js';

const FAKE_VAULT = path.join(TOOL_DIR, 'tests', 'fixtures', 'fake-vault');

// A facade gives this map. The tests use their own, in the form of the Playwright facade.
const DANGEROUS = { browser_evaluate: 'it runs JavaScript in the web page and can read all data of the page' };

const TMP = path.join(ASSETS_DIR, 'test-unit');
const logger = createLogger({ file: path.join(ASSETS_DIR, 'test-logs', 'unit.log'), level: 'error' });

function tmpFile(name, text) {
  const file = path.join(TMP, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (text === undefined) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, text);
  return file;
}

describe('ini', () => {
  test('reads sections, values, plain lines and the header', () => {
    const ini = parseIni('# head\n; more\n[a]\nk = v = w\n; skip\nplain\n[b]\n\n[a]\nx=1\n');
    assert.deepEqual(ini.header, ['# head', '; more']);
    assert.deepEqual(ini.sections.get('a'), [{ key: 'k', value: 'v = w' }, { key: 'plain' }, { key: 'x', value: '1' }]);
    assert.deepEqual(ini.sections.get('b'), []);
  });

  test('refuses a line before the first section', () => {
    assert.throws(() => parseIni('k = v\n'), /before the first section/);
  });

  test('writes sections', () => {
    assert.equal(formatIni(['# h'], [['a', ['x = 1']], ['b', []]]), '# h\n\n[a]\nx = 1\n\n[b]\n');
  });
});

describe('host patterns', () => {
  const cases = [
    ['*', 'any.host', true],
    ['example.com', 'example.com', true],
    ['example.com', 'www.example.com', false],
    ['*.example.com', 'www.example.com', true],
    ['*.example.com', 'a.b.example.com', true],
    ['*.example.com', 'example.com', false],
    ['*.example.com', 'badexample.com', false],
    ['Example.COM', 'example.com.', true],
    ['192.168.1.*', '192.168.1.20', true],
    ['192.168.1.*', '192.168.2.20', false],
    ['192.168.*.*', '192.168.7.1', true],
    ['192.168.1.*', 'example.com', false],
    ['::1', '[::1]', true],
  ];
  for (const [pattern, host, expected] of cases) {
    test(`${pattern} ${expected ? 'matches' : 'does not match'} ${host}`, () => {
      assert.equal(hostMatches(pattern, host), expected);
    });
  }

  test('sorts by specificity', () => {
    assert.deepEqual(['*', '*.com', 'a.example.com', '*.example.com'].sort(bySpecificity), ['a.example.com', '*.example.com', '*.com', '*']);
  });

  test('gives no host for pages without one', () => {
    assert.equal(hostOfUrl('https://Example.com:8080/x'), 'example.com');
    for (const url of ['about:blank', 'data:text/html,x', 'chrome://version', 'not a url']) assert.equal(hostOfUrl(url), undefined);
  });
});

describe('host-policy.ini', () => {
  test('a missing file is a copy of the template', () => {
    const template = tmpFile('hosts/template.ini', '# my template\n[deny]\na.evil\n[allow]\n*\n');
    const file = tmpFile('hosts/from-template.ini');
    const hosts = new HostsFile(file, template);
    hosts.load();
    assert.deepEqual(hosts.deny, ['a.evil']);
    assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(template, 'utf8'));
  });

  test('a missing file without a template gets "[allow] *"', () => {
    const file = tmpFile('hosts/missing.ini');
    const hosts = new HostsFile(file);
    hosts.load();
    assert.deepEqual(hosts.allow, ['*']);
    assert.match(fs.readFileSync(file, 'utf8'), /^# Hosts of the browser tool facades, for all facades/);
  });

  test('recording adds the exact host, keeps the sections sorted and the header', () => {
    const file = tmpFile('hosts/record.ini', '# my note\n[deny]\nz.evil\na.evil\n[allow]\n*\nm.example\n');
    const hosts = new HostsFile(file);
    const provider = new FileAllowProvider({ hostsFile: hosts, record: true, logger });
    return (async () => {
      await provider.recordOpened('b.example');
      await provider.recordOpened('b.example');
      assert.equal(fs.readFileSync(file, 'utf8'), '# my note\n\n[deny]\na.evil\nz.evil\n\n[allow]\n*\nb.example\nm.example\n');
    })();
  });

  test('record = false does not change the file', async () => {
    const text = '[deny]\n\n[allow]\n*\n';
    const file = tmpFile('hosts/norecord.ini', text);
    const provider = new FileAllowProvider({ hostsFile: new HostsFile(file), record: false, logger });
    await provider.recordOpened('b.example');
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  });

  test('deny wins over allow', async () => {
    const hostsFile = new HostsFile(tmpFile('hosts/policy.ini', '[deny]\n*.evil.example\n[allow]\n*\n'));
    const policy = new HostPolicy({ hostsFile, allowProvider: new FileAllowProvider({ hostsFile, record: true, logger }) });
    const denied = await policy.check('https://www.evil.example/x', {});
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'the host www.evil.example is on the deny list');
    assert.equal(denied.pattern, '*.evil.example');
    assert.equal((await policy.check('https://good.example/', {})).allowed, true);
    assert.equal((await policy.check('about:blank', {})).allowed, true);
    await policy.opened('https://www.evil.example/', {});
    hostsFile.load();
    assert.ok(!hostsFile.allow.includes('www.evil.example'));
  });

  test('a host that is not in [allow] is blocked', async () => {
    const hostsFile = new HostsFile(tmpFile('hosts/allowonly.ini', '[deny]\n[allow]\n*.example.com\n'));
    const policy = new HostPolicy({ hostsFile, allowProvider: new FileAllowProvider({ hostsFile, record: true, logger }) });
    assert.equal((await policy.check('https://www.example.com/', {})).allowed, true);
    assert.equal((await policy.check('https://other.org/', {})).reason, 'the host other.org is not on the allow list');
  });
});

describe('tools.ini', () => {
  test('adds the missing tools with defaults and keeps the user values', () => {
    const file = tmpFile('tools/tools.ini', '[tools]\nbrowser_click = disabled\n');
    const tools = new ToolsConfig(file, logger, DANGEROUS);
    tools.addMissing(['browser_click', 'browser_navigate', 'browser_evaluate']);
    const values = Object.fromEntries(readIni(file).sections.get('tools').map((line) => [line.key, line.value]));
    assert.deepEqual(values, { browser_click: 'disabled', browser_evaluate: 'disabled', browser_navigate: 'enabled' });
    assert.equal(tools.isEnabled('browser_navigate'), true);
    assert.equal(tools.isEnabled('browser_click'), false);
  });

  test('an unknown value disables the tool', () => {
    const tools = new ToolsConfig(tmpFile('tools/bad.ini', '[tools]\nbrowser_click = maybe\n'), logger, DANGEROUS);
    assert.equal(tools.isEnabled('browser_click'), false);
  });

  test('a disabled tool gets a note and an error with the reason', () => {
    const tools = new ToolsConfig(tmpFile('tools/reason.ini', '[tools]\nbrowser_evaluate = disabled\n'), logger, DANGEROUS);
    assert.equal(tools.describe({ name: 'browser_evaluate', description: 'Evaluate.' }).description,
      'DISABLED: this tool is turned off in the configuration. Reason: it runs JavaScript in the web page and can read all data of the page. Evaluate.');
    const result = tools.disabledResult('browser_evaluate');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^### Error\nThe tool browser_evaluate did not run: this tool is turned off in the configuration\./);
    assert.doesNotMatch(result.content[0].text, /facade|\.ini/);
  });
});

class StubProvider extends FillProvider {
  constructor(name, values) {
    super({ name, config: { sections: new Map() } });
    this.values = values;
  }

  async resolve(name) {
    if (this.values[name] instanceof Error) throw this.values[name];
    return this.values[name];
  }
}

describe('form fields', () => {
  const cases = [
    ['login.example.com', 'https://login.example.com/any/path?x=1', true],
    ['login.example.com/u/*/login', 'https://login.example.com/u/abc/def/login', true],
    ['login.example.com/u/*/login', 'https://login.example.com/u/abc/login/next', false],
    ['*.example.com/login', 'http://a.example.com:8080/login#top', true],
    ['*.example.com/login', 'https://example.com/login', false],
    ['example.com/', 'https://example.com/', true],
    ['example.com/', 'https://example.com/a', false],
    ['example.com/a.b', 'https://example.com/aXb', false],
    ['example.com', 'about:blank', false],
  ];
  for (const [pattern, url, expected] of cases) {
    test(`${pattern} ${expected ? 'matches' : 'does not match'} ${url}`, () => {
      assert.equal(urlMatches(pattern, url), expected);
    });
  }

  test('the pattern of a page replaces ID segments with *', () => {
    assert.equal(urlPattern('https://Login.Example.com/u/login/identifier?state=x'), 'login.example.com/u/login/identifier');
    assert.equal(urlPattern('https://a.example/t/12345/user/0f8fad5b-d9cb-469f-a165-70867728950e/x'), 'a.example/t/*/user/*/x');
    assert.equal(urlPattern('https://a.example/s/aB3dE5fG7hJ9kL1mN/authorization-code-flow'), 'a.example/s/*/authorization-code-flow');
    assert.equal(urlPattern('https://a.example/'), 'a.example/');
  });

  test('all matching sections apply; the longer pattern wins; submit is separate', () => {
    const fields = new FieldsConfig(tmpFile('fields/fields.ini', '[example.com]\nusername = #user\npassword = #pass\n'
      + '[example.com/admin/*]\npassword = input[name="admin-pass"]\nsubmit = button[type=submit]\n[other.example]\n; comment\n'));
    assert.deepEqual(fields.match('https://example.com/admin/login'), {
      key: 'example.com example.com/admin/*',
      fields: [{ name: 'username', selector: '#user' }, { name: 'password', selector: 'input[name="admin-pass"]' }],
      submit: 'button[type=submit]',
    });
    assert.deepEqual(fields.match('https://example.com/').fields.map(({ name }) => name), ['username', 'password']);
    assert.equal(fields.match('https://other.example/'), undefined);
    assert.equal(fields.match('https://unknown.example/'), undefined);
  });
});

describe('fill registry', () => {
  const registry = () => new FillRegistry({
    providers: [new StubProvider('first', { email: 'a@first.example' }), new StubProvider('second', { email: 'b@second', name: 'Anna' })],
    logger,
    masked: new Set(['first']),
  });

  test('the first provider with a value wins; no value gives undefined', async () => {
    const r = registry();
    assert.equal(await r.resolve('email', { host: 'h' }), 'a@first.example');
    assert.equal(await r.resolve('name', { host: 'h' }), 'Anna');
    assert.equal(await r.resolve('phone', { host: 'h' }), undefined);
  });

  test('a provider error stops the fill', async () => {
    const r = new FillRegistry({ providers: [new StubProvider('bad', { email: new FillError('declined') })], logger });
    await assert.rejects(r.resolve('email', {}), /declined/);
  });

  test('scrubs only the values of masked providers', async () => {
    const r = registry();
    await r.resolve('email', {});
    await r.resolve('name', {});
    const result = r.scrub({ content: [{ type: 'text', text: '- textbox "Name": Anna a@first.example' }, { type: 'image', data: 'a@first.example' }] });
    assert.equal(result.content[0].text, `- textbox "Name": Anna ${MASK}`);
    assert.equal(result.content[1].data, 'a@first.example');
  });

  test('a provider without a [mask] line is masked', async () => {
    const r = await FillRegistry.load({ names: ['ini', 'ask'], providersDir: path.join(TOOL_DIR, 'providers-form-fill'), configDir: path.join(TMP, 'mask'), logger, mask: { ini: 'false' } });
    assert.deepEqual([...r.masked], ['ask']);
  });
});

describe('ini provider', () => {
  const provider = new IniProvider({ name: 'ini', config: parseIni('[values]\nName = Anna\nemail = anna@x\n[other]\nphone = 1\n') });

  test('gives the values of [values]', async () => {
    assert.equal(await provider.resolve('name', { host: 'a.example' }), 'Anna');
    assert.equal(await provider.resolve('email', {}), 'anna@x');
    assert.equal(await provider.resolve('phone', {}), undefined);
    assert.equal(await provider.resolve('constructor', {}), undefined);
  });
});

describe('config folder', () => {
  test('a missing config file is a copy of its template; an existing file stays', () => {
    const dir = path.join(TMP, 'config-folder');
    fs.rmSync(dir, { recursive: true, force: true });
    const file = configFile(dir, 'facade.ini');
    assert.equal(file, path.join(dir, 'facade.ini'));
    assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(CONFIG_TEMPLATES['facade.ini'], 'utf8'));
    fs.writeFileSync(file, '[fill]\nproviders = ini\n');
    assert.equal(fs.readFileSync(configFile(dir, 'facade.ini'), 'utf8'), '[fill]\nproviders = ini\n');
    assert.equal(fs.existsSync(configFile(dir, 'other.ini')), false);   // no template: no file
  });

  test('each provider has a template', () => {
    for (const name of fs.readdirSync(path.join(TOOL_DIR, 'providers-form-fill'))) {
      assert.ok(fs.existsSync(path.join(TOOL_DIR, 'providers-form-fill', name, 'config.template.ini')), name);
    }
  });
});

describe('vault provider', () => {
  const callLog = path.join(TMP, 'vault-calls.log');
  const make = (systems = '127.0.0.1 = Fixture site\nexample.com = Example C\nhttps://example.com/a = Example A\n'
    + 'https://example.com/a/b = Example B\n', vault = 'vault-test') => new VaultProvider({
    name: 'vault',
    configFile: path.join(TMP, 'provider-vault.ini'),
    config: parseIni(`[vault]\nvault = ${vault}\n\n[systems]\n${systems}`),
  });
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

  test('selects the system by the host in [systems]', async () => {
    const provider = make();
    assert.equal(await provider.resolve('password', { host: '127.0.0.1', url: 'http://127.0.0.1:8080/login' }), 'Fixture-Pa55-word');
    assert.equal(await provider.resolve('username', { host: '127.0.0.1', url: 'http://127.0.0.1:8080/' }), 'fixture-user');
    assert.equal(await provider.resolve('token', { host: '127.0.0.1', url: 'http://127.0.0.1/' }), undefined);
    assert.equal(await provider.resolve('password', { host: 'unknown.example', url: 'https://unknown.example/' }), undefined);
    assert.equal(await provider.resolve('password', {}), undefined);
  });

  test('a host matches its subdomains; the longest url prefix wins; an equal match is an error', async () => {
    const provider = make();
    assert.equal(await provider.resolve('password', { host: 'example.com', url: 'https://example.com/a/b/c' }), 'pass-b');
    assert.equal(await provider.resolve('password', { host: 'example.com', url: 'https://example.com/a/x' }), 'pass-a');
    assert.equal(await provider.resolve('password', { host: 'www.example.com', url: 'https://www.example.com/' }).catch((e) => e.message),
      `more lines of [systems] in ${path.join(TMP, 'provider-vault.ini')} match the host www.example.com: `
      + 'example.com; https://example.com/a; https://example.com/a/b. Give each a more specific URL prefix.');
  });

  test('asks the vault only for the systems in [systems], with the vault name', async () => {
    const log = await calls(async () => {
      const provider = make();
      await provider.resolve('password', { host: '127.0.0.1' });
      await provider.resolve('password', { host: 'other.example' });
    });
    assert.deepEqual(log, [['--vault', 'vault-test', 'get-system', 'Fixture site'],
      ['--vault', 'vault-test', 'get-secret', 'Fixture site', 'password']]);
  });

  test('needs the vault name; an unknown system is an error of the vault tool', async () => {
    assert.match(await make('127.0.0.1 = Fixture site\n', '').resolve('password', { host: '127.0.0.1' }).catch((e) => e.message),
      /the vault provider needs "vault = vault-<name>"/);
    assert.match(await make('127.0.0.1 = Missing\n').resolve('password', { host: '127.0.0.1' }).catch((e) => e.message),
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
  const make = () => new AskProvider({ name: 'ask', config: parseIni('[ask]\nfields = phone, Name\n') });

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

describe('logger', () => {
  test('redacts typed text and form values', () => {
    assert.deepEqual(redact({ text: 'secret', element: 'Name', fields: [{ name: 'A', value: 'x {{a}}' }] }),
      { text: '<redacted 6 chars>', element: 'Name', fields: [{ name: 'A', value: '<redacted 7 chars>' }] });
  });
});
