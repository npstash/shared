// Lanes: one browser context for one agent. All lanes of the server use one Chromium.
// Chromium starts with the first lane and stops when the last lane closes.
// Each lane has its own Playwright MCP connection in this process: its own tabs and current tab.
//
//   lane client <-> in-memory transport <-> Playwright MCP (createConnection) -> browser context
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConnection } from '@playwright/mcp';
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
const IDLE_CHECK = 30 * 1000;

// Chromium shows no permission prompt: it denies the request.
const CHROMIUM_ARGS = ['--deny-permission-prompts'];

export class Lanes {
  // mode: HEADED, HEADED_INVISIBLE or HEADLESS. stateFile: the storage-state file.
  // indexedDbHosts: the hosts that keep their IndexedDB. roots: gives the roots of the client.
  // beforeClose(lane): runs before a lane closes.
  constructor({ mode, logger, outputDir, stateFile, indexedDbHosts = [], roots, beforeClose, launchEnv = {}, maxLanes = MAX_LANES, maxTabs = MAX_TABS_PER_LANE, idle = LANE_IDLE }) {
    Object.assign(this, { mode, logger, outputDir, stateFile, indexedDbHosts, roots, beforeClose, launchEnv, maxLanes, maxTabs, idle });
    this.lanes = new Map();
    this.browser = undefined;
    this.browserStart = undefined;
    this.xvfb = undefined;
    this.timer = setInterval(() => this.closeIdle(), IDLE_CHECK);
    this.timer.unref();
  }

  // The headless flag and the viewport as Playwright MCP sets them for its own browser.
  get headless() { return this.mode === 'HEADLESS'; }

  // Start Chromium (and Xvfb) if it does not run.
  async ensureBrowser() {
    if (this.browser) return this.browser;
    this.browserStart ??= (async () => {
      const env = { ...process.env, ...this.launchEnv };
      if (this.mode === 'HEADED_INVISIBLE') {
        this.xvfb = await startXvfb({ logger: this.logger });
        env.DISPLAY = this.xvfb.display;
        delete env.WAYLAND_DISPLAY;
      }
      try {
        const browser = await chromium.launch({
          headless: this.headless,
          chromiumSandbox: process.platform !== 'linux',
          args: CHROMIUM_ARGS,
          env,
        });
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = undefined;
        });
        this.logger.info('browser_started', { mode: this.mode, display: env.DISPLAY, version: browser.version() });
        this.browser = browser;
        return browser;
      } catch (error) {
        this.xvfb?.stop();
        this.xvfb = undefined;
        throw error;
      }
    })().finally(() => { this.browserStart = undefined; });
    return this.browserStart;
  }

  async stopBrowser() {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) {
      await browser.close().catch((error) => this.logger.error('browser_close_failed', { message: error.message }));
      this.logger.info('browser_stopped', {});
    }
    this.xvfb?.stop();
    this.xvfb = undefined;
  }

  get size() { return this.lanes.size; }

  get(id) { return this.lanes.get(id); }

  // Open a lane. Give undefined if all lanes are in use.
  async open() {
    if (this.lanes.size >= this.maxLanes) return undefined;
    let id;
    do id = `lane-${crypto.randomBytes(2).toString('hex')}`; while (this.lanes.has(id));
    const lane = { id, opened: Date.now(), lastUsed: Date.now(), busy: 0, context: undefined, notes: [], base: undefined };
    this.lanes.set(id, lane);
    try {
      const browser = await this.ensureBrowser();
      lane.base = loadState(this.stateFile);
      lane.context = await browser.newContext({
        viewport: this.headless ? { width: 1280, height: 720 } : null,
        storageState: lane.base,
      });
      lane.context.on('page', (page) => this.onPage(lane, page));
      lane.client = await this.connect(lane);
    } catch (error) {
      this.lanes.delete(id);
      await lane.context?.close().catch(() => {});
      if (!this.lanes.size) await this.stopBrowser();
      throw error;
    }
    this.logger.info('lane_opened', { lane: id, open: this.lanes.size });
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
    await this.beforeClose?.(lane);
    await this.saveState(lane);
    await lane.client?.close().catch(() => {});
    await lane.context?.close().catch(() => {});
    this.logger.info('lane_closed', { lane: id, reason, open: this.lanes.size });
    if (!this.lanes.size) await this.stopBrowser();
    return true;
  }

  async saveState(lane) {
    if (!lane.context) return;
    try {
      const mine = filterIndexedDb(await lane.context.storageState({ indexedDB: this.indexedDbHosts.length > 0 }), this.indexedDbHosts);
      const merged = mergeState(lane.base, mine, loadState(this.stateFile));
      writeState(this.stateFile, merged);
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
      lines.push(`- ${lane.id}: ${this.tabCount(lane)} tabs, idle ${Math.round((now - lane.lastUsed) / 1000)} s${lane.busy ? ', busy' : ''}`);
    }
    return lines.join('\n');
  }

  async closeAll(reason) {
    clearInterval(this.timer);
    await Promise.allSettled([...this.lanes.keys()].map((id) => this.close(id, reason)));
    await this.stopBrowser();
  }
}
