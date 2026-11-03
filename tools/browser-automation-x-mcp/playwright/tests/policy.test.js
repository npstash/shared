// End-to-end tests of the policy layer: tool switches, host lists, form fill and discovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { readIni } from '../../src/ini.js';
import { ASSETS_DIR } from '../../src/paths.js';
import { DISCOVERED_FILE } from '../src/discover.js';
import { DANGEROUS_TOOLS } from '../src/mcp-server.js';
import { call, callText, evaluate, ref, startServerClient, startSite } from './helpers.js';

let site;
before(async () => { site = await startSite(); });
after(async () => { await site?.close(); });

describe('tool switches', () => {
  let mcp;
  before(async () => {
    mcp = await startServerClient({ name: 'policy-tools', config: { tools: '[tools]\nbrowser_tabs = disabled\n' } });
  });
  after(async () => { await mcp?.close(); });

  test('tools.ini gets a line for each tool; dangerous tools are disabled', async () => {
    const file = path.join(mcp.config.configDir, 'tools.ini');
    const values = Object.fromEntries(readIni(file).sections.get('tools').map((line) => [line.key, line.value]));
    const names = (await mcp.client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(Object.keys(values).sort(), [...names].sort());
    for (const name of Object.keys(DANGEROUS_TOOLS)) assert.equal(values[name], 'disabled', name);
    assert.equal(values.browser_tabs, 'disabled');
    assert.equal(values.browser_navigate, 'enabled');
    assert.match(fs.readFileSync(file, 'utf8'), /^# Tool switches/);
  });

  test('a disabled tool stays in the list and fails with the reason', async () => {
    const tools = (await mcp.client.listTools()).tools;
    assert.match(tools.find((tool) => tool.name === 'browser_run_code_unsafe').description, /^DISABLED: this tool is turned off in the configuration\. /);
    const result = await callText(mcp.client, 'browser_run_code_unsafe', { code: 'async (page) => 1' });
    assert.equal(result.isError, true);
    assert.match(result.text, /The tool browser_run_code_unsafe did not run: this tool is turned off in the configuration\. Reason: it runs any JavaScript/);
    assert.equal((await callText(mcp.client, 'browser_tabs', { action: 'list' })).text,
      '### Error\nThe tool browser_tabs did not run: this tool is turned off in the configuration.');
  });
});

describe('host lists', () => {
  test('a denied host is not opened', async () => {
    const mcp = await startServerClient({ name: 'policy-deny', config: { hosts: '[deny]\nlocalhost\n[allow]\n*\n' } });
    try {
      const result = await callText(mcp.client, 'browser_navigate', { url: `${site.otherUrl}/` });
      assert.equal(result.isError, true);
      assert.equal(result.text, `### Error\nNavigation blocked: ${site.otherUrl}/ is not allowed. The host localhost is on the deny list.`);
      assert.equal(await evaluate(mcp.client, '() => location.href'), 'about:blank');
    } finally {
      await mcp.close();
    }
  });

  test('a redirect and a click to a denied host end on about:blank', async () => {
    const mcp = await startServerClient({ name: 'policy-redirect', config: { hosts: '[deny]\nlocalhost\n[allow]\n*\n' } });
    try {
      const target = encodeURIComponent(`${site.otherUrl}/form.html`);
      const redirected = await callText(mcp.client, 'browser_navigate', { url: `${site.url}/redirect?to=${target}` });
      assert.equal(redirected.isError, true);
      assert.match(redirected.text, /Navigation blocked: http:\/\/localhost:\d+\/form\.html is not allowed\. The host localhost is on the deny list\. The browser shows about:blank\./);
      assert.equal(await evaluate(mcp.client, '() => location.href'), 'about:blank');

      await call(mcp.client, 'browser_navigate', { url: `${site.url}/link?to=${target}` });
      const snapshot = await call(mcp.client, 'browser_snapshot');
      const clicked = await callText(mcp.client, 'browser_click', { target: ref(snapshot, 'link', 'Go there'), element: 'link' });
      assert.equal(clicked.isError, true);
      assert.equal(await evaluate(mcp.client, '() => location.href'), 'about:blank');
    } finally {
      await mcp.close();
    }
  });

  test('only hosts in [allow] open; opened hosts are recorded in order', async () => {
    const mcp = await startServerClient({ name: 'policy-allow', config: { hosts: '# keep me\n[deny]\n[allow]\nzz.example\n127.0.0.*\n' } });
    try {
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/` });
      const blocked = await callText(mcp.client, 'browser_navigate', { url: `${site.otherUrl}/` });
      assert.match(blocked.text, /The host localhost is not on the allow list\./);
      const text = fs.readFileSync(path.join(mcp.config.configDir, 'host-policy.ini'), 'utf8');
      assert.equal(text, '# keep me\n\n[deny]\n\n[allow]\n127.0.0.*\n127.0.0.1\nzz.example\n');
    } finally {
      await mcp.close();
    }
  });

  test('record = false leaves host-policy.ini unchanged', async () => {
    const hosts = '[deny]\n\n[allow]\n*\n';
    const mcp = await startServerClient({ name: 'policy-norecord', config: { hosts, server: '[fill]\nproviders = ini\n[hosts]\nrecord = false\n' } });
    try {
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/` });
      assert.equal(fs.readFileSync(path.join(mcp.config.configDir, 'host-policy.ini'), 'utf8'), hosts);
    } finally {
      await mcp.close();
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
  let mcp;
  let asked;

  before(async () => {
    asked = [];
    mcp = await startServerClient({
      name: 'policy-fill',
      config: { fields, ini: '[values]\nname = Anna Nowak\n' },
      onElicit: async (params) => {
        asked.push(params.message);
        return { action: 'accept', content: { value: '+48 600 100 200' } };
      },
    });
  });
  after(async () => { await mcp?.close(); });

  test('the server fills and submits; the client sees the page after the submit and *** for masked values', async () => {
    const before = site.submissions.length;
    const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/account.html` });
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
    const shown = await evaluate(mcp.client, `() => JSON.parse(document.getElementById('result').textContent)`);
    assert.equal(shown.password, '***');
    for (const output of [text, fs.readFileSync(mcp.logFile, 'utf8')]) {
      for (const secret of [USERNAME, PASSWORD, '+48 600 100 200']) assert.ok(!output.includes(secret), `"${secret}" is visible`);
    }
    assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_submitted' && entry.how === 'requestSubmit'));
  });

  test('the same form after the submit gets no second fill', async () => {
    const before = site.submissions.length;
    const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/login.html` });
    assert.equal(site.submissions.length, before + 1);
    assert.deepEqual(site.submissions.at(-1), { user: USERNAME, pass: PASSWORD });
    assert.match(text, /Page Title: Login/);
    await call(mcp.client, 'browser_snapshot');
    assert.equal(site.submissions.length, before + 1);
    assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_failed'));
  });

  test('a second step on the same URL gets a fill in the same call', async () => {
    const before = site.submissions.length;
    const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/twostep.html` });
    assert.equal(site.submissions.length, before + 1);
    assert.deepEqual(site.submissions.at(-1), { username: USERNAME, password: PASSWORD });
    assert.match(text, /Page Title: Submitted/);
  });

  test('a page without fields.ini lines gets no fill', async () => {
    const before = site.submissions.length;
    await call(mcp.client, 'browser_navigate', { url: `${site.url}/form.html` });
    await call(mcp.client, 'browser_navigate', { url: `${site.otherUrl}/account.html` });
    assert.equal(site.submissions.length, before);
  });
});

describe('form fill without dialogs', () => {
  test('the ask provider is skipped when the client cannot show dialogs', async () => {
    const mcp = await startServerClient({ name: 'policy-nodialog', config: { fields: '[127.0.0.1/account.html]\nphone = #phone\n' } });
    try {
      const before = site.submissions.length;
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/account.html` });
      assert.equal(site.submissions.length, before);
      assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_no_value'));
    } finally {
      await mcp.close();
    }
  });
});

