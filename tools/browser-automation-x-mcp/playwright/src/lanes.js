// Lanes: one browser for one agent. Each lane has its own Chromium with a persistent profile in
// LANES_DIR/<pid>-<lane id>: the server writes the Chrome settings into it before the start, and
// deletes it when the lane closes. Xvfb starts with the first lane and stops after the last lane.
// Each lane has its own Playwright MCP connection in this process: its own tabs and current tab.
//
//   lane client <-> in-memory transport <-> Playwright MCP (createConnection) -> lane context
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConnection } from '@playwright/mcp';
import { ASSETS_DIR } from '../../src/paths.js';
import { writeChromePrefs } from './chrome-prefs.js';
import { filterIndexedDb, loadState, mergeState, writeState } from './storage-state.js';

// Playwright from the folder of @playwright/mcp: the same copy that createConnection uses.
const require = createRequire(import.meta.url);
const { chromium } = createRequire(require.resolve('@playwright/mcp'))('playwright-core');
import { startXvfb } from './xvfb.js';

// The maximum number of open lanes of one server.
export const MAX_LANES = 3;
// The maximum number of tabs of one lane.
export const MAX_TABS_PER_LANE = 5;
// A lane without a call for this time closes.
export const LANE_IDLE = 10 * 60 * 1000;
// The interval of the idle check.
export const IDLE_CHECK = 30 * 1000;
// The profile folders of the lanes.
export const LANES_DIR = path.join(ASSETS_DIR, 'lanes');
// The page script reports a key press, a click or a scroll of the user at most this often.
const ACTIVITY_INTERVAL = 5000;

// Page script: report the input of the user to the binding __baxActivity.
const ACTIVITY_SCRIPT = `(() => {
  if (window.__baxActivityOn || typeof window.__baxActivity !== 'function') return;
  window.__baxActivityOn = true;
  let last = 0;
  const report = (event) => {
    if (!event.isTrusted) return;
    const now = Date.now();
    if (now - last < ${ACTIVITY_INTERVAL}) return;
    last = now;
    try { window.__baxActivity(); } catch {}
  };
  for (const type of ['keydown', 'mousedown', 'wheel', 'input']) document.addEventListener(type, report, true);
})()`;

// Delete the lane folders of servers that do not run.
export function cleanStaleLanes(logger, dir = LANES_DIR) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const pid = Number(name.split('-')[0]);
    if (pid === process.pid || (pid && running(pid))) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    logger.info('lane_folder_removed', { folder: name });
  }
}

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Chromium shows no permission prompt: it denies the request.
const CHROMIUM_ARGS = ['--deny-permission-prompts'];


// The browser sessions of a lane (REQ-062 of sdd/SRS.md).
export const BROWSER_SESSIONS = ['normal', 'fresh', 'isolated'];
export class Lanes {
  // mode: HEADED, HEADED_INVISIBLE or HEADLESS. stateFile: the storage-state file.
  // keepIndexedDb(host): true for a host that keeps its IndexedDB (a site of sites.json).
  // roots: gives the roots of the client. afterOpen(lane) and beforeClose(lane): run after a lane
  // opened and before a lane closes.
  constructor({ mode, logger, outputDir, stateFile, keepIndexedDb = () => false, roots, afterOpen, beforeClose, launchEnv = {}, maxLanes = MAX_LANES, maxTabs = MAX_TABS_PER_LANE, idle = LANE_IDLE }) {
    Object.assign(this, { mode, logger, outputDir, stateFile, keepIndexedDb, roots, afterOpen, beforeClose, launchEnv, maxLanes, maxTabs, idle });
    this.lanes = new Map();
    this.xvfb = undefined;
    this.xvfbStart = undefined;
    this.timer = setInterval(() => this.closeIdle(), IDLE_CHECK);
    this.timer.unref();
  }

  get headless() { return this.mode === 'HEADLESS'; }

  // The environment of a Chromium: with the Xvfb display in HEADED_INVISIBLE. Starts Xvfb if necessary.
  async browserEnv() {
    const env = { ...process.env, ...this.launchEnv };
    if (this.mode === 'HEADED_INVISIBLE') {
      if (!this.xvfb) {
        this.xvfbStart ??= startXvfb({ logger: this.logger }).finally(() => { this.xvfbStart = undefined; });
        this.xvfb = await this.xvfbStart;
      }
      env.DISPLAY = this.xvfb.display;
      delete env.WAYLAND_DISPLAY;
    }
    return env;
  }

  stopXvfb() {
    this.xvfb?.stop();
    this.xvfb = undefined;
  }

  get size() { return this.lanes.size; }

  get(id) { return this.lanes.get(id); }

