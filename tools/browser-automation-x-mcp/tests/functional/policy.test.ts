// End-to-end tests of the policy layer: tool switches, host access, form fill with the plugins,
// approval, login link and the discovery recorder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js';
import { DANGEROUS_TOOLS } from '../../playwright/src/mcp-server.ts';
import type { ServerClient, TestForm, TestNode, TestSite } from '../helpers.ts';
import { call, callText, evaluate, readLog, ref, startServerClient, startSite, snapshotText, takeSnapshot } from '../helpers.ts';

let site: TestSite;
before(async () => { site = await startSite(); });
after(async () => { await site?.close(); });

// Wait until check(value of get()) is true, a maximum of 5 s. Give the last value.
async function waitFor<T>(get: () => T, check: (value: T) => unknown): Promise<T> {
  let value = get();
  for (let i = 0; i < 50 && !check(value); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = get();
  }
  return value;
}

// The form of a node of the discovery file of the test with the selector, or undefined.
function learnedForm(mcp: ServerClient, host: string, selector: string): TestForm | undefined {
  return mcp.discovery.hosts[host]?.forms?.find((form) => form?.fields?.[selector] !== undefined);
}

describe('tool switches', () => {
  let mcp: ServerClient;
  before(async () => {
    mcp = await startServerClient({ name: 'policy-tools', config: { tools: { browser_tabs: false } } });
  });
  after(async () => { await mcp?.close(); });

  test('server.json gets a tool entry for each tool; dangerous tools are disabled; other keys stay', async () => {
    const config = JSON.parse(fs.readFileSync(path.join(mcp.config.configDir, 'server.json'), 'utf8')) as { tools: Record<string, { enabled: boolean }>; plugins: Record<string, unknown[]> };
    const names = (await mcp.client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(Object.keys(config.tools).sort(), [...names].sort());
    for (const name of Object.keys(DANGEROUS_TOOLS).filter((tool) => tool !== 'browser_evaluate')) assert.equal(config.tools[name]?.enabled, false, name);
    assert.equal(config.tools.browser_tabs?.enabled, false);
    assert.equal(config.tools.browser_navigate?.enabled, true);
    assert.equal(config.plugins['key-value-source']?.length, 2);
  });

  test('a disabled tool stays in the list and fails with the reason', async () => {
    const tools = (await mcp.client.listTools()).tools;
    assert.match(tools.find((tool) => tool.name === 'browser_run_code_unsafe')?.description ?? '', /^DISABLED: this tool is turned off in the configuration\. /);
    const result = await callText(mcp.client, 'browser_run_code_unsafe', { code: 'async (page) => 1' });
    assert.equal(result.isError, true);
    assert.match(result.text, /The tool browser_run_code_unsafe did not run: this tool is turned off in the configuration\. Reason: it runs any JavaScript/);
    assert.equal((await callText(mcp.client, 'browser_tabs', { action: 'list' })).text,
      '### Error\nThe tool browser_tabs did not run: this tool is turned off in the configuration.');
  });
});

describe('host access', () => {
  test('a denied host is not opened', async () => {
    const mcp = await startServerClient({ name: 'policy-deny', config: { hosts: { localhost: { access: 'deny' } } } });
    try {
      const result = await callText(mcp.client, 'browser_navigate', { url: `${site.otherUrl}/` });
      assert.equal(result.isError, true);
      assert.equal(result.text, `### Error\nNavigation blocked: ${site.otherUrl}/ is not allowed. The host localhost is denied.`);
      assert.equal(await evaluate(mcp.client, '() => location.href'), 'about:blank');
    } finally {
      await mcp.close();
    }
  });

  test('a redirect and a click to a denied host end on about:blank', async () => {
    const mcp = await startServerClient({ name: 'policy-redirect', config: { hosts: { localhost: { access: 'deny' } } } });
    try {
      const target = encodeURIComponent(`${site.otherUrl}/form.html`);
      const redirected = await callText(mcp.client, 'browser_navigate', { url: `${site.url}/redirect?to=${target}` });
      assert.equal(redirected.isError, true);
      assert.match(redirected.text, /Navigation blocked: http:\/\/localhost:\d+\/form\.html is not allowed\. The host localhost is denied\. The browser shows about:blank\./);
      assert.equal(await evaluate(mcp.client, '() => location.href'), 'about:blank');

      await call(mcp.client, 'browser_navigate', { url: `${site.url}/link?to=${target}` });
      const snapshot = await takeSnapshot(mcp.client);
      const clicked = await callText(mcp.client, 'browser_click', { target: ref(snapshot, 'link', 'Go there'), element: 'link' });
      assert.equal(clicked.isError, true);
      assert.equal(await evaluate(mcp.client, '() => location.href'), 'about:blank');
    } finally {
      await mcp.close();
    }
  });

  test('with defaultAccess "deny", only allowed hosts open; without recordHosts, hosts.json stays', async () => {
    const mcp = await startServerClient({ name: 'policy-allow', config: { defaultAccess: 'deny', hosts: { '127.0.0.1': { access: 'allow' } } } });
    try {
      const file = path.join(mcp.config.configDir, 'hosts.json');
      const before = fs.readFileSync(file, 'utf8');
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/` });
      const blocked = await callText(mcp.client, 'browser_navigate', { url: `${site.otherUrl}/` });
      assert.match(blocked.text, /The host localhost is not allowed\./);
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'no record without recordHosts');
    } finally {
      await mcp.close();
    }
  });

  test('recordHosts records each loaded host in hosts.json; the other entries stay', async () => {
    const mcp = await startServerClient({ name: 'policy-record', config: { recordHosts: true, hosts: { 'example.org': { access: 'deny' } } } });
    try {
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/` });
      await call(mcp.client, 'browser_navigate', { url: `${site.otherUrl}/` });
      const found = await waitFor(() => mcp.hosts.hosts, (hosts) => hosts.localhost?.access === 'allow');
      assert.deepEqual(found['127.0.0.1'], { access: 'allow' });
      assert.deepEqual(found.localhost, { access: 'allow' });
      assert.deepEqual(found['example.org'], { access: 'deny' });
    } finally {
      await mcp.close();
    }
  });
});

