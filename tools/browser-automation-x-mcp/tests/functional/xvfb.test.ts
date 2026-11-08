// Xvfb: the virtual display of the render mode HEADED_INVISIBLE on Linux.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { XVFB_DIR, XVFB_FIRST_DISPLAY, cleanStaleXvfb, startXvfb, xvfbPaths } from '../../playwright/src/xvfb.ts';
import { NullLogger } from '../../src/logger.ts';
import type { LogLine, ServerClient, TestSite } from '../helpers.ts';
import { call, evaluate, readLog, startServerClient, startSite } from '../helpers.ts';

const skip = process.platform !== 'linux' ? 'Linux only' : !fs.existsSync(xvfbPaths().binary) ? 'Xvfb is not installed: run.sh install' : false;
const logger = new NullLogger();
const XVFB_MODULE = pathToFileURL(path.join(import.meta.dirname, '..', '..', 'playwright', 'src', 'xvfb.ts')).href;

function running(pid: number): boolean {
  try {
    // A zombie has no cmdline.
    return fs.readFileSync(`/proc/${pid}/cmdline`).length > 0;
  } catch {
    return false;
  }
}

async function waitUntilStopped(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && running(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  return !running(pid);
}

const registryFile = (display: string): string => path.join(XVFB_DIR, `${display.slice(1)}.json`);

describe('xvfb', { skip }, () => {
  test('starts on a free display, registers it and stops', async () => {
    const first = await startXvfb({ logger });
    const second = await startXvfb({ logger });
    try {
      assert.match(first.display, /^:\d+$/);
      assert.ok(Number(first.display.slice(1)) >= XVFB_FIRST_DISPLAY);
      assert.notEqual(first.display, second.display);
      assert.equal(JSON.parse(fs.readFileSync(registryFile(first.display), 'utf8')).server.pid, process.pid);
    } finally {
      first.stop();
      second.stop();
    }
    assert.ok(!fs.existsSync(registryFile(first.display)));
  });

  test('keeps the Xvfb of a server that runs, and kills the Xvfb of a server that stopped', async () => {
    const own = await startXvfb({ logger });
    const stale = await startXvfb({ logger });
    try {
      const file = registryFile(stale.display);
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...entry, server: { pid: entry.server.pid, start: 'other' } }));
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

  test('stops Xvfb when its server gets SIGKILL', async () => {
    const script = `const { startXvfb } = await import(${JSON.stringify(XVFB_MODULE)});
      const { display } = await startXvfb({ logger: { info() {}, debug() {}, error() {} } });
      console.log(display); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const display = await new Promise<string>((resolve) => readline.createInterface({ input: child.stdout }).once('line', resolve));
    const { xvfb } = JSON.parse(fs.readFileSync(registryFile(display), 'utf8'));
    assert.ok(running(xvfb.pid));
    child.kill('SIGKILL');
    assert.ok(await waitUntilStopped(xvfb.pid), 'the parent-death signal stops Xvfb');
    cleanStaleXvfb(logger);
    assert.ok(!fs.existsSync(registryFile(display)));
  });

  describe('server without a display', () => {
    let site: TestSite;
    let mcp: ServerClient | undefined;

    // The server of the tests: it runs until the last test closes it.
    const server = (): ServerClient => {
      assert.ok(mcp, 'the server is closed');
      return mcp;
    };

    // The PID of the last Xvfb that the log of the server gives.
    const lastXvfb = (): number => Number(readLog(server().logFile).filter((entry: LogLine) => entry.event === 'xvfb_started').at(-1)?.pid);

    before(async () => {
      site = await startSite();
      // The old control asks for a headless browser. The render mode decides.
      mcp = await startServerClient({
        name: 'xvfb',
        env: { RENDER_MODE: 'HEADED', PLAYWRIGHT_MCP_HEADLESS: 'true', DISPLAY: '', WAYLAND_DISPLAY: '' },
      });
    });

    after(async () => {
      await mcp?.close();
      await site?.close();
    });

    test('runs a headed browser on Xvfb and ignores the variables of Playwright MCP', async () => {
      await call(server().client, 'browser_navigate', { url: `${site.url}/` });
      assert.doesNotMatch(String(await evaluate(server().client, '() => navigator.userAgent')), /Headless/);
      const log = readLog(server().logFile);
      assert.equal(log.find((entry) => entry.event === 'render_mode')?.mode, 'HEADED_INVISIBLE');
      assert.ok(log.filter((entry) => entry.event === 'ignored').some((entry) => entry.control === 'PLAYWRIGHT_MCP_HEADLESS'));
    });

    test('denies a permission without a prompt', async () => {
      await call(server().client, 'browser_navigate', { url: `${site.url}/` });
      assert.equal(await evaluate(server().client, '() => Notification.requestPermission()'), 'denied');
    });

    test('stops Chromium and Xvfb when the last lane closes, and starts them again for a new lane', async () => {
      const first = lastXvfb();
      assert.ok(running(first));
      await call(server().client, 'browser_close');
      assert.ok(await waitUntilStopped(first));
      assert.ok(readLog(server().logFile).some((entry) => entry.event === 'browser_stopped'));
      await call(server().client, 'browser_navigate', { url: `${site.url}/` });
      const second = lastXvfb();
      assert.notEqual(second, first);
      assert.ok(running(second));
    });

    test('stops Xvfb with the server', async () => {
      const pid = lastXvfb();
      assert.ok(running(pid));
      await server().close();
      mcp = undefined;
      assert.ok(await waitUntilStopped(pid));
    });
  });
});
