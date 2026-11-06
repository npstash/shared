// End-to-end tests of the policy layer: tool switches, host access, form fill, approval, login link and discovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DANGEROUS_TOOLS } from '../src/mcp-server.js';
import { call, callText, evaluate, ref, startServerClient, startSite } from './helpers.js';

let site;
before(async () => { site = await startSite(); });
after(async () => { await site?.close(); });

function readLog(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

// Wait until check(value of get()) is true, a maximum of 5 s. Give the last value.
async function waitFor(get, check) {
  let value = get();
  for (let i = 0; i < 50 && !check(value); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = get();
  }
  return value;
}

// A page of sites.json of the test, or undefined.
function sitesPage(mcp, host, pattern) {
  return mcp.sites.sites?.[host]?.pages?.[pattern];
}

describe('tool switches', () => {
  let mcp;
  before(async () => {
    mcp = await startServerClient({ name: 'policy-tools', config: { tools: { browser_tabs: false } } });
  });
  after(async () => { await mcp?.close(); });

  test('server.json gets a tool entry for each tool; dangerous tools are disabled; other keys stay', async () => {
    const config = JSON.parse(fs.readFileSync(path.join(mcp.config.configDir, 'server.json'), 'utf8'));
    const names = (await mcp.client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(Object.keys(config.tools).sort(), [...names].sort());
    for (const name of Object.keys(DANGEROUS_TOOLS).filter((tool) => tool !== 'browser_evaluate')) assert.equal(config.tools[name].enabled, false, name);
    assert.equal(config.tools.browser_tabs.enabled, false);
    assert.equal(config.tools.browser_navigate.enabled, true);
    assert.equal(config.providers.length, 3);
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

describe('host access', () => {
  test('a denied site is not opened', async () => {
    const mcp = await startServerClient({ name: 'policy-deny', config: { sites: { localhost: { access: 'deny' } } } });
    try {
      const result = await callText(mcp.client, 'browser_navigate', { url: `${site.otherUrl}/` });
      assert.equal(result.isError, true);
      assert.equal(result.text, `### Error\nNavigation blocked: ${site.otherUrl}/ is not allowed. The host localhost is denied.`);
      assert.equal(await evaluate(mcp.client, '() => location.href'), 'about:blank');
    } finally {
      await mcp.close();
    }
  });

  test('a redirect and a click to a denied site end on about:blank', async () => {
    const mcp = await startServerClient({ name: 'policy-redirect', config: { sites: { localhost: { access: 'deny' } } } });
    try {
      const target = encodeURIComponent(`${site.otherUrl}/form.html`);
      const redirected = await callText(mcp.client, 'browser_navigate', { url: `${site.url}/redirect?to=${target}` });
      assert.equal(redirected.isError, true);
      assert.match(redirected.text, /Navigation blocked: http:\/\/localhost:\d+\/form\.html is not allowed\. The host localhost is denied\. The browser shows about:blank\./);
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

  test('with defaultAccess "deny", only allowed sites open; the server does not change sites.json', async () => {
    const mcp = await startServerClient({ name: 'policy-allow', config: { defaultAccess: 'deny', sites: { '127.0.0.1': { access: 'allow' } } } });
    try {
      const file = path.join(mcp.config.configDir, 'sites.json');
      const before = fs.readFileSync(file, 'utf8');
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/` });
      const blocked = await callText(mcp.client, 'browser_navigate', { url: `${site.otherUrl}/` });
      assert.match(blocked.text, /The host localhost is not allowed\./);
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'no record without the discovery mode');
    } finally {
      await mcp.close();
    }
  });

  test('the discovery mode records each loaded host in sites.json; the other entries stay', async () => {
    const mcp = await startServerClient({ name: 'policy-record', env: { BROWSER_AUTOMATION_X_MCP_DISCOVER: '1' } });
    try {
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/` });
      await call(mcp.client, 'browser_navigate', { url: `${site.otherUrl}/` });
      const found = await waitFor(() => mcp.sites.sites, (sites) => sites.localhost?.access === 'allow');
      assert.equal(found['127.0.0.1'].access, 'allow');
      assert.deepEqual(found.localhost, { 'provider-config': { vault: { vault: 'vault-test', entry: 'Fixture other' } }, access: 'allow' });
    } finally {
      await mcp.close();
    }
  });
});

// The secrets of the fake vault for 127.0.0.1 (tests/fixtures/fake-vault/vault.json).
const USERNAME = 'fixture-user';
const PASSWORD = 'Fixture-Pa55-word';

describe('form fill', () => {
  const sites = {
    '127.0.0.1': {
      pages: {
        '/account.html': { fields: { '#username': 'username', 'input[name="password"]': 'password', '#name': 'name', '#phone': 'phone' } },
        '/login*': { fields: { 'input[autocomplete="username"]': 'username', '#pass': 'password' } },
        '/twostep.html': { fields: { '#login-user': 'username', '#login-pass': 'password' } },
      },
    },
  };
  let mcp;
  let asked;

  before(async () => {
    asked = [];
    mcp = await startServerClient({
      name: 'policy-fill',
      config: { sites, values: { name: 'Anna Nowak' } },
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

  test('a page without a page entry in sites.json gets no fill', async () => {
    const before = site.submissions.length;
    await call(mcp.client, 'browser_navigate', { url: `${site.url}/form.html` });
    await call(mcp.client, 'browser_navigate', { url: `${site.otherUrl}/account.html` });
    assert.equal(site.submissions.length, before);
  });
});

describe('form fill without dialogs', () => {
  test('the ask provider is skipped when the client cannot show dialogs', async () => {
    const mcp = await startServerClient({ name: 'policy-nodialog', config: { sites: { '127.0.0.1': { pages: { '/account.html': { fields: { '#phone': 'phone' } } } } } } });
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

describe('approval', () => {
  const sites = { '127.0.0.1': { pages: { '/login*': { fields: { 'input[autocomplete="username"]': 'username', '#pass': 'password' } } } } };
  const providers = () => [
    { type: 'vault', enabled: true, mask: true, vault: 'vault-test', approval: { type: 'approve-dialog' } },
    { type: 'values', enabled: true, mask: false, values: { password: 'not-this' } },
  ];

  test('one dialog for all keys of the fill; the fill follows the approval', async () => {
    const asked = [];
    const mcp = await startServerClient({
      name: 'policy-approve',
      config: { sites, providers: providers() },
      onElicit: async (params) => {
        asked.push(params);
        return { action: 'accept', content: { approve: true } };
      },
    });
    try {
      const before = site.submissions.length;
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/login.html` });
      assert.equal(site.submissions.length, before + 1);
      assert.deepEqual(site.submissions.at(-1), { user: USERNAME, pass: PASSWORD });
      assert.equal(asked.length, 1);
      assert.match(asked[0].message, /fills username, password on 127\.0\.0\.1 for test-policy-approve/);
      assert.doesNotMatch(JSON.stringify(asked[0]), new RegExp(`${PASSWORD}|${USERNAME}|login\\.html`));
      assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_approved'));
    } finally {
      await mcp.close();
    }
  });

  test('a declined approval stops the fill; no later provider fills the field', async () => {
    const mcp = await startServerClient({
      name: 'policy-approve-no',
      config: { sites, providers: providers() },
      onElicit: async () => ({ action: 'decline' }),
    });
    try {
      const before = site.submissions.length;
      const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/login.html` });
      assert.equal(site.submissions.length, before);
      assert.match(text, /### Note\nThe user did not approve an action on this page\./);
      assert.doesNotMatch(text, /fill|provider/i);
      assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_refused'));
      assert.equal(await evaluate(mcp.client, `() => document.getElementById('pass').value`), '');
    } finally {
      await mcp.close();
    }
  });
});

describe('discovery', () => {
  const DISCOVER = { BROWSER_AUTOMATION_X_MCP_DISCOVER: '1' };

  test('writes the fields that the user filled with the keys of the values, and the button that the user clicked', async () => {
    const mcp = await startServerClient({ name: 'policy-discover-user', env: DISCOVER, config: { values: { nickname: 'someone' } } });
    try {
      // The agent types into the note field. The page then acts as the user: it fills the
      // username and clicks Send, without a call of the agent.
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/user-step.html` });
      const snapshot = await call(mcp.client, 'browser_snapshot');
      await call(mcp.client, 'browser_type', { target: ref(snapshot, 'textbox', 'Note'), element: 'Note', text: 'hello' });
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/user-step.html?user=1` });
      const calls = readLog(mcp.logFile).filter((entry) => entry.event === 'tool_call').length;
      const page = await waitFor(() => sitesPage(mcp, '127.0.0.1', '/user-step.html'), (p) => p?.submit);
      assert.deepEqual(page, { fields: { 'input[autocomplete="username"]': 'nickname' }, submit: ['#send'] });
      const log = readLog(mcp.logFile);
      assert.equal(log.filter((entry) => entry.event === 'tool_call').length, calls, 'no call of the agent');
      for (const event of ['agent_filled', 'user_filled', 'user_pressed', 'fields_written']) assert.ok(log.some((entry) => entry.event === event), event);
      assert.match(log.find((entry) => entry.event === 'user_filled').at, /^\d\d:\d\d:\d\d$/);
      assert.doesNotMatch(fs.readFileSync(mcp.logFile, 'utf8'), /someone|hello/);
    } finally {
      await mcp.close();
    }
  });

  test('a login: the vault gives the keys; the link that the user followed goes into login; no value is written', async () => {
    const mcp = await startServerClient({ name: 'policy-discover-login', env: DISCOVER });
    try {
      // signin.html acts as the user: it follows the sign-in link; login.html fills and signs in.
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/signin.html?user=1` });
      const login = await waitFor(() => sitesPage(mcp, '127.0.0.1', '/login.html'), (p) => p?.submit);
      assert.deepEqual(login.fields, { 'input[autocomplete="username"]': 'username', 'input[name="pass"]': 'password' });
      assert.deepEqual(login.submit, ['button[type="submit"]']);
      assert.deepEqual(sitesPage(mcp, '127.0.0.1', '/signin.html').login, ['internal:role=link[name="Hello, sign in Account"i]']);
      const followed = readLog(mcp.logFile).find((entry) => entry.event === 'user_followed');
      assert.equal(followed.target, '127.0.0.1/login.html');
      for (const text of [fs.readFileSync(mcp.logFile, 'utf8'), fs.readFileSync(mcp.sitesFile, 'utf8')]) {
        assert.ok(!text.includes(PASSWORD) && !text.includes(USERNAME), 'a value is visible');
      }
    } finally {
      await mcp.close();
    }
  });

  test('a subdomain: the root domain gets the access; the pages go into "subdomains"; the vault config of the parent applies', async () => {
    const vault = { vault: { vault: 'vault-test', entry: 'Fixture site' } };
    const mcp = await startServerClient({ name: 'policy-discover-subdomain', env: DISCOVER, config: { sites: { 'a.localhost': { 'provider-config': vault } } } });
    try {
      const url = site.url.replace('127.0.0.1', 'www.a.localhost');
      await call(mcp.client, 'browser_navigate', { url: `${url}/signin.html?user=1` });
      const root = await waitFor(() => mcp.sites.sites['a.localhost'], (s) => s?.subdomains?.['www.a.localhost']?.pages?.['/login.html']?.submit);
      assert.equal(root.access, 'allow');
      assert.deepEqual(root['provider-config'], vault);
      assert.deepEqual(root.subdomains['www.a.localhost'].pages['/login.html'].fields,
        { 'input[autocomplete="username"]': 'username', 'input[name="pass"]': 'password' });
      assert.equal(root.pages, undefined, 'the pages of a subdomain do not go into the root domain');
      assert.equal(mcp.sites.sites['www.a.localhost'], undefined, 'no site for the subdomain');
    } finally {
      await mcp.close();
    }
  });

  test('a submit without a button: the submit button of the form, else "enter"; a field without a key gets its name', async () => {
    const mcp = await startServerClient({ name: 'policy-discover-enter', env: DISCOVER });
    try {
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/enter.html?user=plain` });
      const plain = await waitFor(() => sitesPage(mcp, '127.0.0.1', '/enter.html'), (p) => p?.submit);
      assert.deepEqual(plain, { fields: { 'input[name="code"]': 'code' }, submit: ['enter'] });
      // The token of localhost is a value of the vault, but 127.0.0.1 has an other vault system.
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/enter.html?user=button` });
      const both = await waitFor(() => sitesPage(mcp, '127.0.0.1', '/enter.html'), (p) => p?.submit?.length === 2);
      assert.deepEqual(both, { fields: { 'input[name="code"]': 'code', 'input[name="token"]': 'token' }, submit: ['enter', '#go'] });
    } finally {
      await mcp.close();
    }
  });

  test('a match replaces a name; the user can change sites.json while the server runs', async () => {
    const mcp = await startServerClient({
      name: 'policy-discover-keep',
      env: DISCOVER,
      config: { sites: { '127.0.0.1': { note: 'mine', pages: { '/user-step.html': { fields: { 'input[autocomplete="username"]': 'old-name' } } } } }, values: { login: 'someone' } },
    });
    try {
      const sites = mcp.sites;
      sites.sites['example.org'] = { access: 'deny' };
      fs.writeFileSync(mcp.sitesFile, JSON.stringify(sites));
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/user-step.html?user=1` });
      const page = await waitFor(() => sitesPage(mcp, '127.0.0.1', '/user-step.html'), (p) => p?.submit);
      assert.deepEqual(page.fields, { 'input[autocomplete="username"]': 'login' });
      assert.equal(mcp.sites.sites['127.0.0.1'].note, 'mine');
      assert.deepEqual(mcp.sites.sites['example.org'], { access: 'deny' });
    } finally {
      await mcp.close();
    }
  });

  test('the form fill fills the known fields and does not submit; value providers do not fill', async () => {
    const mcp = await startServerClient({
      name: 'policy-discover-fill',
      env: DISCOVER,
      config: { sites: { '127.0.0.1': { pages: { '/account.html': { fields: { '#username': 'username', '#phone': 'phone' } } } } } },
      onElicit: async () => ({ action: 'accept', content: { value: '+48 600 100 200' } }),
    });
    try {
      const before = site.submissions.length;
      const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/account.html` });
      assert.equal(site.submissions.length, before);
      assert.doesNotMatch(text, /Page Title: Submitted/);
      assert.equal(await evaluate(mcp.client, `() => document.getElementById('username').value`), '***');
      assert.equal(await evaluate(mcp.client, `() => document.getElementById('phone').value`), '');
      assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_filled'));
    } finally {
      await mcp.close();
    }
  });
});

describe('label locators and submits', () => {
  test('the server fills with a label locator and clicks the first visible submit', async () => {
    const mcp = await startServerClient({
      name: 'policy-label',
      config: {
        sites: { '127.0.0.1': { pages: { '/label.html': { fields: { 'internal:label="Nickname"s': 'nickname' }, submit: ['#missing', '#go'] } } } },
        values: { nickname: 'Nick' },
      },
    });
    try {
      const count = site.submissions.length;
      const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/label.html` });
      assert.match(text, /Page Title: Submitted/);
      assert.equal(site.submissions.length, count + 1);
      assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_submitted' && entry.how === '#go'));
    } finally {
      await mcp.close();
    }
  });

  test('"enter" in submit presses Enter in the last field', async () => {
    const mcp = await startServerClient({
      name: 'policy-enter',
      config: { sites: { '127.0.0.1': { pages: { '/enter.html': { fields: { '#code': 'code' }, submit: ['enter', '#go'] } } } }, values: { code: 'C-1' } },
    });
    try {
      const count = site.submissions.length;
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/enter.html` });
      assert.equal(site.submissions.length, count + 1);
      assert.deepEqual(site.submissions.at(-1), { code: 'C-1' });
      assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_submitted' && entry.how === 'enter'));
    } finally {
      await mcp.close();
    }
  });
});

describe('host check after an auto-submit', () => {
  test('a redirect to a denied site after a submit stops the chain before the next fill', async () => {
    const mcp = await startServerClient({
      name: 'policy-hop',
      config: {
        sites: {
          '127.0.0.1': { pages: { '/hop.html': { fields: { '#username': 'username' } } } },
          localhost: { access: 'deny', pages: { '/password.html': { fields: { '#password': 'password' } } } },
        },
      },
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

describe('login link', () => {
  const sites = {
    '127.0.0.1': {
      pages: {
        '/signin.html': { login: ['internal:role=link[name="sign in"i]'] },
        '/login*': { fields: { 'input[autocomplete="username"]': 'username', '#pass': 'password' } },
      },
    },
  };

  test('a visible login link of a site with a vault config gets one click; the login page gets the fill', async () => {
    const mcp = await startServerClient({ name: 'policy-login', config: { sites } });
    try {
      const before = site.submissions.length;
      const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/signin.html` });
      assert.equal(site.submissions.length, before + 1);
      assert.deepEqual(site.submissions.at(-1), { user: USERNAME, pass: PASSWORD });
      assert.match(text, /Page Title: Login/);
      const log = readLog(mcp.logFile);
      assert.ok(log.some((entry) => entry.event === 'login_clicked' && entry.selector === 'internal:role=link[name="sign in"i]'));
      assert.ok(log.some((entry) => entry.event === 'page_opened' && entry.via === 'auto_login'));

      // One click for each lane and host.
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/signin.html` });
      assert.equal(readLog(mcp.logFile).filter((entry) => entry.event === 'login_clicked').length, 1);
    } finally {
      await mcp.close();
    }
  });

  test('no click when the link text shows the login, or when the site has no vault config', async () => {
    for (const [name, url, providerConfig] of [
      ['policy-login-in', `${site.url}/signin.html?in=1`, true],
      ['policy-login-novault', `${site.url}/signin.html`, false],
    ]) {
      const mcp = await startServerClient({ name, config: { sites, providerConfig } });
      try {
        const text = await call(mcp.client, 'browser_navigate', { url });
        assert.match(text, /Page Title: Shop home/, name);
        assert.ok(!readLog(mcp.logFile).some((entry) => entry.event === 'login_clicked'), name);
      } finally {
        await mcp.close();
      }
    }
  });
});
