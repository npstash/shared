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
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ClientNotification, ClientRequest, ListRootsRequest, ListRootsResult } from '@modelcontextprotocol/sdk/types.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConnection } from '@playwright/mcp';
import type { BrowserContext, BrowserType, Page } from 'playwright-core';
import { errorCode, errorMessage } from '../../src/json.ts';
import type { Logger } from '../../src/logger.ts';
import { ASSETS_DIR } from '../../src/paths.ts';
import { writeChromePrefs } from './chrome-prefs.ts';
import type { RenderMode } from './config.ts';
import type { LaneSession } from './session.ts';
import type { StateStore, StorageState } from './storage-state.ts';
import { StorageStateFile, emptyState, filterIndexedDb, mergeState } from './storage-state.ts';
import type { DisplayStarter, XvfbDisplay } from './xvfb.ts';
import { XvfbStarter } from './xvfb.ts';

// Playwright from the folder of @playwright/mcp: the same copy that createConnection uses.
const require = createRequire(import.meta.url);
const { chromium } = createRequire(require.resolve('@playwright/mcp'))('playwright-core') as { chromium: BrowserType };

// The browser sessions of a lane (REQ-062 of sdd/SRS.md).
export type BrowserSession = 'normal' | 'fresh' | 'isolated';
export const BROWSER_SESSIONS: readonly BrowserSession[] = ['normal', 'fresh', 'isolated'];

export function isBrowserSession(value: unknown): value is BrowserSession {
  return typeof value === 'string' && (BROWSER_SESSIONS as readonly string[]).includes(value);
}

// The roots of the client for the upstream connection of a lane.
export type RootsHandler = (request: ListRootsRequest, extra: RequestHandlerExtra<ClientRequest, ClientNotification>) => Promise<ListRootsResult>;

// One lane: one browser for one agent.
export interface Lane {
  readonly id: string;
  readonly browserSession: BrowserSession;
  readonly opened: number;
  lastUsed: number;
  // The number of calls that run.
  busy: number;
  context: BrowserContext | undefined;
  // The upstream connection of the lane.
  client: Client | undefined;
  // The notes for the next result of the lane, e.g. a closed tab.
  readonly notes: string[];
  // The state that the lane loaded, or the state of its last save.
  base: StorageState | undefined;
  // The profile folder.
  readonly dir: string;
  closing: boolean;
  saving: Promise<void> | undefined;
  // The state of the lane for the call steps (see mcp-server.ts).
  session: LaneSession | undefined;
}

// The lanes of one server.
export interface LaneManager {
  readonly size: number;
  readonly maxLanes: number;
  readonly maxTabs: number;
  // Open a lane. Give undefined if all lanes are in use.
  open(browserSession?: BrowserSession): Promise<Lane | undefined>;
  // Close a lane. Give false if it is not open. reason: for the log.
  close(id: string | undefined, reason: string): Promise<boolean>;
  get(id: string | undefined): Lane | undefined;
  tabCount(lane: Lane): number;
  // The status for the agent.
  status(now?: number): string;
  closeAll(reason: string): Promise<void>;
}

export interface LanesOptions {
  readonly mode: RenderMode;
  readonly logger: Logger;
  readonly outputDir?: string;
  readonly stateFile?: string;
  // The storage-state file; the default is a StorageStateFile of stateFile.
  readonly state?: StateStore;
  // True for a host that keeps its IndexedDB (a site of sites.json).
  readonly keepIndexedDb?: (host: string) => boolean;
  readonly roots?: RootsHandler;
  // Run after a lane opened and before a lane closes.
  readonly afterOpen?: (lane: Lane) => Promise<void>;
  readonly beforeClose?: (lane: Lane) => Promise<void>;
  readonly display?: DisplayStarter;
  readonly launchEnv?: Readonly<Record<string, string>>;
  readonly maxLanes?: number;
  readonly maxTabs?: number;
  readonly idle?: number;
}

// The maximum number of open lanes of one server.
export const MAX_LANES: number = 3;
// The maximum number of tabs of one lane.
export const MAX_TABS_PER_LANE: number = 5;
// A lane without a call for this time closes.
export const LANE_IDLE: number = 10 * 60 * 1000;
// The interval of the idle check.
export const IDLE_CHECK: number = 30 * 1000;
// The profile folders of the lanes.
export const LANES_DIR: string = path.join(ASSETS_DIR, 'lanes');
// The page script reports a key press, a click or a scroll of the user at most this often.
const ACTIVITY_INTERVAL: number = 5000;