  // Open a lane: its own Chromium with the logins of the storage state. Give undefined if all
  // lanes are in use.
  // browserSession (REQ-062 of sdd/SRS.md): "normal" loads and saves the logins of the storage
  // state; "fresh" starts without them and saves into the storage state; "isolated" starts without
  // them and saves nothing.
  async open(browserSession = 'normal') {
    if (!BROWSER_SESSIONS.includes(browserSession)) throw new Error(`unknown browser session "${browserSession}"`);
    if (this.lanes.size >= this.maxLanes) return undefined;
    let id;
    do id = `lane-${crypto.randomBytes(2).toString('hex')}`; while (this.lanes.has(id));
    const lane = { id, browserSession, opened: Date.now(), lastUsed: Date.now(), busy: 0, context: undefined, notes: [], base: undefined, dir: path.join(LANES_DIR, `${process.pid}-${id}`) };
    this.lanes.set(id, lane);
    try {
      fs.rmSync(lane.dir, { recursive: true, force: true });
      writeChromePrefs(lane.dir);
      const env = await this.browserEnv();
      lane.context = await chromium.launchPersistentContext(lane.dir, {
        headless: this.headless,
        chromiumSandbox: process.platform !== 'linux',
        args: CHROMIUM_ARGS,
        env,
        viewport: this.headless ? { width: 1280, height: 720 } : null,
      });
      // A fresh or isolated lane starts with an empty base: its save removes no entry of the file.
      lane.base = browserSession === 'normal' ? loadState(this.stateFile) : { cookies: [], origins: [] };
      await lane.context.setStorageState(lane.base);
      await lane.context.exposeBinding('__baxActivity', () => { lane.lastUsed = Date.now(); });
      await lane.context.addInitScript({ content: ACTIVITY_SCRIPT });
      lane.context.on('page', (page) => this.onPage(lane, page));
      // The logins of the lane go into the storage state at each page load, e.g. after a login.
      const watch = (page) => page.on('load', () => this.queueSave(lane));
      lane.context.pages().forEach(watch);
      lane.context.on('page', watch);
      lane.client = await this.connect(lane);
      this.logger.info('browser_started', { lane: id, mode: this.mode, display: env.DISPLAY, version: lane.context.browser()?.version() });
    } catch (error) {
      this.lanes.delete(id);
      await lane.context?.close().catch(() => {});
      fs.rmSync(lane.dir, { recursive: true, force: true });
      if (!this.lanes.size) this.stopXvfb();
      throw error;
    }
    await this.afterOpen?.(lane);
    this.logger.info('lane_opened', { lane: id, browserSession, open: this.lanes.size });
    return lane;
  }

  // A page over the tab limit closes at once. The next result of the lane tells it.
  onPage(lane, page) {
    if (lane.context.pages().length <= this.maxTabs) return;
    page.close().catch(() => {});
    lane.notes.push(`A new tab was closed: a lane can have a maximum of ${this.maxTabs} tabs.`);
    this.logger.info('tab_limit', { lane: lane.id, url: page.url() });
  }

  tabCount(lane) { return lane.context?.pages().length ?? 0; }

  async connect(lane) {
    const server = await createConnection({
      browser: { browserName: 'chromium', isolated: false },
      outputDir: this.outputDir,
    }, async () => lane.context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'lane', version: '0' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async (request, extra) => this.roots(request, extra));
    await client.connect(clientTransport);
    return client;
  }

  // Close a lane: save its storage state, then close its context. reason: for the log.
  async close(id, reason) {
    const lane = this.lanes.get(id);
    if (!lane) return false;
    this.lanes.delete(id);
    lane.closing = true;
    await this.beforeClose?.(lane);
    await lane.saving;
    await this.saveState(lane);
    await lane.client?.close().catch(() => {});
    await lane.context?.close().catch(() => {});
    fs.rmSync(lane.dir, { recursive: true, force: true });
    this.logger.info('lane_closed', { lane: id, reason, open: this.lanes.size });
    this.logger.info('browser_stopped', { lane: id });
    if (!this.lanes.size) this.stopXvfb();
    return true;
  }

  // Save the state of the lane after the saves that run. A save at the close runs directly.
  queueSave(lane) {
    if (lane.closing) return;
    lane.saving = (lane.saving ?? Promise.resolve()).then(() => (lane.closing ? undefined : this.saveState(lane)));
  }

  // Merge the state of the lane into the storage-state file. The merged state is the new base: the
  // next save gives only the changes after it.
  async saveState(lane) {
    if (!lane.context || lane.browserSession === 'isolated') return;
    try {
      const mine = filterIndexedDb(await lane.context.storageState({ indexedDB: true }), this.keepIndexedDb);
      const merged = mergeState(lane.base, mine, loadState(this.stateFile));
      writeState(this.stateFile, merged);
      lane.base = mine;
      this.logger.info('state_saved', { lane: lane.id, cookies: merged.cookies.length, origins: merged.origins.length });
    } catch (error) {
      this.logger.error('state_save_failed', { lane: lane.id, message: error.message });
    }
  }

  // Close each lane without a call for the idle time.
  async closeIdle(now = Date.now()) {
    for (const lane of [...this.lanes.values()]) {
      if (!lane.busy && now - lane.lastUsed >= this.idle) await this.close(lane.id, 'idle');
    }
  }

  // The status for the agent.
  status(now = Date.now()) {
    const lines = [`Open lanes: ${this.lanes.size} of ${this.maxLanes}.`];
    for (const lane of this.lanes.values()) {
      lines.push(`- ${lane.id}: browser session ${lane.browserSession}, ${this.tabCount(lane)} tabs, idle ${Math.round((now - lane.lastUsed) / 1000)} s${lane.busy ? ', busy' : ''}`);
    }
    return lines.join('\n');
  }

  async closeAll(reason) {
    clearInterval(this.timer);
    await Promise.allSettled([...this.lanes.keys()].map((id) => this.close(id, reason)));
    this.stopXvfb();
  }
}
