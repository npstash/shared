// Unit tests: redaction, result summary, the environment, the render mode, the storage state,
// the masks and the lanes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ASSETS_DIR, TOOL_DIR } from '../../src/paths.ts';
import { redact, summarizeResult } from '../../src/logger.ts';
import { packageCandidates, parseLdd } from '../../playwright/src/setup/syslibs.ts';
import { STATE_DIR, TMP_DIR, ignoredVariables, outputDir, processEnv, renderMode, stateFile, takeConfigDir, tmpDirForChromium } from '../../playwright/src/config.ts';
import { LANE_IDLE, Lanes, MAX_LANES, MAX_TABS_PER_LANE } from '../../playwright/src/lanes.ts';
import { fileInOutput, maskHeaders } from '../../playwright/src/mcp-server.ts';
import { filterIndexedDb, loadState, mergeState, writeState } from '../../playwright/src/storage-state.ts';
import { patchXkbBinDir } from '../../playwright/src/xvfb.ts';
import type { Lane, LanesOptions } from '../../playwright/src/lanes.ts';
import type { Cookie, OriginState } from '../../playwright/src/storage-state.ts';
import type { BrowserContext } from 'playwright-core';
import { NullLogger } from '../../src/logger.ts';
import { CHROME_PREFS, writeChromePrefs } from '../../playwright/src/chrome-prefs.ts';

describe('redact', () => {
  test('replaces typed text and form values', () => {
    const args = {
      target: 'e5',
      text: 'secret',
      fields: [{ name: 'Password', type: 'textbox', target: 'e7', value: 'p4ss' }],
      values: ['a', 'b'],
    };
    assert.deepEqual(redact(args), {
      target: 'e5',
      text: '<redacted 6 chars>',
      fields: [{ name: 'Password', type: 'textbox', target: 'e7', value: '<redacted 4 chars>' }],
      values: '<redacted 2 items>',
    });
  });

  test('keeps other values', () => {
    assert.deepEqual(redact({ url: 'https://example.com', submit: true }), { url: 'https://example.com', submit: true });
    assert.equal(redact(undefined), undefined);
  });
});

describe('summarizeResult', () => {
  test('gives the shape without the content', () => {
    const summary = summarizeResult({
      content: [{ type: 'text', text: 'hello' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }],
    });
    assert.deepEqual(summary, {
      isError: false,
      content: [{ type: 'text', chars: 5 }, { type: 'image', mimeType: 'image/png', base64Chars: 4 }],
    });
  });
});

describe('environment', () => {
  test('sets the browsers, the cache and the temp folder in the tool folder; keeps a browsers path of the user', () => {
    const env = processEnv({});
    assert.ok(env.PLAYWRIGHT_BROWSERS_PATH.startsWith(path.join(ASSETS_DIR, 'browsers')));
    if (process.platform === 'linux') assert.equal(env.XDG_CACHE_HOME, path.join(ASSETS_DIR, 'cache'));
    assert.equal(env.TMPDIR, undefined);
    assert.equal(processEnv({}, '/t').TMPDIR, '/t');
    assert.equal(processEnv({ PLAYWRIGHT_BROWSERS_PATH: '/b' }).PLAYWRIGHT_BROWSERS_PATH, '/b');
  });

  test('the output files go to the workspace', () => {
    assert.equal(outputDir('/work/space'), path.join('/work/space', '.local_assets', 'browser-automation-x-mcp', 'output'));
  });

  test('one storage-state file for each workspace in the tool folder, except when the variable gives an other file', () => {
    assert.match(stateFile({}, '/a'), /storage-state-[0-9a-f]{8}\.json$/);
    assert.equal(path.dirname(stateFile({}, '/a')), STATE_DIR);
    assert.ok(STATE_DIR.startsWith(ASSETS_DIR));
    assert.notEqual(stateFile({}, '/a'), stateFile({}, '/b'));
    assert.equal(stateFile({ BROWSER_AUTOMATION_X_MCP_STORAGE_STATE: '/s.json' }, '/a'), '/s.json');
  });

  test('finds the variables of Playwright MCP', () => {
    assert.deepEqual(ignoredVariables({ PLAYWRIGHT_MCP_HEADLESS: 'true', PLAYWRIGHT_BROWSERS_PATH: '/b', PLAYWRIGHT_MCP_BROWSER: 'x' }), ['PLAYWRIGHT_MCP_BROWSER', 'PLAYWRIGHT_MCP_HEADLESS']);
  });
});

