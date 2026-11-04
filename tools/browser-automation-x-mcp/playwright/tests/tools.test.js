// The server forwards the tools of Playwright MCP 1:1 with the parameter lane, and it logs each call.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createConnection } from '@playwright/mcp';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LANE_TOOL_NAMES, call, evaluate, ref, startServerClient, startSite } from './helpers.js';

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

  test('gives the lane tools and the tools of Playwright MCP, each with the parameter lane', async () => {
    const upstreamServer = await createConnection({ browser: { browserName: 'chromium' } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await upstreamServer.connect(serverTransport);
    const upstream = new Client({ name: 'test-upstream', version: '0' });
    await upstream.connect(clientTransport);
    try {
      // The server changes only texts: the name Playwright and notes of disabled tools. Names stay.
      const expected = (await upstream.listTools()).tools;
      const actual = (await client.listTools()).tools;
      assert.ok(expected.length > 10);
      assert.deepEqual(actual.map((tool) => tool.name), [...LANE_TOOL_NAMES, ...expected.map((tool) => tool.name)]);
      const forwarded = actual.filter((tool) => !LANE_TOOL_NAMES.has(tool.name));
      assert.deepEqual(forwarded.map((tool) => Object.keys(tool.inputSchema.properties ?? {})), expected.map((tool) => [...Object.keys(tool.inputSchema.properties ?? {}), 'lane']));
      for (const tool of forwarded) assert.ok(tool.inputSchema.required.includes('lane'), tool.name);
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
    assert.match(client.getInstructions(), /^Use the tools of this server for each browser automation task when they are available\. This is mandatory\. /);
    assert.match(client.getInstructions(), /browser_lane_open/);
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
    for (const event of ['upstream_ready', 'client_ready', 'list_tools', 'browser_started', 'lane_opened', 'tool_call', 'tool_result']) {
      assert.ok(events.has(event), `no ${event} entry`);
    }
    const call_ = entries.findLast((entry) => entry.event === 'tool_call' && entry.tool === 'browser_navigate');
    assert.deepEqual(call_.args, { url: `${site.url}/`, lane: client.lane });
    const result = entries.find((entry) => entry.event === 'tool_result' && entry.id === call_.id);
    assert.equal(result.isError, false);
    assert.equal(typeof result.ms, 'number');
  });

  test('writes a human log beside the JSON log: short lines without level and session', async () => {
    assert.ok(mcp.logFile.includes(`${path.sep}test-tools${path.sep}`));
    assert.equal(mcp.textLogFile, mcp.logFile.replace(/\.json$/, ''));
    const lines = fs.readFileSync(mcp.textLogFile, 'utf8').trim().split('\n');
    assert.ok(lines.some((line) => /^\d\d:\d\d:\d\d tool_call id=\d+ tool=browser_navigate args=url:127\.0\.0\.1:\d+\/,lane:lane-[0-9a-f]+$/.test(line)), lines.join('\n'));
    for (const line of lines) {
      assert.match(line, /^\d\d:\d\d:\d\d [a-z_-]+/);
      assert.ok(line.length <= 160, line);
      assert.doesNotMatch(line, /"level"|session=/);
    }
  });
});

describe('storage state', () => {
  test('keeps cookies and localStorage from one session to the next, in a file with mode 0600', async () => {
    const site = await startSite();
    const values = [];
    let mcp;
    try {
      for (const session of [1, 2]) {
        mcp = await startServerClient({ name: 'state', keepState: session === 2 });
        try {
          await call(mcp.client, 'browser_navigate', { url: `${site.url}/` });
          if (session === 1) await evaluate(mcp.client, `() => { localStorage.setItem('key', 'kept'); document.cookie = 'c=kept; max-age=3600'; return true; }`);
          values.push(await evaluate(mcp.client, `() => [localStorage.getItem('key'), document.cookie]`));
        } finally {
          // The client closes the server without browser_lane_close, as Claude Code does.
          await mcp.close();
        }
      }
    } finally {
      await site.close();
    }
    assert.deepEqual(values, [['kept', 'c=kept'], ['kept', 'c=kept']]);
    assert.equal(fs.statSync(mcp.stateFile).mode & 0o777, 0o600);
    const log = fs.readFileSync(mcp.logFile, 'utf8');
    assert.ok(!log.includes('kept'), 'a value of the storage state is in the log');
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