describe('discovery', () => {
  test('writes the fields of each page with a selector and a URL pattern', async () => {
    fs.rmSync(DISCOVERED_FILE, { force: true });
    const mcp = await startServerClient({ name: 'policy-discover', env: { BROWSER_AUTOMATION_X_MCP_DISCOVER: '1' } });
    try {
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/login.html?x=1` });
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/account.html` });
      const ini = readIni(DISCOVERED_FILE);
      assert.deepEqual(Object.fromEntries(ini.sections.get('127.0.0.1/login.html').map(({ key, value }) => [key, value])),
        { username: 'input[autocomplete="username"]', password: 'input[name="pass"]', submit: 'button[type="submit"]' });
      const account = Object.fromEntries(ini.sections.get('127.0.0.1/account.html').map(({ key, value }) => [key, value]));
      assert.equal(account.password, 'input[name="password"]');
      assert.equal(account.email, 'input[name="email"]');
      assert.match(fs.readFileSync(DISCOVERED_FILE, 'utf8'), /; input type=password name=pass label="Password"/);
      assert.match(fs.readFileSync(DISCOVERED_FILE, 'utf8'), /submit = button\[type="submit"\]/);
    } finally {
      await mcp.close();
    }
  });

  test('records the page and fields reached after a form submit', async () => {
    fs.rmSync(DISCOVERED_FILE, { force: true });
    const fields = '[127.0.0.1/redirect-step.html]\nusername = #username\n'
      + '[127.0.0.1/password.html]\npassword = #password\n';
    const mcp = await startServerClient({
      name: 'policy-discover-submit',
      env: { BROWSER_AUTOMATION_X_MCP_DISCOVER: '1' },
      config: { fields },
    });
    try {
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/redirect-step.html` });
      const ini = readIni(DISCOVERED_FILE);
      const password = Object.fromEntries(ini.sections.get('127.0.0.1/password.html').map(({ key, value }) => [key, value]));
      assert.equal(password.password, 'input[autocomplete="current-password"]');
      assert.equal(password.submit, 'button[type="submit"]');
      assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'page_opened'
        && entry.via === 'auto_submit' && entry.url === `${site.url}/password.html`));
      // The next call gets the events of the form fill: the used fields get a mark.
      await call(mcp.client, 'browser_snapshot');
      assert.match(discoveredSection('127.0.0.1/redirect-step.html'), /; used: filled by auto-fill\nusername = #username|; used: filled by auto-fill\nusername = input/);
    } finally {
      await mcp.close();
    }
  });
});

// The lines of one section of DISCOVERED_FILE, as text.
function discoveredSection(pattern) {
  const text = fs.readFileSync(DISCOVERED_FILE, 'utf8');
  const start = text.indexOf(`[${pattern}]`);
  assert.ok(start >= 0, `no section ${pattern}`);
  const end = text.indexOf('\n[', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

describe('discovery: merge and used marks', () => {
  test('a second visit adds no line; the fills and clicks of the user and the agent get marks', async () => {
    fs.rmSync(DISCOVERED_FILE, { force: true });
    const mcp = await startServerClient({ name: 'policy-discover-used', env: { BROWSER_AUTOMATION_X_MCP_DISCOVER: '1' } });
    try {
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/user-step.html` });
      const first = discoveredSection('127.0.0.1/user-step.html');
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/user-step.html` });
      assert.equal(discoveredSection('127.0.0.1/user-step.html'), first);
      assert.match(first, /username = input\[autocomplete="username"\]\n/);
      assert.match(first, /submit = #send/);

      // The agent types into the note field.
      const snapshot = await call(mcp.client, 'browser_snapshot');
      await call(mcp.client, 'browser_type', { target: ref(snapshot, 'textbox', 'Note'), element: 'Note', text: 'hello' });

      // The page acts as the user 1.5 s after the load: it fills the username and presses Send.
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/user-step.html?user=1` });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await call(mcp.client, 'browser_snapshot');

      const section = discoveredSection('127.0.0.1/user-step.html');
      assert.match(section, /; used: filled by agent\nnote = input\[name="note"\]/);
      assert.match(section, /; used: filled by user\nusername = input\[autocomplete="username"\]/);
      assert.match(section, /; used: pressed by user\nsubmit = #send/);
      const events = readLog(mcp.logFile).map((entry) => entry.event);
      for (const event of ['agent_filled', 'user_filled', 'user_pressed']) assert.ok(events.includes(event), event);
      assert.doesNotMatch(fs.readFileSync(mcp.logFile, 'utf8'), /someone|hello/);
    } finally {
      await mcp.close();
    }
  });
});