describe('renderMode', () => {
  type ModeOptions = { platform?: NodeJS.Platform; wsl?: boolean; DISPLAY?: string; WAYLAND_DISPLAY?: string };
  const mode = (value: string | undefined, { platform = 'linux', wsl = false, ...env }: ModeOptions = {}): string => renderMode({ RENDER_MODE: value, ...env }, platform, wsl);
  const display = { DISPLAY: ':0' };

  test('gives HEADLESS only from the setting', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) assert.equal(mode('HEADLESS', { platform }), 'HEADLESS');
    for (const value of [undefined, 'DEFAULT', 'HEADED', 'HEADED_INVISIBLE']) assert.notEqual(mode(value, display), 'HEADLESS');
  });

  test('gives HEADED_INVISIBLE by default on WSL and on Linux without a display', () => {
    assert.equal(mode(undefined, { ...display, wsl: true }), 'HEADED_INVISIBLE');
    assert.equal(mode('DEFAULT'), 'HEADED_INVISIBLE');
    assert.equal(mode('DEFAULT', display), 'HEADED');
    assert.equal(mode('DEFAULT', { WAYLAND_DISPLAY: 'wayland-0' }), 'HEADED');
  });

  test('gives HEADED by default on Windows and macOS', () => {
    assert.equal(mode(undefined, { platform: 'win32' }), 'HEADED');
    assert.equal(mode('DEFAULT', { platform: 'darwin' }), 'HEADED');
  });

  test('gives HEADED with a display, also on WSL, else HEADED_INVISIBLE', () => {
    assert.equal(mode('HEADED', { ...display, wsl: true }), 'HEADED');
    assert.equal(mode('HEADED', { platform: 'win32' }), 'HEADED');
    assert.equal(mode('HEADED'), 'HEADED_INVISIBLE');
  });

  test('gives HEADED_INVISIBLE on Linux, else stops', () => {
    assert.equal(mode('HEADED_INVISIBLE', display), 'HEADED_INVISIBLE');
    assert.throws(() => mode('HEADED_INVISIBLE', { platform: 'win32' }), /needs Xvfb/);
    assert.throws(() => mode('HEADED_INVISIBLE', { platform: 'darwin' }), /needs Xvfb/);
  });

  test('stops with an unknown value', () => {
    assert.throws(() => mode('headless', display), /not known/);
  });
});

