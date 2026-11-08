// The storage-state file: the logins of all lanes and sessions of one workspace.
// It holds cookies, localStorage and the IndexedDB of the sites in sites.json (Playwright format).
// The file never goes into a result, a log or the output folder. Mode 0600.
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { hostOfUrl } from '../../src/hosts/patterns.ts';

// The storage state of Playwright: cookies and origins with localStorage and IndexedDB.
type PlaywrightState = Awaited<ReturnType<BrowserContext['storageState']>>;
export type Cookie = PlaywrightState['cookies'][number];
// An origin with its localStorage, and its IndexedDB when storageState({ indexedDB: true }) gives it.
export type OriginState = PlaywrightState['origins'][number] & { indexedDB?: unknown[] };
export interface StorageState {
  cookies: Cookie[];
  origins: OriginState[];
}

// The storage-state file of the lanes.
export interface StateStore {
  readonly file: string;
  // The state of the file. A missing or damaged file gives an empty state.
  load(): StorageState;
  // Write the state: a temp file with mode 0600, then a rename.
  write(state: StorageState): void;
}

export class StorageStateFile implements StateStore {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  load(): StorageState {
    return loadState(this.file);
  }

  write(state: StorageState): void {
    writeState(this.file, state);
  }
}

export function emptyState(): StorageState {
  return { cookies: [], origins: [] };
}

// Read the file. A missing or damaged file gives an empty state.
export function loadState(file: string): StorageState {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StorageState> | null;
    return {
      cookies: Array.isArray(state?.cookies) ? state.cookies : [],
      origins: Array.isArray(state?.origins) ? state.origins : [],
    };
  } catch {
    return emptyState();
  }
}

// Remove the IndexedDB of each origin whose host does not pass keep(host), e.g. a host without a
// site in sites.json.
export function filterIndexedDb(state: StorageState, keep: (host: string) => boolean): StorageState {
  return {
    cookies: state.cookies,
    origins: state.origins.map((entry) => {
      const host = hostOfUrl(entry.origin);
      if (!entry.indexedDB || (host && keep(host))) return entry;
      const { indexedDB: _indexedDB, ...rest } = entry;
      return rest as OriginState;
    }),
  };
}

const cookieKey = (cookie: Cookie): string => `${cookie.name}\n${cookie.domain}\n${cookie.path}`;
const originKey = (entry: OriginState): string => entry.origin;

// Merge the entries of one kind. base: what the lane loaded. mine: the lane now. theirs: the file now.
// An entry that the lane changed or added wins. An entry that the lane did not change keeps the
// value of the file. An entry that the lane removed goes away, if the file did not change it.
function mergeEntries<T>(base: readonly T[], mine: readonly T[], theirs: readonly T[], key: (entry: T) => string): T[] {
  const same = (a: T | undefined, b: T): boolean => JSON.stringify(a) === JSON.stringify(b);
  const baseMap = new Map(base.map((entry) => [key(entry), entry]));
  const mineMap = new Map(mine.map((entry) => [key(entry), entry]));
  const result = new Map(theirs.map((entry) => [key(entry), entry]));
  for (const [k, entry] of mineMap) {
    const before = baseMap.get(k);
    if (!before || !same(before, entry)) result.set(k, entry);
  }
  for (const [k, before] of baseMap) {
    if (mineMap.has(k)) continue;
    if (same(result.get(k), before)) result.delete(k);
  }
  return [...result.values()];
}

// Merge the state of a lane into the state of the file. now: seconds; expired cookies go away.
export function mergeState(base: StorageState, mine: StorageState, theirs: StorageState, now: number = Date.now() / 1000): StorageState {
  const cookies = mergeEntries(base.cookies, mine.cookies, theirs.cookies, cookieKey)
    .filter((cookie) => !(cookie.expires > 0 && cookie.expires < now));
  const origins = mergeEntries(base.origins, mine.origins, theirs.origins, originKey);
  return { cookies, origins };
}

// Write the file: a temp file with mode 0600, then a rename. The file is never half written.
export function writeState(file: string, state: StorageState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