// The secrets of the fake vault for 127.0.0.1 (tests/fixtures/fake-vault/vault.json).
const USERNAME = 'fixture-user';
const PASSWORD = 'Fixture-Pa55-word';

describe('form fill', () => {
  const forms: Record<string, TestNode> = {
    '127.0.0.1': {
      forms: [
        { fields: { '#username': 'username', 'input[name="password"]': 'password', '#name': 'name', '#phone': 'phone' } },
        { fields: { 'input[autocomplete="username"]': 'username', '#pass': 'password' } },
        { fields: { '#login-user': 'username' } },
        { fields: { '#login-pass': 'password' } },
      ],
    },
  };
  let mcp: ServerClient;

  before(async () => {
    mcp = await startServerClient({ name: 'policy-fill', config: { forms, values: { name: 'Anna Nowak', phone: '+48 600 100 200' } } });
  });
  after(async () => { await mcp?.close(); });

  test('the server fills and submits; the client sees the page after the submit and *** for masked values', async () => {
    const before = site.submissions.length;
    const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/account.html` });
    assert.equal(site.submissions.length, before + 1);
    assert.deepEqual(site.submissions.at(-1), { name: 'Anna Nowak', email: '', phone: '+48 600 100 200', username: USERNAME, password: PASSWORD, note: '' });

    // The result is the page after the submit. The values source is not masked.
    assert.match(text, /Page Title: Submitted/);
    const page = snapshotText(text);
    assert.match(page, /Anna Nowak/);
    assert.match(page, /\*\*\*/);
    assert.doesNotMatch(text, /Ran Playwright code|Playwright/);
    const shown = await evaluate(mcp.client, `() => JSON.parse(document.getElementById('result').textContent)`) as { password: string };
    assert.equal(shown.password, '***');
    for (const output of [text, page, fs.readFileSync(mcp.logFile, 'utf8')]) {
      for (const secret of [USERNAME, PASSWORD]) assert.ok(!output.includes(secret), `"${secret}" is visible`);
    }
    // The learned form has no submit: the heuristic classifier gives the button of the form.
    assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_submitted' && entry.how === 'click' && entry.classifier === 'heuristic'));
    const noField = readLog(mcp.logFile).find((entry) => entry.event === 'fill_no_field');
    assert.equal(noField?.waited, 3000, 'the page after the submit has no field');
  });

  test('the same fill after the submit gets no second fill', async () => {
    const before = site.submissions.length;
    const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/login.html` });
    assert.equal(site.submissions.length, before + 1);
    assert.deepEqual(site.submissions.at(-1), { user: USERNAME, pass: PASSWORD });
    assert.match(text, /Page Title: Login/);
    await takeSnapshot(mcp.client);
    assert.equal(site.submissions.length, before + 1);
    assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_failed'));
  });

  test('a second step on the same URL with other keys gets a fill in the same call', async () => {
    const before = site.submissions.length;
    const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/twostep.html` });
    assert.equal(site.submissions.length, before + 1);
    assert.deepEqual(site.submissions.at(-1), { username: USERNAME, password: PASSWORD });
    assert.match(text, /Page Title: Submitted/);
  });

  test('a page without a classified field gets no fill; no fill_no_field outside a login flow', async () => {
    const before = site.submissions.length;
    await call(mcp.client, 'browser_navigate', { url: `${site.url}/index.html` });
    await call(mcp.client, 'browser_navigate', { url: `${site.otherUrl}/account.html` });
    assert.equal(site.submissions.length, before);
    assert.ok(!readLog(mcp.logFile).some((entry) => entry.event === 'fill_no_field' && String(entry.url).endsWith('/index.html')));
  });
});

describe('form fill without a key', () => {
  test('a field whose hint is no key of a source gets no fill', async () => {
    const mcp = await startServerClient({ name: 'policy-nokey', config: { forms: { '127.0.0.1': { forms: [{ fields: { '#phone': 'phone' } }] } } } });
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

describe('heuristic fields', () => {
  test('with "fields": true, the heuristic classifier fills a login form that nobody learned', async () => {
    const mcp = await startServerClient({ name: 'policy-heuristic', config: { heuristicFields: true } });
    try {
      const before = site.submissions.length;
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/login.html` });
      assert.equal(site.submissions.length, before + 1);
      assert.deepEqual(site.submissions.at(-1), { user: USERNAME, pass: PASSWORD });
    } finally {
      await mcp.close();
    }
  });

  test('with "fields": false, a form that nobody learned gets no fill', async () => {
    const mcp = await startServerClient({ name: 'policy-heuristic-off' });
    try {
      const before = site.submissions.length;
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/login.html` });
      assert.equal(site.submissions.length, before);
    } finally {
      await mcp.close();
    }
  });
});

describe('approval', () => {
  const forms: Record<string, TestNode> = { '127.0.0.1': { forms: [{ fields: { 'input[autocomplete="username"]': 'username', '#pass': 'password' } }] } };
  const sources = (): Record<string, unknown>[] => [
    { name: 'vault-test', plugin: 'vault', description: 'vault of the test', enabled: true, mask: true, config: { vault: 'vault-test', file: 'vault.json' }, approval: { plugin: 'approve-dialog', config: {} } },
    { name: 'values', plugin: 'values', description: 'values of the test', enabled: true, mask: false, config: { values: { password: 'not-this' } } },
  ];

  test('one dialog for all keys of the fill; the fill follows the approval', async () => {
    const asked: ElicitRequest['params'][] = [];
    const mcp = await startServerClient({
      name: 'policy-approve',
      config: { forms, sources: sources() },
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
      assert.match(asked[0]?.message ?? '', /fills username, password on 127\.0\.0\.1 for test-policy-approve/);
      assert.doesNotMatch(JSON.stringify(asked[0]), new RegExp(`${PASSWORD}|${USERNAME}|login\\.html`));
      assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_approved'));
    } finally {
      await mcp.close();
    }
  });

  test('a declined approval stops the fill; no later source fills the field', async () => {
    const mcp = await startServerClient({
      name: 'policy-approve-no',
      config: { forms, sources: sources() },
      onElicit: async () => ({ action: 'decline' }),
    });
    try {
      const before = site.submissions.length;
      const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/login.html` });
      assert.equal(site.submissions.length, before);
      assert.match(text, /### Note\nThe user did not approve an action on this page\./);
      assert.doesNotMatch(text, /fill|provider|plugin/i);
      assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_refused'));
      assert.equal(await evaluate(mcp.client, `() => document.getElementById('pass').value`), '');
    } finally {
      await mcp.close();
    }
  });
});

