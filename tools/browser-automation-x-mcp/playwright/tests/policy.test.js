// End-to-end tests of the policy layer: tool switches, host lists, form fill and discovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { readIni } from '../../src/ini.js';
import { ASSETS_DIR } from '../../src/paths.js';
import { DISCOVERED_FILE } from '../src/autofill.js';
import { DANGEROUS_TOOLS } from '../src/facade.js';
import { call, callText, evaluate, ref, startFacadeClient, startSite } from './helpers.js';

let site;
before(async () => { site = await startSite(); });
after(async () => { await site?.close(); });

describe('tool switches', () => {
  let facade;
  before(async () => {
    facade = await startFacadeClient({ name: 'policy-tools', config: { tools: '[tools]\nbrowser_tabs = disabled\n' } });
  });
  after(async () => { await facade?.close(); });

  test('tools.ini gets a line for each tool; dangerous tools are disabled', async () => {
    const file = path.join(facade.config.configDir, 'playwright-tools.ini');
    const values = Object.fromEntries(readIni(file).sections.get('tools').map((line) => [line.key, line.value]));
    const names = (await facade.client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(Object.keys(values).sort(), [...names].sort());
    for (const name of Object.keys(DANGEROUS_TOOLS)) assert.equal(values[name], 'disabled', name);
    assert.equal(values.browser_tabs, 'disabled');
    assert.equal(values.browser_navigate, 'enabled');
    assert.match(fs.readFileSync(file, 'utf8'), /^# Tool switches/);
  });

  test('a disabled tool stays in the list and fails with the reason', async () => {
    const tools = (await facade.client.listTools()).tools;
    assert.match(tools.find((tool) => tool.name === 'browser_run_code_unsafe').description, /^DISABLED: this tool is turned off in the configuration\. /);
    const result = await callText(facade.client, 'browser_run_code_unsafe', { code: 'async (page) => 1' });
    assert.equal(result.isError, true);
    assert.match(result.text, /The tool browser_run_code_unsafe did not run: this tool is turned off in the configuration\. Reason: it runs any JavaScript/);
    assert.equal((await callText(facade.client, 'browser_tabs', { action: 'list' })).text,
      '### Error\nThe tool browser_tabs did not run: this tool is turned off in the configuration.');
  });
});

describe('host lists', () => {
  test('a denied host is not opened', async () => {
    const facade = await startFacadeClient({ name: 'policy-deny', config: { hosts: '[deny]\nlocalhost\n[allow]\n*\n' } });
    try {
      const result = await callText(facade.client, 'browser_navigate', { url: `${site.otherUrl}/` });
      assert.equal(result.isError, true);
      assert.equal(result.text, `### Error\nNavigation blocked: ${site.otherUrl}/ is not allowed. The host localhost is on the deny list.`);
      assert.equal(await evaluate(facade.client, '() => location.href'), 'about:blank');
    } finally {
      await facade.close();
    }
  });

  test('a redirect and a click to a denied host end on about:blank', async () => {
    const facade = await startFacadeClient({ name: 'policy-redirect', config: { hosts: '[deny]\nlocalhost\n[allow]\n*\n' } });
    try {
      const target = encodeURIComponent(`${site.otherUrl}/form.html`);
      const redirected = await callText(facade.client, 'browser_navigate', { url: `${site.url}/redirect?to=${target}` });
      assert.equal(redirected.isError, true);
      assert.match(redirected.text, /Navigation blocked: http:\/\/localhost:\d+\/form\.html is not allowed\. The host localhost is on the deny list\. The browser shows about:blank\./);
      assert.equal(await evaluate(facade.client, '() => location.href'), 'about:blank');

      await call(facade.client, 'browser_navigate', { url: `${site.url}/link?to=${target}` });
      const snapshot = await call(facade.client, 'browser_snapshot');
      const clicked = await callText(facade.client, 'browser_click', { target: ref(snapshot, 'link', 'Go there'), element: 'link' });
      assert.equal(clicked.isError, true);
      assert.equal(await evaluate(facade.client, '() => location.href'), 'about:blank');
    } finally {
      await facade.close();
    }
  });

  test('only hosts in [allow] open; opened hosts are recorded in order', async () => {
    const facade = await startFacadeClient({ name: 'policy-allow', config: { hosts: '# keep me\n[deny]\n[allow]\nzz.example\n127.0.0.*\n' } });
    try {
      await call(facade.client, 'browser_navigate', { url: `${site.url}/` });
      const blocked = await callText(facade.client, 'browser_navigate', { url: `${site.otherUrl}/` });
      assert.match(blocked.text, /The host localhost is not on the allow list\./);
      const text = fs.readFileSync(path.join(facade.config.configDir, 'host-policy.ini'), 'utf8');
      assert.equal(text, '# keep me\n\n[deny]\n\n[allow]\n127.0.0.*\n127.0.0.1\nzz.example\n');
    } finally {
      await facade.close();
    }
  });

  test('record = false leaves host-policy.ini unchanged', async () => {
    const hosts = '[deny]\n\n[allow]\n*\n';
    const facade = await startFacadeClient({ name: 'policy-norecord', config: { hosts, facade: '[fill]\nproviders = ini\n[hosts]\nrecord = false\n' } });
    try {
      await call(facade.client, 'browser_navigate', { url: `${site.url}/` });
      assert.equal(fs.readFileSync(path.join(facade.config.configDir, 'host-policy.ini'), 'utf8'), hosts);
    } finally {
      await facade.close();
    }
  });
});

// The secrets of the fake vault for 127.0.0.1 (tests/fixtures/fake-vault/vault.json).
const USERNAME = 'fixture-user';
const PASSWORD = 'Fixture-Pa55-word';

function readLog(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('form fill', () => {
  const fields = '[127.0.0.1/account.html]\nusername = #username\npassword = input[name="password"]\nname = #name\nphone = #phone\n'
    + '[127.0.0.1/login*]\nusername = input[autocomplete="username"]\npassword = #pass\n'
    + '[127.0.0.1/twostep.html]\nusername = #login-user\npassword = #login-pass\n';
  let facade;
  let asked;

  before(async () => {
    asked = [];
    facade = await startFacadeClient({
      name: 'policy-fill',
      config: { fields, ini: '[values]\nname = Anna Nowak\n' },
      onElicit: async (params) => {
        asked.push(params.message);
        return { action: 'accept', content: { value: '+48 600 100 200' } };
      },
    });
  });
  after(async () => { await facade?.close(); });

  test('the facade fills and submits; the client sees the page after the submit and *** for masked values', async () => {
    const before = site.submissions.length;
    const text = await call(facade.client, 'browser_navigate', { url: `${site.url}/account.html` });
    assert.equal(site.submissions.length, before + 1);
    const submitted = site.submissions.at(-1);
    assert.deepEqual(submitted, { name: 'Anna Nowak', email: '', phone: '+48 600 100 200', username: USERNAME, password: PASSWORD, note: '' });
    assert.equal(asked.length, 1);
    assert.match(asked[0], /fills the field "phone" on 127\.0\.0\.1/);

    // The result is the page after the submit. The ini provider is not masked.
    assert.match(text, /Page Title: Submitted/);
    assert.match(text, /Anna Nowak/);
    assert.match(text, /\*\*\*/);
    assert.doesNotMatch(text, /Ran Playwright code|Playwright/);
    const shown = await evaluate(facade.client, `() => JSON.parse(document.getElementById('result').textContent)`);
    assert.equal(shown.password, '***');
    for (const output of [text, fs.readFileSync(facade.logFile, 'utf8')]) {
      for (const secret of [USERNAME, PASSWORD, '+48 600 100 200']) assert.ok(!output.includes(secret), `"${secret}" is visible`);
    }
    assert.ok(readLog(facade.logFile).some((entry) => entry.event === 'fill_submitted' && entry.how === 'requestSubmit'));
  });

  test('the same form after the submit gets no second fill', async () => {
    const before = site.submissions.length;
    const text = await call(facade.client, 'browser_navigate', { url: `${site.url}/login.html` });
    assert.equal(site.submissions.length, before + 1);
    assert.deepEqual(site.submissions.at(-1), { user: USERNAME, pass: PASSWORD });
    assert.match(text, /Page Title: Login/);
    await call(facade.client, 'browser_snapshot');
    assert.equal(site.submissions.length, before + 1);
    assert.ok(readLog(facade.logFile).some((entry) => entry.event === 'fill_failed'));
  });

  test('a second step on the same URL gets a fill in the same call', async () => {
    const before = site.submissions.length;
    const text = await call(facade.client, 'browser_navigate', { url: `${site.url}/twostep.html` });
    assert.equal(site.submissions.length, before + 1);
    assert.deepEqual(site.submissions.at(-1), { username: USERNAME, password: PASSWORD });
    assert.match(text, /Page Title: Submitted/);
  });

  test('a page without fields.ini lines gets no fill', async () => {
    const before = site.submissions.length;
    await call(facade.client, 'browser_navigate', { url: `${site.url}/form.html` });
    await call(facade.client, 'browser_navigate', { url: `${site.otherUrl}/account.html` });
    assert.equal(site.submissions.length, before);
  });
});

describe('form fill without dialogs', () => {
  test('the ask provider is skipped when the client cannot show dialogs', async () => {
    const facade = await startFacadeClient({ name: 'policy-nodialog', config: { fields: '[127.0.0.1/account.html]\nphone = #phone\n' } });
    try {
      const before = site.submissions.length;
      await call(facade.client, 'browser_navigate', { url: `${site.url}/account.html` });
      assert.equal(site.submissions.length, before);
      assert.ok(readLog(facade.logFile).some((entry) => entry.event === 'fill_no_value'));
    } finally {
      await facade.close();
    }
  });
});

describe('discovery', () => {
  test('writes the fields of each page with a selector and a URL pattern', async () => {
    fs.rmSync(DISCOVERED_FILE, { force: true });
    const facade = await startFacadeClient({ name: 'policy-discover', env: { BROWSER_AUTOMATION_X_MCP_DISCOVER: '1' } });
    try {
      await call(facade.client, 'browser_navigate', { url: `${site.url}/login.html?x=1` });
      await call(facade.client, 'browser_navigate', { url: `${site.url}/account.html` });
      const ini = readIni(DISCOVERED_FILE);
      assert.deepEqual(Object.fromEntries(ini.sections.get('127.0.0.1/login.html').map(({ key, value }) => [key, value])),
        { username: 'input[autocomplete="username"]', password: 'input[name="pass"]' });
      const account = Object.fromEntries(ini.sections.get('127.0.0.1/account.html').map(({ key, value }) => [key, value]));
      assert.equal(account.password, 'input[name="password"]');
      assert.equal(account.email, 'input[name="email"]');
      assert.match(fs.readFileSync(DISCOVERED_FILE, 'utf8'), /; input type=password name=pass label="Password"/);
    } finally {
      await facade.close();
    }
  });
});
