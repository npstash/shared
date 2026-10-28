// End-to-end tests of the policy layer: tool switches, host lists and placeholders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { readIni } from '../../src/ini.js';
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
    const file = path.join(facade.config.facadeConfigDir, 'tools.ini');
    const values = Object.fromEntries(readIni(file).sections.get('tools').map((line) => [line.key, line.value]));
    const names = (await facade.client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(Object.keys(values).sort(), [...names].sort());
    for (const name of Object.keys(DANGEROUS_TOOLS)) assert.equal(values[name], 'disabled', name);
    assert.equal(values.browser_tabs, 'disabled');
    assert.equal(values.browser_navigate, 'enabled');
    assert.equal(values.fill_values_list, 'enabled');
    assert.match(fs.readFileSync(file, 'utf8'), /^# Tool switches/);
  });

  test('a disabled tool stays in the list and fails with the reason', async () => {
    const tools = (await facade.client.listTools()).tools;
    assert.match(tools.find((tool) => tool.name === 'browser_run_code_unsafe').description, /^DISABLED by the facade: /);
    const result = await callText(facade.client, 'browser_run_code_unsafe', { code: 'async (page) => 1' });
    assert.equal(result.isError, true);
    assert.match(result.text, /The tool browser_run_code_unsafe is disabled: .*runs any JavaScript.*The facade did not run it\./);
    assert.match((await callText(facade.client, 'browser_tabs', { action: 'list' })).text, /browser_tabs is disabled: the facade config disables this tool\./);
  });
});

describe('host lists', () => {
  test('a denied host is not opened', async () => {
    const facade = await startFacadeClient({ name: 'policy-deny', config: { hosts: '[deny]\nlocalhost\n[allow]\n*\n' } });
    try {
      const result = await callText(facade.client, 'browser_navigate', { url: `${site.otherUrl}/` });
      assert.equal(result.isError, true);
      assert.match(result.text, /did not open .*: the host localhost matches "localhost" in \[deny\]/);
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
      assert.match(redirected.text, /closed the page http:\/\/localhost:\d+\/form\.html: the host localhost matches/);
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
      assert.match(blocked.text, /the host localhost is not in \[allow\]/);
      const text = fs.readFileSync(path.join(facade.config.sharedConfigDir, 'hosts.ini'), 'utf8');
      assert.equal(text, '# keep me\n\n[deny]\n\n[allow]\n127.0.0.*\n127.0.0.1\nzz.example\n');
    } finally {
      await facade.close();
    }
  });

  test('record = false leaves hosts.ini unchanged', async () => {
    const hosts = '[deny]\n\n[allow]\n*\n';
    const facade = await startFacadeClient({ name: 'policy-norecord', config: { hosts, facade: '[fill]\nproviders = ini\n[hosts]\nrecord = false\n' } });
    try {
      await call(facade.client, 'browser_navigate', { url: `${site.url}/` });
      assert.equal(fs.readFileSync(path.join(facade.config.sharedConfigDir, 'hosts.ini'), 'utf8'), hosts);
    } finally {
      await facade.close();
    }
  });
});

describe('placeholders', () => {
  const ini = '[all]\nname = Anna Nowak\nemail = anna@all.example\n[127.0.0.1]\nemail = anna@fixture.example\n';
  let facade;
  let asked;

  before(async () => {
    asked = [];
    facade = await startFacadeClient({
      name: 'policy-fill',
      config: { ini },
      onElicit: async (params) => {
        asked.push(params.message);
        return { action: 'accept', content: { value: '+48 600 100 200' } };
      },
    });
  });
  after(async () => { await facade?.close(); });

  test('the providers fill the form; the client and the log see only placeholders', async () => {
    await call(facade.client, 'browser_navigate', { url: `${site.url}/account.html` });
    const snapshot = await call(facade.client, 'browser_snapshot');
    const box = (name) => ref(snapshot, 'textbox', name);
    const filled = await call(facade.client, 'browser_fill_form', {
      fields: [
        { name: 'Name', type: 'textbox', target: box('Name'), value: '{{name}}' },
        { name: 'Email', type: 'textbox', target: box('Email'), value: '{{email}}' },
        { name: 'Phone', type: 'textbox', target: box('Phone'), value: '{{phone}}' },
        { name: 'Username', type: 'textbox', target: box('Username'), value: '{{username}}' },
        { name: 'Password', type: 'textbox', target: box('Password'), value: '{{password}}' },
      ],
    });
    await call(facade.client, 'browser_type', { target: box('Note'), element: 'Note', text: 'Call {{name}}' });
    const after = await call(facade.client, 'browser_snapshot');
    await call(facade.client, 'browser_click', { target: ref(snapshot, 'button', 'Save'), element: 'Save' });

    // The page shows the values, but the facade scrubs them also from browser_evaluate.
    const shown = await evaluate(facade.client, `() => JSON.parse(document.getElementById('result').textContent)`);
    assert.equal(shown.password, '{{password}}');
    const submitted = site.submissions.at(-1);
    assert.deepEqual(submitted, {
      name: 'Anna Nowak',
      email: 'anna@fixture.example',
      phone: '+48 600 100 200',
      username: 'fixture-user',
      password: 'Fixture-Pa55-word',
      note: 'Call Anna Nowak',
    });
    assert.equal(asked.length, 1);
    assert.match(asked[0], /type your phone into the field "Phone" on 127\.0\.0\.1/);

    const secrets = Object.values(submitted);
    for (const text of [filled, after, fs.readFileSync(facade.logFile, 'utf8')]) {
      for (const secret of secrets) assert.ok(!text.includes(secret), `"${secret}" is visible`);
    }
    assert.match(after, /textbox "Name"[^\n]*: \{\{name\}\}/);
  });

  test('fill_values_list gives the placeholders of the page', async () => {
    await call(facade.client, 'browser_navigate', { url: `${site.url}/account.html` });
    const text = await call(facade.client, 'fill_values_list');
    assert.equal(text, 'Placeholders for 127.0.0.1:\n- vault: {{username}}, {{password}}\n- ini: {{email}}, {{name}}\n- ask: {{phone}}');
  });

  test('a placeholder that no provider has stops the call', async () => {
    await call(facade.client, 'browser_navigate', { url: `${site.otherUrl}/account.html` });
    const snapshot = await call(facade.client, 'browser_snapshot');
    const result = await callText(facade.client, 'browser_type', { target: ref(snapshot, 'textbox', 'Password'), element: 'Password', text: '{{password}}' });
    assert.equal(result.isError, true);
    assert.match(result.text, /did not run browser_type: no provider has a value for \{\{password\}\} on the host localhost\. Providers asked: vault, ini, ask\./);
    assert.equal(await evaluate(facade.client, `() => document.getElementById('password').value`), '');
  });
});

describe('placeholders without dialogs', () => {
  test('the ask provider is skipped when the client cannot show dialogs', async () => {
    const facade = await startFacadeClient({ name: 'policy-nodialog' });
    try {
      await call(facade.client, 'browser_navigate', { url: `${site.url}/account.html` });
      const snapshot = await call(facade.client, 'browser_snapshot');
      const result = await callText(facade.client, 'browser_type', { target: ref(snapshot, 'textbox', 'Phone'), element: 'Phone', text: '{{phone}}' });
      assert.match(result.text, /no provider has a value for \{\{phone\}\}/);
      assert.equal(await call(facade.client, 'fill_values_list'), 'Placeholders for 127.0.0.1:\n- vault: {{username}}, {{password}}');
    } finally {
      await facade.close();
    }
  });
});