describe('discovery recorder', () => {
  test('writes the fields that the user filled with the keys of the values, and the button that the user clicked', async () => {
    const mcp = await startServerClient({ name: 'policy-discover-user', config: { record: true, values: { nickname: 'someone' } } });
    try {
      // The agent types into the note field. The page then acts as the user: it fills the
      // username and clicks Send, without a call of the agent.
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/user-step.html` });
      const snapshot = await takeSnapshot(mcp.client);
      await call(mcp.client, 'browser_type', { target: ref(snapshot, 'textbox', 'Note'), element: 'Note', text: 'hello' });
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/user-step.html?user=1` });
      const calls = readLog(mcp.logFile).filter((entry) => entry.event === 'tool_call').length;
      const form = await waitFor(() => learnedForm(mcp, '127.0.0.1', 'input[autocomplete="username"]'), (f) => f?.submit);
      assert.deepEqual(mcp.discovery.hosts['127.0.0.1']?.forms, [{ fields: { 'input[autocomplete="username"]': 'nickname' }, submit: ['#send'] }]);
      assert.ok(form);
      const log = readLog(mcp.logFile);
      assert.equal(log.filter((entry) => entry.event === 'tool_call').length, calls, 'no call of the agent');
      for (const event of ['user_filled', 'user_pressed', 'fields_written']) assert.ok(log.some((entry) => entry.event === event), event);
      assert.match(String(log.find((entry) => entry.event === 'user_filled')?.at), /^\d\d:\d\d:\d\d$/);
      assert.doesNotMatch(fs.readFileSync(mcp.logFile, 'utf8'), /someone|hello/);
    } finally {
      await mcp.close();
    }
  });

  test('a login: the vault gives the keys; the link that the user followed goes into login; no value is written', async () => {
    const mcp = await startServerClient({ name: 'policy-discover-login', config: { record: true } });
    try {
      // signin.html acts as the user: it follows the sign-in link; login.html fills and signs in.
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/signin.html?user=1` });
      const login = await waitFor(() => learnedForm(mcp, '127.0.0.1', 'input[name="pass"]'), (f) => f?.submit);
      assert.deepEqual(login?.fields, { 'input[autocomplete="username"]': 'username', 'input[name="pass"]': 'password' });
      assert.deepEqual(login?.submit, ['button[type="submit"]']);
      assert.deepEqual(mcp.discovery.hosts['127.0.0.1']?.login, [{ css: 'a', text: 'Hello, sign in Account' }]);
      const followed = readLog(mcp.logFile).find((entry) => entry.event === 'user_followed');
      assert.equal(followed?.target, '127.0.0.1/login.html');
      for (const text of [fs.readFileSync(mcp.logFile, 'utf8'), fs.readFileSync(mcp.discoveryFile, 'utf8')]) {
        assert.ok(!text.includes(PASSWORD) && !text.includes(USERNAME), 'a value is visible');
      }
    } finally {
      await mcp.close();
    }
  });

  test('a subdomain: the forms and the login link go into the node of the root domain', async () => {
    const mcp = await startServerClient({ name: 'policy-discover-subdomain', config: { record: true, vaultHosts: { 'a.localhost': { system: 'Fixture site' } } } });
    try {
      const url = site.url.replace('127.0.0.1', 'www.a.localhost');
      await call(mcp.client, 'browser_navigate', { url: `${url}/signin.html?user=1` });
      const root = await waitFor(() => mcp.discovery.hosts['a.localhost'], (node) => node?.forms?.[0]?.submit);
      assert.deepEqual(root?.forms, [{ fields: { 'input[autocomplete="username"]': 'username', 'input[name="pass"]': 'password' }, submit: ['button[type="submit"]'] }]);
      assert.deepEqual(root?.login, [{ css: 'a', text: 'Hello, sign in Account' }]);
      assert.equal(root?.subdomains, undefined, 'no node for the subdomain');
      assert.equal(mcp.discovery.hosts['www.a.localhost'], undefined, 'no host for the subdomain');
    } finally {
      await mcp.close();
    }
  });

  test('a submit without a button: the submit button of the form, else "enter"; a field without a key gets its name; a form without a shared selector is a new form', async () => {
    const mcp = await startServerClient({ name: 'policy-discover-enter', config: { record: true } });
    try {
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/enter.html?user=plain` });
      const plain = await waitFor(() => learnedForm(mcp, '127.0.0.1', 'input[name="code"]'), (f) => f?.submit);
      assert.deepEqual(plain, { fields: { 'input[name="code"]': 'code' }, submit: ['enter'] });
      // The token of localhost is a value of the vault, but 127.0.0.1 has an other vault system.
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/enter.html?user=button` });
      await waitFor(() => learnedForm(mcp, '127.0.0.1', 'input[name="token"]'), (f) => f?.submit);
      assert.deepEqual(mcp.discovery.hosts['127.0.0.1']?.forms, [
        { fields: { 'input[name="code"]': 'code' }, submit: ['enter'] },
        { fields: { 'input[name="token"]': 'token' }, submit: ['#go'] },
      ]);
    } finally {
      await mcp.close();
    }
  });

  test('a match replaces a name in the form with the selector; the user can change the file while the server runs', async () => {
    const mcp = await startServerClient({
      name: 'policy-discover-keep',
      config: { record: true, forms: { '127.0.0.1': { note: 'mine', forms: [{ fields: { 'input[autocomplete="username"]': 'old-name' } }] } }, values: { login: 'someone' } },
    });
    try {
      const learned = mcp.discovery;
      learned.hosts['example.org'] = { forms: [{ fields: { '#a': 'a' } }] };
      fs.writeFileSync(mcp.discoveryFile, JSON.stringify(learned));
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/user-step.html?user=1` });
      await waitFor(() => learnedForm(mcp, '127.0.0.1', 'input[autocomplete="username"]'), (f) => f?.submit);
      assert.deepEqual(mcp.discovery.hosts['127.0.0.1']?.forms, [{ fields: { 'input[autocomplete="username"]': 'login' }, submit: ['#send'] }]);
      assert.equal(mcp.discovery.hosts['127.0.0.1']?.note, 'mine');
      assert.deepEqual(mcp.discovery.hosts['example.org'], { forms: [{ fields: { '#a': 'a' } }] });
    } finally {
      await mcp.close();
    }
  });
});

