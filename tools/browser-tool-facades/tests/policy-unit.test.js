// Unit tests of the shared parts: INI files, host patterns and lists, tool switches, fill providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ASSETS_DIR, TOOL_DIR } from '../src/paths.js';
import { FillError, FillProvider } from '../src/fill/provider.js';
import { FillRegistry, placeholdersIn } from '../src/fill/registry.js';
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

// A facade gives these maps. The tests use their own, in the form of the Playwright facade.
const DANGEROUS = { browser_evaluate: 'it runs JavaScript in the web page and can read all data of the page' };
const FILL_ARGUMENTS = {
  browser_type: (args) => [{ value: args.text, field: args.element, set: (v) => { args.text = v; } }],
  browser_fill_form: (args) => (args.fields ?? []).map((field) => ({ value: field.value, field: field.name, set: (v) => { field.value = v; } })),
  browser_select_option: (args) => (args.values ?? []).map((value, i) => ({ value, field: args.element, set: (v) => { args.values[i] = v; } })),
};

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

describe('hosts.ini', () => {
  test('a missing file gets "[allow] *"', () => {
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
    assert.match(denied.reason, /matches "\*\.evil\.example" in \[deny\]/);
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
    assert.match((await policy.check('https://other.org/', {})).reason, /not in \[allow\]/);
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
    assert.match(tools.describe({ name: 'browser_evaluate', description: 'Evaluate.' }).description, /^DISABLED by the facade: .*can read all data of the page\. Evaluate\.$/);
    const result = tools.disabledResult('browser_evaluate');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /disabled: .* To enable it, set "browser_evaluate = enabled"/);
  });
});

class StubProvider extends FillProvider {
  constructor(name, values) {
    super({ name, config: { sections: new Map() } });
    this.values = values;
  }

  async list() {
    return Object.keys(this.values);
  }

  async resolve(name) {
    if (this.values[name] instanceof Error) throw this.values[name];
    return this.values[name];
  }
}

describe('fill registry', () => {
  const registry = () => new FillRegistry({
    providers: [new StubProvider('first', { email: 'a@first.example' }), new StubProvider('second', { email: 'b@second', name: 'Anna' })],
    logger,
    fillArguments: FILL_ARGUMENTS,
  });

  test('finds placeholders', () => {
    assert.deepEqual(placeholdersIn('{{Email}} and {{ name }} and {name}'), ['email', 'name']);
  });

  test('the first provider with a value wins; placeholders inside a value work', async () => {
    const args = { fields: [{ name: 'E', value: '{{email}}' }, { name: 'N', value: 'Dr. {{name}}' }, { name: 'X', value: 'plain' }] };
    const filled = await registry().fill('browser_fill_form', args, { host: 'h' });
    assert.deepEqual(filled.fields.map((field) => field.value), ['a@first.example', 'Dr. Anna', 'plain']);
    assert.equal(args.fields[0].value, '{{email}}');
  });

  test('fills browser_type and browser_select_option', async () => {
    const r = registry();
    assert.equal((await r.fill('browser_type', { text: '{{name}}' }, {})).text, 'Anna');
    assert.deepEqual((await r.fill('browser_select_option', { values: ['{{name}}', 'x'] }, {})).values, ['Anna', 'x']);
    assert.deepEqual(await r.fill('browser_click', { target: '{{name}}' }, {}), { target: '{{name}}' });
  });

  test('a placeholder without a value stops the call', async () => {
    await assert.rejects(registry().fill('browser_type', { text: '{{phone}}' }, { host: 'h.example' }), (error) => {
      assert.ok(error instanceof FillError);
      assert.match(error.message, /no provider has a value for \{\{phone\}\} on the host h\.example\. Providers asked: first, second\./);
      return true;
    });
  });

  test('scrubs filled values from results', async () => {
    const r = registry();
    await r.fill('browser_type', { text: '{{name}} {{email}}' }, {});
    const result = r.scrub({ content: [{ type: 'text', text: '- textbox "Name": Anna a@first.example' }, { type: 'image', data: 'Anna' }] });
    assert.equal(result.content[0].text, '- textbox "Name": {{name}} {{email}}');
    assert.equal(result.content[1].data, 'Anna');
  });

  test('lists the placeholders of each provider', async () => {
    assert.deepEqual(await registry().list({}), ['- first: {{email}}', '- second: {{email}}, {{name}}']);
  });
});