// Page script: report the input of the user to the binding __baxActivity.
const ACTIVITY_SCRIPT: string = `(() => {
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
export function cleanStaleLanes(logger: Logger, dir: string = LANES_DIR): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const pid = Number(name.split('-')[0]);
    if (pid === process.pid || (pid && running(pid))) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    logger.info('lane_folder_removed', { folder: name });
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

// Chromium shows no permission prompt: it denies the request.
const CHROMIUM_ARGS: readonly string[] = ['--deny-permission-prompts'];


export class Lanes implements LaneManager {
  readonly mode: RenderMode;
  readonly maxLanes: number;
  readonly maxTabs: number;
  readonly idle: number;
  // The open lanes by ID.
  readonly lanes: Map<string, Lane> = new Map();
  // The timer of the idle check.
  readonly timer: NodeJS.Timeout;
  private readonly logger: Logger;
  private readonly outputDir: string | undefined;
  private readonly state: StateStore;
  private readonly keepIndexedDb: (host: string) => boolean;
  private readonly roots: RootsHandler;
  private readonly afterOpen: ((lane: Lane) => Promise<void>) | undefined;
  private readonly beforeClose: ((lane: Lane) => Promise<void>) | undefined;
  private readonly display: DisplayStarter;
  private readonly launchEnv: Readonly<Record<string, string>>;
  private xvfb: XvfbDisplay | undefined = undefined;
  private xvfbStart: Promise<XvfbDisplay> | undefined = undefined;

  constructor({ mode, logger, outputDir, stateFile, state, keepIndexedDb = (): boolean => false, roots = async (): Promise<ListRootsResult> => ({ roots: [] }), afterOpen, beforeClose, display, launchEnv = {}, maxLanes = MAX_LANES, maxTabs = MAX_TABS_PER_LANE, idle = LANE_IDLE }: LanesOptions) {
    this.mode = mode;
    this.logger = logger;
    this.outputDir = outputDir;
    this.state = state ?? new StorageStateFile(stateFile ?? '');
    this.keepIndexedDb = keepIndexedDb;
    this.roots = roots;
    this.afterOpen = afterOpen;
    this.beforeClose = beforeClose;
    this.display = display ?? new XvfbStarter(logger);
    this.launchEnv = launchEnv;
    this.maxLanes = maxLanes;
    this.maxTabs = maxTabs;
    this.idle = idle;
    this.timer = setInterval(() => { void this.closeIdle(); }, IDLE_CHECK);
    this.timer.unref();
  }

  get headless(): boolean { return this.mode === 'HEADLESS'; }

  // The environment of a Chromium: with the Xvfb display in HEADED_INVISIBLE. Starts Xvfb if necessary.
  async browserEnv(): Promise<Record<string, string | undefined>> {
    const env: Record<string, string | undefined> = { ...process.env, ...this.launchEnv };
    if (this.mode === 'HEADED_INVISIBLE') {
      if (!this.xvfb) {
        this.xvfbStart ??= this.display.start().finally(() => { this.xvfbStart = undefined; });
        this.xvfb = await this.xvfbStart;
      }
      env.DISPLAY = this.xvfb.display;
      delete env.WAYLAND_DISPLAY;
    }
    return env;
  }

  stopXvfb(): void {
    this.xvfb?.stop();
    this.xvfb = undefined;
  }

  get size(): number { return this.lanes.size; }

  get(id: string | undefined): Lane | undefined { return id === undefined ? undefined : this.lanes.get(id); }

  // Open a lane: its own Chromium with the logins of the storage state. Give undefined if all
  // lanes are in use.
  // browserSession (REQ-062 of sdd/SRS.md): "normal" loads and saves the logins of the storage
  // state; "fresh" starts without them and saves into the storage state; "isolated" starts without
  // them and saves nothing.
  async open(browserSession: BrowserSession = 'normal'): Promise<Lane | undefined> {
    if (!isBrowserSession(browserSession)) throw new Error(`unknown browser session "${String(browserSession)}"`);
    if (this.lanes.size >= this.maxLanes) return undefined;
    let id: string;
    do id = `lane-${crypto.randomBytes(2).toString('hex')}`; while (this.lanes.has(id));
    const lane: Lane = {
      id, browserSession, opened: Date.now(), lastUsed: Date.now(), busy: 0, context: undefined, client: undefined, notes: [], base: undefined,
      dir: path.join(LANES_DIR, `${process.pid}-${id}`), closing: false, saving: undefined, session: undefined,
    };
    this.lanes.set(id, lane);
    try {
      fs.rmSync(lane.dir, { recursive: true, force: true });
      writeChromePrefs(lane.dir);
      const env = await this.browserEnv();
      const context = await chromium.launchPersistentContext(lane.dir, {
        headless: this.headless,
        chromiumSandbox: process.platform !== 'linux',
        args: [...CHROMIUM_ARGS],
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        viewport: this.headless ? { width: 1280, height: 720 } : null,
      });
      lane.context = context;
      // A fresh or isolated lane starts with an empty base: its save removes no entry of the file.
      lane.base = browserSession === 'normal' ? this.state.load() : emptyState();
      await context.setStorageState(lane.base);
      await context.exposeBinding('__baxActivity', () => { lane.lastUsed = Date.now(); });
      await context.addInitScript({ content: ACTIVITY_SCRIPT });
      context.on('page', (page) => this.onPage(lane, page));
      // The logins of the lane go into the storage state at each page load, e.g. after a login.
      const watch = (page: Page): void => { page.on('load', () => this.queueSave(lane)); };
      context.pages().forEach(watch);
      context.on('page', watch);
      lane.client = await this.connect(lane);
      this.logger.info('browser_started', { lane: id, mode: this.mode, display: env.DISPLAY, version: context.browser()?.version() });
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
  onPage(lane: Lane, page: Page): void {
    if ((lane.context?.pages().length ?? 0) <= this.maxTabs) return;
    page.close().catch(() => {});
    lane.notes.push(`A new tab was closed: a lane can have a maximum of ${this.maxTabs} tabs.`);
    this.logger.info('tab_limit', { lane: lane.id, url: page.url() });
  }

  tabCount(lane: Lane): number { return lane.context?.pages().length ?? 0; }

  async connect(lane: Lane): Promise<Client> {
    const server = await createConnection({
      browser: { browserName: 'chromium', isolated: false },
      outputDir: this.outputDir,
    }, async () => {
      if (!lane.context) throw new Error(`the lane ${lane.id} has no browser`);
      return lane.context;
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'lane', version: '0' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async (request, extra) => this.roots(request, extra));
    await client.connect(clientTransport);
    return client;
  }

  // Close a lane: save its storage state, then close its context. reason: for the log.
  async close(id: string | undefined, reason: string): Promise<boolean> {
    const lane = this.get(id);
    if (!lane) return false;
    this.lanes.delete(lane.id);
    lane.closing = true;
    await this.beforeClose?.(lane);
    await lane.saving;
    await this.saveState(lane);
    await lane.client?.close().catch(() => {});
    await lane.context?.close().catch(() => {});
    fs.rmSync(lane.dir, { recursive: true, force: true });
    this.logger.info('lane_closed', { lane: lane.id, reason, open: this.lanes.size });
    this.logger.info('browser_stopped', { lane: lane.id });
    if (!this.lanes.size) this.stopXvfb();
    return true;
  }

  // Save the state of the lane after the saves that run. A save at the close runs directly.
  queueSave(lane: Lane): void {
    if (lane.closing) return;
    lane.saving = (lane.saving ?? Promise.resolve()).then(() => (lane.closing ? undefined : this.saveState(lane)));
  }

  // Merge the state of the lane into the storage-state file. The merged state is the new base: the
  // next save gives only the changes after it.
  async saveState(lane: Lane): Promise<void> {
    if (!lane.context || lane.browserSession === 'isolated') return;
    try {
      const mine = filterIndexedDb(await lane.context.storageState({ indexedDB: true }) as StorageState, this.keepIndexedDb);
      const merged = mergeState(lane.base ?? emptyState(), mine, this.state.load());
      this.state.write(merged);
      lane.base = mine;
      this.logger.info('state_saved', { lane: lane.id, cookies: merged.cookies.length, origins: merged.origins.length });
    } catch (error) {
      this.logger.error('state_save_failed', { lane: lane.id, message: errorMessage(error) });
    }
  }

  // Close each lane without a call for the idle time.
  async closeIdle(now: number = Date.now()): Promise<void> {
    for (const lane of [...this.lanes.values()]) {
      if (!lane.busy && now - lane.lastUsed >= this.idle) await this.close(lane.id, 'idle');
    }
  }

  // The status for the agent.
  status(now: number = Date.now()): string {
    const lines = [`Open lanes: ${this.lanes.size} of ${this.maxLanes}.`];
    for (const lane of this.lanes.values()) {
      lines.push(`- ${lane.id}: browser session ${lane.browserSession}, ${this.tabCount(lane)} tabs, idle ${Math.round((now - lane.lastUsed) / 1000)} s${lane.busy ? ', busy' : ''}`);
    }
    return lines.join('\n');
  }

  async closeAll(reason: string): Promise<void> {
    clearInterval(this.timer);
    await Promise.allSettled([...this.lanes.keys()].map((id) => this.close(id, reason)));
    this.stopXvfb();
  }
}