describe('label locators and submits', () => {
  test('discovery gives a label locator; the server fills with it and clicks the first visible submit', async () => {
    fs.rmSync(DISCOVERED_FILE, { force: true });
    const fields = '[127.0.0.1/label.html]\nnickname = internal:label="Nickname"s\nsubmit = #missing\nsubmit = #go\n';
    const mcp = await startServerClient({
      name: 'policy-label',
      env: { BROWSER_AUTOMATION_X_MCP_DISCOVER: '1' },
      config: { fields, ini: '[values]\nnickname = Nick\n' },
    });
    try {
      const count = site.submissions.length;
      const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/label.html` });
      assert.match(text, /Page Title: Submitted/);
      assert.equal(site.submissions.length, count + 1);
      assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_submitted' && entry.how === '#go'));
      const section = discoveredSection('127.0.0.1/label.html');
      assert.match(section, /field = internal:label="Nickname"s/);
      assert.match(section, /submit = #go/);
    } finally {
      await mcp.close();
    }
  });
});

describe('host check after an auto-submit', () => {
  test('a redirect to a denied host after a submit stops the chain before the next fill', async () => {
    const fields = '[127.0.0.1/hop.html]\nusername = #username\n[localhost/password.html]\npassword = #password\n';
    const mcp = await startServerClient({
      name: 'policy-hop',
      config: { fields, hosts: '[deny]\nlocalhost\n[allow]\n*\n' },
    });
    try {
      const count = site.submissions.length;
      const result = await callText(mcp.client, 'browser_navigate', { url: `${site.url}/hop.html` });
      assert.ok(result.isError);
      assert.match(result.text, /Navigation blocked: http:\/\/localhost:\d+\/password\.html is not allowed/);
      assert.equal(site.submissions.length, count);
      assert.equal(readLog(mcp.logFile).filter((entry) => entry.event === 'fill_submitted').length, 1);
      assert.equal(await evaluate(mcp.client, '() => location.href'), 'about:blank');
    } finally {
      await mcp.close();
    }
  });
});