describe('ini provider', () => {
  const provider = new IniProvider({
    name: 'ini',
    config: parseIni('[all]\nname = All\nEmail = all@x\n[*.example.com]\nemail = sub@x\n[www.example.com]\nemail = www@x\n[*.com]\nname = Com\n'),
  });

  test('the most specific section wins', async () => {
    assert.equal(await provider.resolve('email', { host: 'www.example.com' }), 'www@x');
    assert.equal(await provider.resolve('email', { host: 'a.example.com' }), 'sub@x');
    assert.equal(await provider.resolve('email', { host: 'other.org' }), 'all@x');
    assert.equal(await provider.resolve('name', { host: 'a.example.com' }), 'Com');
    assert.equal(await provider.resolve('email', {}), 'all@x');
    assert.equal(await provider.resolve('phone', { host: 'a.example.com' }), undefined);
  });

  test('lists the keys for the host', async () => {
    assert.deepEqual(await provider.list({ host: 'other.org' }), ['email', 'name']);
  });
});

describe('vault provider', () => {
  const callLog = path.join(TMP, 'vault-calls.log');
  const make = (extra = '') => new VaultProvider({
    name: 'vault',
    configFile: path.join(TMP, 'vault', 'config.ini'),
    config: parseIni(`[vault]\ntool = ${path.join(FAKE_VAULT, 'run.sh')}\nvault_home = ${FAKE_VAULT}\n${extra}`),
  });

  test('selects the system by the host of its url', async () => {
    const provider = make();
    assert.equal(await provider.resolve('password', { host: '127.0.0.1', url: 'http://127.0.0.1:8080/login' }), 'Fixture-Pa55-word');
    assert.deepEqual(await provider.list({ host: '127.0.0.1', url: 'http://127.0.0.1:8080/' }), ['username', 'password']);
    assert.equal(await provider.resolve('token', { host: '127.0.0.1', url: 'http://127.0.0.1/' }), undefined);
    assert.equal(await provider.resolve('password', { host: 'unknown.example', url: 'https://unknown.example/' }), undefined);
    assert.equal(await provider.resolve('password', {}), undefined);
  });

  test('the longest url prefix wins; an equal match is an error', async () => {
    const provider = make();
    assert.equal(await provider.resolve('password', { host: 'example.com', url: 'https://example.com/a/b/c' }), 'pass-b');
    assert.equal(await provider.resolve('password', { host: 'www.example.com', url: 'https://www.example.com/' }).catch((e) => e.message),
      'more vault systems match the host www.example.com: Example A; Example B; Example C. Give each a more specific url.');
  });

  test('gives the vault home and the sub-vault to the vault tool', async () => {
    fs.rmSync(callLog, { force: true });
    process.env.FAKE_VAULT_LOG = callLog;
    try {
      await make('subvault = team\n').list({ host: '127.0.0.1' });
    } finally {
      delete process.env.FAKE_VAULT_LOG;
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(callLog, 'utf8')), ['--vault-home', FAKE_VAULT, '--subvault', 'team', 'list']);
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
    assert.equal(await provider.resolve('phone', { host: 'a.example', field: 'Phone', elicit }), '+48 600 000 000');
    assert.equal(await provider.resolve('phone', { host: 'a.example', elicit }), '+48 600 000 000');
    assert.equal(asked.length, 1);
    assert.match(asked[0], /type your phone into the field "Phone" on a\.example/);
    assert.equal(await provider.resolve('email', { host: 'a.example', elicit }), undefined);
    assert.deepEqual(await provider.list({ elicit }), ['phone', 'name']);
  });

  test('does nothing without dialogs; a declined dialog stops the call', async () => {
    const provider = make();
    assert.equal(await provider.resolve('phone', { host: 'a.example' }), undefined);
    assert.deepEqual(await provider.list({}), []);
    await assert.rejects(provider.resolve('phone', { host: 'a.example', elicit: async () => ({ action: 'decline' }) }), /did not give \{\{phone\}\} \(decline\)/);
  });
});

describe('logger', () => {
  test('keeps placeholders, redacts other values', () => {
    assert.deepEqual(redact({ text: '{{password}}', fields: [{ value: ' {{a}} {{b}} ' }, { value: 'x {{a}}' }] }),
      { text: '{{password}}', fields: [{ value: ' {{a}} {{b}} ' }, { value: '<redacted 7 chars>' }] });
  });
});