describe('selectors and submits', () => {
  test('the server fills a field of a CSS selector and clicks the first visible submit', async () => {
    const mcp = await startServerClient({
      name: 'policy-selector',
      config: { forms: { '127.0.0.1': { forms: [{ fields: { 'form label input': 'nickname' }, submit: ['#missing', '#go'] }] } }, values: { nickname: 'Nick' } },
    });
    try {
      const count = site.submissions.length;
      const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/label.html` });
      assert.match(text, /Page Title: Submitted/);
      assert.equal(site.submissions.length, count + 1);
      assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'fill_submitted' && entry.how === 'click' && entry.classifier === 'discovery'));
    } finally {
      await mcp.close();
    }
  });

  test('"enter" in submit presses Enter in the last field', async () => {
    const mcp = await startServerClient({
      name: 'policy-enter',
      config: { forms: { '127.0.0.1': { forms: [{ fields: { '#code': 'code' }, submit: ['enter', '#go'] }] } }, values: { code: 'C-1' } },
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
  test('a redirect to a denied host after a submit stops the chain before the next fill', async () => {
    const mcp = await startServerClient({
      name: 'policy-hop',
      config: {
        hosts: { localhost: { access: 'deny' } },
        forms: {
          '127.0.0.1': { forms: [{ fields: { '#username': 'username' } }] },
          localhost: { forms: [{ fields: { '#password': 'password' } }] },
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
  const forms: Record<string, TestNode> = {
    '127.0.0.1': {
      login: [{ css: 'a', text: 'sign in' }],
      forms: [{ fields: { 'input[autocomplete="username"]': 'username', '#pass': 'password' } }],
    },
  };

  test('a visible login link of a host with keys gets one click; the login page gets the fill; then the server opens the start URL again', async () => {
    const mcp = await startServerClient({ name: 'policy-login', config: { forms } });
    try {
      const before = site.submissions.length;
      const text = await call(mcp.client, 'browser_navigate', { url: `${site.url}/signin.html` });
      assert.equal(site.submissions.length, before + 1);
      assert.deepEqual(site.submissions.at(-1), { user: USERNAME, pass: PASSWORD });
      assert.match(text, /Page Title: Shop home/);
      const log = readLog(mcp.logFile);
      assert.ok(log.some((entry) => entry.event === 'login_clicked'));
      assert.ok(log.some((entry) => entry.event === 'page_opened' && entry.via === 'auto_login'));
      assert.ok(log.some((entry) => entry.event === 'page_opened' && entry.via === 'login_return' && String(entry.url).endsWith('/signin.html')));

      // One click for each lane and host.
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/signin.html` });
      assert.equal(readLog(mcp.logFile).filter((entry) => entry.event === 'login_clicked').length, 1);
    } finally {
      await mcp.close();
    }
  });

  test('no click when the link text shows the login, or when no source has keys for the host', async () => {
    const cases: readonly [string, string, boolean][] = [
      ['policy-login-in', `${site.url}/signin.html?in=1`, true],
      ['policy-login-novault', `${site.url}/signin.html`, false],
    ];
    for (const [name, url, withVault] of cases) {
      const mcp = await startServerClient({ name, config: { forms, ...(withVault ? {} : { vaultHosts: false }) } });
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
