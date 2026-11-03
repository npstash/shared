// The server forwards the tools of Playwright MCP 1:1, and it logs each call.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ASSETS_DIR, TOOL_DIR } from '../../src/paths.js';
import { UPSTREAM_CLI, upstreamEnv } from '../src/config.js';
import { call, evaluate, ref, startServerClient, startSite } from './helpers.js';

function readLog(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('tools', () => {
  let site;
  let mcp;
  let client;

  before(async () => {
    site = await startSite();
    mcp = await startServerClient({ name: 'tools' });
    client = mcp.client;
  });

  after(async () => {
    await mcp?.close();
    await site?.close();
  });

  test('gives the same tools as Playwright MCP', async () => {
    const args = ['--headless', '--isolated'];
    const upstream = new Client({ name: 'test-upstream', version: '0' });
    await upstream.connect(new StdioClientTransport({
      command: process.execPath,
      args: [UPSTREAM_CLI, ...args],
      env: upstreamEnv(args),
      cwd: TOOL_DIR,
    }));
    try {
      // The server changes only texts: the name Playwright and notes of disabled tools. Names stay.
      const expected = (await upstream.listTools()).tools;
      const actual = (await client.listTools()).tools;
      assert.ok(expected.length > 10);
      assert.deepEqual(actual.map((tool) => tool.name), expected.map((tool) => tool.name));
      assert.deepEqual(actual.map((tool) => Object.keys(tool.inputSchema.properties ?? {})), expected.map((tool) => Object.keys(tool.inputSchema.properties ?? {})));
    } finally {
      await upstream.close();
    }
  });

  test('no text for the client names upstream, Playwright or the form fill', async () => {
    const texts = [
      JSON.stringify(client.getServerVersion()),
      client.getInstructions(),
      JSON.stringify((await client.listTools()).tools),
      await call(client, 'browser_navigate', { url: `${site.url}/form.html` }),
      await call(client, 'browser_click', { target: 'e9999', element: 'missing' }).catch((error) => error.message),
    ];
    for (const text of texts) assert.doesNotMatch(text, /upstream|playwright|placeholder|credential|vault|provider|fill_values/i);
    assert.equal(client.getServerVersion().name, 'browser-automation-x-mcp');
    assert.match(client.getInstructions(), /^Use the tools of this server for each browser automation task when they are available\. This is mandatory\.$/m);
  });

  test('navigates, reads a page and follows a link', async () => {
    const text = await call(client, 'browser_navigate', { url: `${site.url}/` });
    assert.match(text, /Page Title: Fixture home/);

    const snapshot = await call(client, 'browser_snapshot');
    assert.match(snapshot, /heading "Fixture home"/);
    assert.match(snapshot, /Test pages of the server/);

    await call(client, 'browser_click', { target: ref(snapshot, 'link', 'Registration form'), element: 'Registration form link' });
    assert.equal(await evaluate(client, '() => location.pathname'), '/form.html');

    await call(client, 'browser_navigate_back');
    assert.equal(await evaluate(client, '() => location.pathname'), '/');
  });

  test('gives a tool error of upstream back to the client', async () => {
    await call(client, 'browser_navigate', { url: `${site.url}/` });
    const result = await client.callTool({ name: 'browser_click', arguments: { target: 'e9999', element: 'missing' } });
    assert.equal(result.isError, true);
  });

  test('gives an error for an unknown tool', async () => {
    const result = await client.callTool({ name: 'no_such_tool', arguments: {} }).catch((error) => ({ error }));
    assert.ok(result.error || result.isError);
  });

  test('takes a screenshot', async () => {
    await call(client, 'browser_navigate', { url: `${site.url}/` });
    const result = await client.callTool({ name: 'browser_take_screenshot', arguments: {} });
    const image = result.content.find((part) => part.type === 'image');
    assert.ok(image, 'no image in the result');
    assert.equal(image.mimeType, 'image/png');
  });

  test('logs each tool call and its result', async () => {
    await call(client, 'browser_navigate', { url: `${site.url}/` });
    const entries = readLog(mcp.logFile);
    const events = new Set(entries.map((entry) => entry.event));
    for (const event of ['upstream_start', 'upstream_ready', 'client_ready', 'list_tools', 'tool_call', 'tool_result']) {
      assert.ok(events.has(event), `no ${event} entry`);
    }
    const call_ = entries.findLast((entry) => entry.event === 'tool_call' && entry.tool === 'browser_navigate');
    assert.deepEqual(call_.args, { url: `${site.url}/` });
    const result = entries.find((entry) => entry.event === 'tool_result' && entry.id === call_.id);
    assert.equal(result.isError, false);
    assert.equal(typeof result.ms, 'number');
  });

  test('writes a human log beside the JSON log: short lines without level and session', async () => {
    assert.ok(mcp.logFile.includes(`${path.sep}test-tools${path.sep}`));
    assert.equal(mcp.textLogFile, mcp.logFile.replace(/\.json$/, ''));
    const lines = fs.readFileSync(mcp.textLogFile, 'utf8').trim().split('\n');
    assert.ok(lines.some((line) => /^\d\d:\d\d:\d\d tool_call id=\d+ tool=browser_navigate args=url:127\.0\.0\.1:\d+\/$/.test(line)), lines.join('\n'));
    for (const line of lines) {
      assert.match(line, /^\d\d:\d\d:\d\d [a-z_-]+/);
      assert.ok(line.length <= 160, line);
      assert.doesNotMatch(line, /"level"|session=/);
    }
  });
});

describe('persistent profile', () => {
  test('keeps localStorage from one session to the next; the profile has no Chrome bubbles', async () => {
    const profile = path.join(ASSETS_DIR, 'test-profile');
    fs.rmSync(profile, { recursive: true, force: true });
    const site = await startSite();
    const values = [];
    let prefs;
    try {
      for (const session of [1, 2]) {
        const mcp = await startServerClient({ name: 'profile', args: ['--user-data-dir', profile] });
        try {
          await call(mcp.client, 'browser_navigate', { url: `${site.url}/` });
          if (session === 1) await evaluate(mcp.client, `() => { localStorage.setItem('key', 'kept'); return true; }`);
          values.push(await evaluate(mcp.client, `() => localStorage.getItem('key')`));
        } finally {
          // The client closes the server without browser_close, as Claude Code does.
          await mcp.close();
        }
      }
      // Chrome writes the file again at exit. The settings stay.
      prefs = JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8'));
    } finally {
      await site.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
    assert.deepEqual(values, ['kept', 'kept']);
    assert.equal(prefs.profile.password_manager_leak_detection, false);
    assert.equal(prefs.credentials_enable_service, false);
    assert.equal(prefs.translate.enabled, false);
  });
});

describe('logging of secrets', () => {
  const secret = 'Very-Secret-Value-123';

  async function typeSecret(env) {
    const site = await startSite();
    const mcp = await startServerClient({ name: `secrets-${env.BROWSER_AUTOMATION_X_MCP_LOG_SECRETS ?? 'default'}`, env });
    try {
      await call(mcp.client, 'browser_navigate', { url: `${site.url}/form.html` });
      const snapshot = await call(mcp.client, 'browser_snapshot');
      await call(mcp.client, 'browser_type', { target: ref(snapshot, 'textbox', 'Password'), element: 'Password', text: secret });
      await call(mcp.client, 'browser_fill_form', {
        fields: [{ name: 'Email', type: 'textbox', target: ref(snapshot, 'textbox', 'Email'), value: secret }],
      });
    } finally {
      await mcp.close();
      await site.close();
    }
    return fs.readFileSync(mcp.logFile, 'utf8');
  }

  test('the log has no typed text and no form values by default', async () => {
    const log = await typeSecret({});
    assert.ok(!log.includes(secret), 'the secret is in the log');
    assert.match(log, /<redacted 21 chars>/);
  });

  test('BROWSER_AUTOMATION_X_MCP_LOG_SECRETS=1 logs the values', async () => {
    const log = await typeSecret({ BROWSER_AUTOMATION_X_MCP_LOG_SECRETS: '1' });
    assert.ok(log.includes(secret));
  });
});
