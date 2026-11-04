// Lanes: one browser context for each agent, the limits, the logins between lanes, and the checks
// of file names and secret headers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { TOOL_DIR } from '../../src/paths.js';
import { outputDir } from '../src/config.js';
import { callText, startServerClient, startSite } from './helpers.js';

function readLog(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('lanes', () => {
  let site;
  let mcp;
  let raw;

  // Open a lane with the client without automatic lanes. Give its ID.
  async function open() {
    const { text, isError } = await callText(raw, 'browser_lane_open');
    assert.ok(!isError, text);
    return text.match(/Lane: (lane-[0-9a-f]+)/)[1];
  }

  async function inLane(lane, name, args = {}) {
    return callText(raw, name, { ...args, lane });
  }

  async function closeAll() {
    const { text } = await callText(raw, 'browser_lanes');
    for (const [, id] of text.matchAll(/- (lane-[0-9a-f]+)/g)) await inLane(id, 'browser_lane_close');
  }

  before(async () => {
    site = await startSite();
    mcp = await startServerClient({ name: 'lanes', config: { tools: '[tools]\nbrowser_evaluate = enabled\nbrowser_network_request = enabled\n' } });
    raw = mcp.client.raw;
  });

  after(async () => {
    await mcp?.close();
    await site?.close();
  });

  test('each lane has its own tabs, also in parallel', async () => {
    const [a, b] = [await open(), await open()];
    try {
      await Promise.all([
        inLane(a, 'browser_navigate', { url: `${site.url}/form.html` }),
        inLane(b, 'browser_navigate', { url: `${site.url}/` }),
      ]);
      const [snapA, snapB] = await Promise.all([inLane(a, 'browser_snapshot'), inLane(b, 'browser_snapshot')]);
      assert.match(snapA.text, /Page URL: .*\/form\.html/);
      assert.match(snapB.text, /heading "Fixture home"/);
      assert.match((await inLane(a, 'browser_tabs', { action: 'list' })).text, /form\.html/);
      assert.doesNotMatch((await inLane(b, 'browser_tabs', { action: 'list' })).text, /form\.html/);
    } finally {
      await closeAll();
    }
  });

  test('gives busy at the maximum of lanes; browser_lanes gives the status', async () => {
    try {
      const ids = [await open(), await open(), await open()];
      const busy = await callText(raw, 'browser_lane_open');
      assert.equal(busy.isError, true);
      assert.match(busy.text, /Busy: 3 of 3 lanes are open\. Call browser_lanes later/);
      const status = (await callText(raw, 'browser_lanes')).text;
      assert.match(status, /Open lanes: 3 of 3\./);
      for (const id of ids) assert.match(status, new RegExp(id));
      await inLane(ids[0], 'browser_lane_close');
      assert.match((await callText(raw, 'browser_lanes')).text, /Open lanes: 2 of 3\./);
      await open();
    } finally {
      await closeAll();
    }
  });

  test('a call without a lane or with an unknown lane fails', async () => {
    const missing = await callText(raw, 'browser_navigate', { url: `${site.url}/` });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Give the parameter lane/);
    const unknown = await inLane('lane-0000', 'browser_navigate', { url: `${site.url}/` });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /The lane lane-0000 is not open/);
  });

  test('browser_close closes the lane', async () => {
    const lane = await open();
    await inLane(lane, 'browser_navigate', { url: `${site.url}/` });
    const closed = await inLane(lane, 'browser_close');
    assert.match(closed.text, new RegExp(`The lane ${lane} is closed`));
    assert.match((await inLane(lane, 'browser_snapshot')).text, /is not open/);
    assert.ok(readLog(mcp.logFile).some((entry) => entry.event === 'lane_closed' && entry.lane === lane && entry.reason === 'tool'));
  });

  test('a lane has a maximum of 5 tabs; a popup over the limit closes', async () => {
    const lane = await open();
    try {
      await inLane(lane, 'browser_navigate', { url: `${site.url}/` });
      for (let i = 0; i < 4; i++) assert.ok(!(await inLane(lane, 'browser_tabs', { action: 'new', url: `${site.url}/` })).isError);
      const sixth = await inLane(lane, 'browser_tabs', { action: 'new', url: `${site.url}/` });
      assert.equal(sixth.isError, true);
      assert.match(sixth.text, /maximum of 5 tabs/);
      // The note comes with the result of the call that opened the popup, or with a later result.
      let note = (await inLane(lane, 'browser_evaluate', { function: `() => { window.open('${site.url}/form.html'); return true; }` })).text;
      for (let i = 0; i < 20 && !note.includes('A new tab was closed'); i++) {
        note = (await inLane(lane, 'browser_tabs', { action: 'list' })).text;
      }
      assert.match(note, /A new tab was closed: a lane can have a maximum of 5 tabs/);
      const tabs = (await inLane(lane, 'browser_tabs', { action: 'list' })).text;
      assert.equal((tabs.match(/^- \d+:/gm) ?? []).length, 5);
    } finally {
      await closeAll();
    }
  });

  test('a lane gets the logins of the lanes that closed before it opened', async () => {
    const a = await open();
    const early = await open();
    await inLane(a, 'browser_navigate', { url: `${site.url}/` });
    await inLane(a, 'browser_evaluate', { function: `() => { document.cookie = 'login=yes; max-age=3600'; return true; }` });
    await inLane(a, 'browser_lane_close');
    const b = await open();
    try {
      await inLane(b, 'browser_navigate', { url: `${site.url}/` });
      assert.match((await inLane(b, 'browser_evaluate', { function: '() => document.cookie' })).text, /login=yes/);
      await inLane(early, 'browser_navigate', { url: `${site.url}/` });
      assert.doesNotMatch((await inLane(early, 'browser_evaluate', { function: '() => document.cookie' })).text, /login=yes/);
    } finally {
      await closeAll();
    }
  });

  test('a file name must be in the output folder', async () => {
    const lane = await open();
    try {
      await inLane(lane, 'browser_navigate', { url: `${site.url}/` });
      const outside = await inLane(lane, 'browser_snapshot', { filename: '../escape.yml' });
      assert.equal(outside.isError, true);
      assert.match(outside.text, /not allowed/);
      const name = `lanes-test-${process.pid}.yml`;
      assert.ok(!(await inLane(lane, 'browser_snapshot', { filename: name })).isError);
      const file = path.join(outputDir(TOOL_DIR), name);
      assert.ok(fs.existsSync(file), file);
      fs.rmSync(file);
    } finally {
      await closeAll();
    }
  });

  test('masks the values of secret headers', async () => {
    const lane = await open();
    try {
      await inLane(lane, 'browser_navigate', { url: `${site.url}/` });
      await inLane(lane, 'browser_evaluate', { function: `async () => { document.cookie = 'token=Secret-Cookie-42'; await fetch('/index.html', { headers: { Authorization: 'Bearer Secret-Token-42' } }); return true; }` });
      const list = await inLane(lane, 'browser_network_requests', {});
      const index = list.text.match(/^(\d+)\. .*index\.html/m)?.[1] ?? list.text.match(/\[(\d+)\].*index\.html/)?.[1];
      assert.ok(index, list.text);
      const detail = await inLane(lane, 'browser_network_request', { index: Number(index) });
      assert.match(detail.text, /authorization: \*\*\*/i);
      assert.doesNotMatch(detail.text, /Secret-(Token|Cookie)-42/);
    } finally {
      await closeAll();
    }
  });
});
