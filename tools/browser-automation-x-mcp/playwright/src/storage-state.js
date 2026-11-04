// The storage-state file: the logins of all lanes and sessions of one workspace.
// It holds cookies, localStorage and the IndexedDB of the listed origins (Playwright format).
// The file never goes into a result, a log or the output folder. Mode 0600.
import fs from 'node:fs';
import path from 'node:path';
import { hostOfUrl } from '../../src/hosts/patterns.js';

const EMPTY = () => ({ cookies: [], origins: [] });

// Read the file. A missing or damaged file gives an empty state.
export function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      cookies: Array.isArray(state?.cookies) ? state.cookies : [],
      origins: Array.isArray(state?.origins) ? state.origins : [],
    };
  } catch {
    return EMPTY();
  }
}

// Remove the IndexedDB of each origin that is not in the list (hosts, e.g. web.whatsapp.com).
export function filterIndexedDb(state, hosts) {
  const keep = new Set(hosts);
  return {
    cookies: state.cookies,
    origins: state.origins.map((entry) => {
      if (!entry.indexedDB || keep.has(hostOfUrl(entry.origin))) return entry;
      const { indexedDB, ...rest } = entry;
      return rest;
    }),
  };
}

const cookieKey = (cookie) => `${cookie.name}\n${cookie.domain}\n${cookie.path}`;
const originKey = (entry) => entry.origin;

// Merge the entries of one kind. base: what the lane loaded. mine: the lane now. theirs: the file now.
// An entry that the lane changed or added wins. An entry that the lane did not change keeps the
// value of the file. An entry that the lane removed goes away, if the file did not change it.
function mergeEntries(base, mine, theirs, key) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
export function mergeState(base, mine, theirs, now = Date.now() / 1000) {
  const cookies = mergeEntries(base.cookies, mine.cookies, theirs.cookies, cookieKey)
    .filter((cookie) => !(cookie.expires > 0 && cookie.expires < now));
  const origins = mergeEntries(base.origins, mine.origins, theirs.origins, originKey);
  return { cookies, origins };
}

// Write the file: a temp file with mode 0600, then a rename. The file is never half written.
export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