describe('takeConfigDir', () => {
  test('takes --config-dir; a relative path is relative to cwd', () => {
    assert.deepEqual(takeConfigDir(['--config-dir', 'local/c'], '/repo'), { configDir: path.resolve('/repo', 'local/c') });
    assert.deepEqual(takeConfigDir(['--config-dir=/abs/c'], '/repo'), { configDir: path.resolve('/abs/c') });
  });

  test('the argument is necessary', () => {
    assert.throws(() => takeConfigDir([]), /give the config folder with --config-dir DIR/);
  });

  test('an other argument is an error', () => {
    for (const arg of ['--isolated', '--headless', '--browser=firefox', '--viewport-size']) {
      assert.throws(() => takeConfigDir(['--config-dir', 'c', arg]), new RegExp(`unknown argument ${arg}`));
    }
  });

  test('the server does not start with an other argument', () => {
    const result = spawnSync(process.execPath, [path.join(TOOL_DIR, 'playwright', 'src', 'server.ts'), '--config-dir', 'c', '--isolated'], {
      encoding: 'utf8',
      env: { ...process.env, BROWSER_AUTOMATION_X_MCP_LOG_DIR: path.join(ASSETS_DIR, 'test-unit', 'logs') },
      timeout: 20000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown argument --isolated/);
  });
});

describe('patchXkbBinDir', () => {
  const binary = (...parts: string[]): Buffer => Buffer.from(parts.join('\0'));

  test('sets ./bin for the path of xkbcomp', () => {
    const patched = patchXkbBinDir(binary('a', '/usr/bin', '%s%sxkbcomp', ''));
    assert.deepEqual(patched, binary('a', './bin', '', '', '', '%s%sxkbcomp', ''));
  });

  test('keeps a patched binary', () => {
    const patched = patchXkbBinDir(binary('a', '/usr/bin', 'b'));
    assert.deepEqual(patchXkbBinDir(patched), patched);
  });

  test('stops when the path is not there exactly one time', () => {
    assert.throws(() => patchXkbBinDir(binary('a', 'b')), /0 times/);
    assert.throws(() => patchXkbBinDir(binary('a', '/usr/bin', '/usr/bin', 'b')), /2 times/);
  });
});

describe('storage state', () => {
  const cookie = (name: string, value: string, extra: Partial<Cookie> = {}): Cookie => ({ name, value, domain: 'a.test', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax', ...extra });
  const origin = (url: string, value: string, extra: Partial<OriginState> = {}): OriginState => ({ origin: url, localStorage: [{ name: 'k', value }], ...extra });

  test('an entry that the lane changed or added wins; an entry that it did not change keeps the file value', () => {
    const base = { cookies: [cookie('a', '1'), cookie('b', '1')], origins: [origin('https://a.test', '1')] };
    const mine = { cookies: [cookie('a', '2'), cookie('b', '1'), cookie('n', '1')], origins: [origin('https://a.test', '1')] };
    const theirs = { cookies: [cookie('a', '1'), cookie('b', '9')], origins: [origin('https://a.test', '9')] };
    const merged = mergeState(base, mine, theirs);
    assert.deepEqual(Object.fromEntries(merged.cookies.map((c) => [c.name, c.value])), { a: '2', b: '9', n: '1' });
    assert.equal(merged.origins[0].localStorage[0].value, '9');
  });

  test('an entry that the lane removed goes away, if the file did not change it', () => {
    const base = { cookies: [cookie('a', '1'), cookie('b', '1')], origins: [] };
    const mine = { cookies: [], origins: [] };
    const theirs = { cookies: [cookie('a', '1'), cookie('b', '9')], origins: [] };
    assert.deepEqual(mergeState(base, mine, theirs).cookies.map((c) => `${c.name}=${c.value}`), ['b=9']);
  });

  test('removes expired cookies', () => {
    const state = { cookies: [cookie('old', '1', { expires: 100 }), cookie('session', '1'), cookie('new', '1', { expires: 300 })], origins: [] };
    assert.deepEqual(mergeState({ cookies: [], origins: [] }, state, { cookies: [], origins: [] }, 200).cookies.map((c) => c.name), ['session', 'new']);
  });

  test('keeps IndexedDB only for the hosts that pass the check (the sites of sites.json)', () => {
    const state = { cookies: [], origins: [origin('https://web.whatsapp.com', '1', { indexedDB: [{ name: 'db' }] }), origin('https://other.test', '1', { indexedDB: [{ name: 'db' }] })] };
    const filtered = filterIndexedDb(state, (host) => host === 'web.whatsapp.com');
    assert.ok(filtered.origins[0].indexedDB);
    assert.equal(filtered.origins[1].indexedDB, undefined);
    assert.equal(filtered.origins[1].localStorage[0].value, '1');
  });

  test('writes the file with mode 0600; a missing or damaged file gives an empty state', { skip: process.platform === 'win32' }, () => {
    const file = path.join(ASSETS_DIR, 'test-unit', 'state', 'state.json');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    assert.deepEqual(loadState(file), { cookies: [], origins: [] });
    writeState(file, { cookies: [cookie('a', '1')], origins: [] });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(loadState(file).cookies[0].value, '1');
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(loadState(file), { cookies: [], origins: [] });
  });
});

describe('masks', () => {
  test('masks the values of secret headers', () => {
    const text = 'GET /\ncookie: a=1; b=2\nSet-Cookie: s=3\n- authorization: Bearer x\naccept: */*\nProxy-Authorization: Basic y';
    assert.equal(maskHeaders(text), 'GET /\ncookie: ***\nSet-Cookie: ***\n- authorization: ***\naccept: */*\nProxy-Authorization: ***');
  });

  test('a file name must be in the output folder; a relative name is relative to it', () => {
    const dir = path.resolve('/w/out');
    assert.equal(fileInOutput(dir, 'a.yml'), path.join(dir, 'a.yml'));
    assert.equal(fileInOutput(dir, 'sub/a.yml'), path.join(dir, 'sub', 'a.yml'));
    assert.equal(fileInOutput(dir, path.join(dir, 'b.png')), path.join(dir, 'b.png'));
    for (const name of ['../a.yml', '/etc/passwd', path.resolve('/w/other.yml'), '.', '']) assert.equal(fileInOutput(dir, name), undefined, name);
  });
});

describe('lanes', () => {
  const logger = new NullLogger();
  // A lane without a browser, for the tests of the lane list.
  const fakeLane = (fields: Partial<Lane> & { id: string }): Lane => ({
    browserSession: 'normal', opened: 0, lastUsed: 0, busy: 0, context: undefined, client: undefined, notes: [], base: undefined,
    dir: '', outputDir: undefined, closing: false, saving: undefined, session: undefined, ...fields,
  });
  const lanes = (options: Partial<LanesOptions> = {}): Lanes => {
    const value = new Lanes({ mode: 'HEADLESS', logger, stateFile: '/nowhere.json', ...options });
    clearInterval(value.timer);
    return value;
  };

  test('the limits', () => {
    assert.equal(MAX_LANES, 3);
    assert.equal(MAX_TABS_PER_LANE, 5);
    assert.equal(LANE_IDLE, 10 * 60 * 1000);
  });

  test('closes a lane without a call for the idle time, but not a busy lane', async () => {
    const value = lanes({ idle: 1000 });
    const closed: [string | undefined, string][] = [];
    value.close = async (id: string | undefined, reason: string): Promise<boolean> => { closed.push([id, reason]); return value.lanes.delete(id ?? ''); };
    value.lanes.set('lane-1', fakeLane({ id: 'lane-1', lastUsed: 0, busy: 0 }));
    value.lanes.set('lane-2', fakeLane({ id: 'lane-2', lastUsed: 0, busy: 1 }));
    value.lanes.set('lane-3', fakeLane({ id: 'lane-3', lastUsed: 500, busy: 0 }));
    await value.closeIdle(1200);
    assert.deepEqual(closed, [['lane-1', 'idle']]);
  });

  test('gives no lane over the maximum', async () => {
    const value = lanes({ maxLanes: 1 });
    value.lanes.set('lane-1', fakeLane({ id: 'lane-1', lastUsed: 0, busy: 0 }));
    assert.equal(await value.open(), undefined);
  });

  test('the status gives the open lanes and the maximum', () => {
    const value = lanes();
    const context = { pages: (): unknown[] => [1, 2] } as unknown as BrowserContext;
    value.lanes.set('lane-1', fakeLane({ id: 'lane-1', browserSession: 'fresh', lastUsed: 0, busy: 1, context }));
    assert.equal(value.status(5000), 'Open lanes: 1 of 3.\n- lane-1: browser session fresh, 2 tabs, idle 5 s, busy');
  });
});

describe('writeChromePrefs', () => {
  const dir = path.join(ASSETS_DIR, 'test-unit', 'chrome-prefs');
  const file = path.join(dir, 'Default', 'Preferences');
  // The settings of the profile that the tests read.
  interface ProfilePrefs {
    homepage?: string;
    profile: { name?: string; exit_type: string; password_manager_enabled: boolean; password_manager_leak_detection: boolean; default_content_setting_values: { notifications: number } };
  }
  const read = (): ProfilePrefs => JSON.parse(fs.readFileSync(file, 'utf8')) as ProfilePrefs;

  test('adds the settings and keeps the other settings of the profile', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ homepage: 'x', profile: { name: 'P', exit_type: 'Crashed', password_manager_enabled: true } }));
    writeChromePrefs(dir);
    const prefs = read();
    assert.equal(prefs.homepage, 'x');
    assert.equal(prefs.profile.name, 'P');
    assert.equal(prefs.profile.exit_type, 'Normal');
    assert.equal(prefs.profile.password_manager_enabled, false);
    assert.equal(prefs.profile.password_manager_leak_detection, false);
    assert.equal(prefs.profile.default_content_setting_values.notifications, 2);
  });

  test('a missing or damaged file gets only the settings', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    writeChromePrefs(dir);
    assert.deepEqual(read(), CHROME_PREFS);
    fs.writeFileSync(file, '{not json');
    writeChromePrefs(dir);
    assert.deepEqual(read(), CHROME_PREFS);
  });
});

