// The facade forwards the tools of Playwright MCP 1:1, and it logs each call.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ASSETS_DIR, TOOL_DIR } from '../../src/paths.js';
import { UPSTREAM_CLI, upstreamEnv } from '../src/config.js';
import { call, evaluate, ref, startFacadeClient, startSite } from './helpers.js';

function readLog(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('facade', () => {
  let site;
  let facade;
  let client;

  before(async () => {
    site = await startSite();
    facade = await startFacadeClient({ name: 'facade' });
    client = facade.client;
  });

  after(async () => {
    await facade?.close();
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
      // The facade adds its own tools and notes in some descriptions. Names and schemas stay.
      const shape = (tools) => tools.map(({ name, inputSchema }) => ({ name, inputSchema }));
      const expected = (await upstream.listTools()).tools;
      const actual = (await client.listTools()).tools;
      assert.ok(expected.length > 10);
      assert.deepEqual(shape(actual.slice(0, expected.length)), shape(expected));
      assert.deepEqual(actual.slice(expected.length).map((tool) => tool.name), ['fill_values_list']);
    } finally {
      await upstream.close();
    }
  });

  test('navigates, reads a page and follows a link', async () => {
    const text = await call(client, 'browser_navigate', { url: `${site.url}/` });
    assert.match(text, /Page Title: Fixture home/);

    const snapshot = await call(client, 'browser_snapshot');
    assert.match(snapshot, /heading "Fixture home"/);
    assert.match(snapshot, /Test pages of the Playwright facade/);

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
    const entries = readLog(facade.logFile);
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
});

describe('persistent profile', () => {
  test('keeps localStorage from one session to the next', async () => {
    const profile = path.join(ASSETS_DIR, 'test-profile');
    fs.rmSync(profile, { recursive: true, force: true });
    const site = await startSite();
    const values = [];
    try {
      for (const session of [1, 2]) {
        const facade = await startFacadeClient({ name: 'profile', args: ['--headless', '--user-data-dir', profile] });
        try {
          await call(facade.client, 'browser_navigate', { url: `${site.url}/` });
          if (session === 1) await evaluate(facade.client, `() => { localStorage.setItem('key', 'kept'); return true; }`);
          values.push(await evaluate(facade.client, `() => localStorage.getItem('key')`));
        } finally {
          // The client closes the facade without browser_close, as Claude Code does.
          await facade.close();
        }
      }
    } finally {
      await site.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
    assert.deepEqual(values, ['kept', 'kept']);
  });
});

describe('logging of secrets', () => {
  const secret = 'Very-Secret-Value-123';

  async function typeSecret(env) {
    const site = await startSite();
    const facade = await startFacadeClient({ name: `secrets-${env.PLAYWRIGHT_FACADE_LOG_SECRETS ?? 'default'}`, env });
    try {
      await call(facade.client, 'browser_navigate', { url: `${site.url}/form.html` });
      const snapshot = await call(facade.client, 'browser_snapshot');
      await call(facade.client, 'browser_type', { target: ref(snapshot, 'textbox', 'Password'), element: 'Password', text: secret });
      await call(facade.client, 'browser_fill_form', {
        fields: [{ name: 'Email', type: 'textbox', target: ref(snapshot, 'textbox', 'Email'), value: secret }],
      });
    } finally {
      await facade.close();
      await site.close();
    }
    return fs.readFileSync(facade.logFile, 'utf8');
  }

  test('the log has no typed text and no form values by default', async () => {
    const log = await typeSecret({});
    assert.ok(!log.includes(secret), 'the secret is in the log');
    assert.match(log, /<redacted 21 chars>/);
  });

  test('PLAYWRIGHT_FACADE_LOG_SECRETS=1 logs the values', async () => {
    const log = await typeSecret({ PLAYWRIGHT_FACADE_LOG_SECRETS: '1' });
    assert.ok(log.includes(secret));
  });
});
