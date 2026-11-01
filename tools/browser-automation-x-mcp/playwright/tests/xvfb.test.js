// Xvfb: the virtual display of the render mode HEADED_INVISIBLE on Linux.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { XVFB_DIR, XVFB_FIRST_DISPLAY, cleanStaleXvfb, startXvfb, xvfbPaths } from '../src/xvfb.js';
import { call, evaluate, startFacadeClient, startSite } from './helpers.js';

const skip = process.platform !== 'linux' ? 'Linux only' : !fs.existsSync(xvfbPaths().binary) ? 'Xvfb is not installed: run.sh install' : false;
const logger = { info() {}, debug() {}, error() {} };
const XVFB_MODULE = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'xvfb.js')).href;

function running(pid) {
  try {
    // A zombie has no cmdline.
    return fs.readFileSync(`/proc/${pid}/cmdline`).length > 0;
  } catch {
    return false;
  }
}

async function waitUntilStopped(pid) {
  for (let i = 0; i < 50 && running(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  return !running(pid);
}

function readLog(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

const registryFile = (display) => path.join(XVFB_DIR, `${display.slice(1)}.json`);

describe('xvfb', { skip }, () => {
  test('starts on a free display, registers it and stops', async () => {
    const first = await startXvfb({ logger });
    const second = await startXvfb({ logger });
    try {
      assert.match(first.display, /^:\d+$/);
      assert.ok(Number(first.display.slice(1)) >= XVFB_FIRST_DISPLAY);
      assert.notEqual(first.display, second.display);
      assert.equal(JSON.parse(fs.readFileSync(registryFile(first.display), 'utf8')).facade.pid, process.pid);
    } finally {
      first.stop();
      second.stop();
    }
    assert.ok(!fs.existsSync(registryFile(first.display)));
  });

  test('keeps the Xvfb of a facade that runs, and kills the Xvfb of a facade that stopped', async () => {
    const own = await startXvfb({ logger });
    const stale = await startXvfb({ logger });
    try {
      const file = registryFile(stale.display);
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...entry, facade: { pid: entry.facade.pid, start: 'other' } }));
      cleanStaleXvfb(logger);
      assert.ok(await waitUntilStopped(entry.xvfb.pid));
      assert.ok(!fs.existsSync(file));
      const ownEntry = JSON.parse(fs.readFileSync(registryFile(own.display), 'utf8'));
      assert.ok(running(ownEntry.xvfb.pid));
    } finally {
      own.stop();
      stale.stop();
    }
  });

  test('stops Xvfb when its facade gets SIGKILL', async () => {
    const script = `const { startXvfb } = await import(${JSON.stringify(XVFB_MODULE)});
      const { display } = await startXvfb({ logger: { info() {}, debug() {}, error() {} } });
      console.log(display); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const display = await new Promise((resolve) => readline.createInterface({ input: child.stdout }).once('line', resolve));
    const { xvfb } = JSON.parse(fs.readFileSync(registryFile(display), 'utf8'));
    assert.ok(running(xvfb.pid));
    child.kill('SIGKILL');
    assert.ok(await waitUntilStopped(xvfb.pid), 'the parent-death signal stops Xvfb');
    cleanStaleXvfb(logger);
    assert.ok(!fs.existsSync(registryFile(display)));
  });

  describe('facade without a display', () => {
    let site;
    let facade;

    before(async () => {
      site = await startSite();
      // The old controls ask for a headless browser. The render mode decides.
      facade = await startFacadeClient({
        name: 'xvfb',
        args: ['--headless', '--isolated'],
        env: { RENDER_MODE: 'HEADED', PLAYWRIGHT_MCP_HEADLESS: 'true', DISPLAY: '', WAYLAND_DISPLAY: '' },
      });
    });

    after(async () => {
      await facade?.close();
      await site?.close();
    });

    test('runs a headed browser on Xvfb and ignores the old controls', async () => {
      await call(facade.client, 'browser_navigate', { url: `${site.url}/` });
      assert.doesNotMatch(await evaluate(facade.client, '() => navigator.userAgent'), /Headless/);
      const log = readLog(facade.logFile);
      assert.equal(log.find((entry) => entry.event === 'render_mode').mode, 'HEADED_INVISIBLE');
      assert.deepEqual(log.filter((entry) => entry.event === 'ignored').map((entry) => entry.control), ['--headless', 'PLAYWRIGHT_MCP_HEADLESS']);
      assert.equal(log.find((entry) => entry.event === 'upstream_start').args.includes('--headless'), false);
    });

    test('stops Xvfb with the facade', async () => {
      const { pid } = readLog(facade.logFile).find((entry) => entry.event === 'xvfb_started');
      assert.ok(running(pid));
      await facade.close();
      facade = undefined;
      assert.ok(await waitUntilStopped(pid));
    });
  });
});