describe('tmpDirForChromium', () => {
  test('skips a folder with a socket path that is too long', { skip: process.platform === 'win32' }, async () => {
    const long = path.join(ASSETS_DIR, 'test-unit', 'x'.repeat(120));
    const short = path.join(ASSETS_DIR, 'test-unit', 'short');
    const expected = short.length + 45 <= 107 ? short : undefined;
    assert.equal(await tmpDirForChromium([long, short]), expected);
    assert.equal(await tmpDirForChromium([long]), undefined);
  });

  test('gives the tool folder first if it can hold the socket', { skip: process.platform === 'win32' || TMP_DIR.length + 45 > 107 }, async () => {
    assert.equal(await tmpDirForChromium(), TMP_DIR);
  });
});

describe('syslibs', () => {
  test('maps sonames to packages', () => {
    const cases = {
      'libnss3.so': ['libnss3t64', 'libnss3'],
      'libnspr4.so': ['libnspr4t64', 'libnspr4'],
      'libsmime3.so': ['libnss3t64', 'libnss3'],
      'libX11.so.6': ['libx11-6t64', 'libx11-6'],
      'libXrandr.so.2': ['libxrandr2t64', 'libxrandr2'],
      'libasound.so.2': ['libasound2t64', 'libasound2'],
      'libglib-2.0.so.0': ['libglib2.0-0t64', 'libglib2.0-0'],
      'libatk-bridge-2.0.so.0': ['libatk-bridge2.0-0t64', 'libatk-bridge2.0-0'],
      'libdbus-1.so.3': ['libdbus-1-3t64', 'libdbus-1-3'],
      'libgssapi_krb5.so.2': ['libgssapi-krb5-2t64', 'libgssapi-krb5-2'],
      'libbz2.so.1.0': ['libbz2-1.0t64', 'libbz2-1.0'],
    };
    for (const [soname, packages] of Object.entries(cases)) assert.deepEqual(packageCandidates(soname), packages, soname);
  });

  test('reads the missing libraries from ldd', () => {
    const text = '\tlinux-vdso.so.1 (0x1)\n\tlibnss3.so => not found\n\tlibc.so.6 => /lib/libc.so.6 (0x2)\n\tlibnspr4.so => not found\n';
    assert.deepEqual(parseLdd(text), ['libnss3.so', 'libnspr4.so']);
  });
});
