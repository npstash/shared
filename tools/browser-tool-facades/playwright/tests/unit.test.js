// Unit tests: redaction, result summary, the upstream environment and the render mode.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ASSETS_DIR } from '../../src/paths.js';
import { redact, summarizeResult } from '../../src/logger.js';
import { packageCandidates, parseLdd } from '../src/setup/syslibs.js';
import { CHROME_PREFS, writeChromePrefs } from '../src/chrome-prefs.js';
import { TMP_DIR, connectsToBrowser, renderMode, tmpDirForChromium, upstreamEnv, withoutHeadless } from '../src/config.js';
import { patchXkbBinDir } from '../src/xvfb.js';

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

describe('upstreamEnv', () => {
  const cwd = '/work/space';

  test('sets the defaults in the tool folder', () => {
    const env = upstreamEnv([], {}, cwd);
    assert.equal(env.PLAYWRIGHT_MCP_BROWSER, 'chromium');
    assert.equal(env.PLAYWRIGHT_MCP_OUTPUT_DIR, path.join(ASSETS_DIR, 'output'));
    assert.ok(env.PLAYWRIGHT_MCP_USER_DATA_DIR.startsWith(path.join(ASSETS_DIR, 'profiles')));
    assert.match(env.PLAYWRIGHT_MCP_USER_DATA_DIR, /-chromium-[0-9a-f]{8}$/);
    assert.ok(env.PLAYWRIGHT_BROWSERS_PATH.startsWith(path.join(ASSETS_DIR, 'browsers')));
    if (process.platform === 'linux') assert.equal(env.XDG_CACHE_HOME, path.join(ASSETS_DIR, 'cache'));
  });

  test('gives one profile for each browser and workspace', () => {
    const a = upstreamEnv([], {}, '/a').PLAYWRIGHT_MCP_USER_DATA_DIR;
    const b = upstreamEnv([], {}, '/b').PLAYWRIGHT_MCP_USER_DATA_DIR;
    const firefox = upstreamEnv(['--browser', 'firefox'], {}, '/a').PLAYWRIGHT_MCP_USER_DATA_DIR;
    const firefoxEq = upstreamEnv(['--browser=firefox'], {}, '/a').PLAYWRIGHT_MCP_USER_DATA_DIR;
    assert.notEqual(a, b);
    assert.match(firefox, /-firefox-/);
    assert.equal(firefox, firefoxEq);
  });

  test('sets no profile when the user selects the profile', () => {
    for (const args of [['--isolated'], ['--user-data-dir', '/p'], ['--cdp-endpoint=http://x'], ['--extension']]) {
      assert.equal(upstreamEnv(args, {}, cwd).PLAYWRIGHT_MCP_USER_DATA_DIR, undefined, args.join(' '));
    }
    assert.equal(upstreamEnv([], { PLAYWRIGHT_MCP_ISOLATED: 'true' }, cwd).PLAYWRIGHT_MCP_USER_DATA_DIR, undefined);
  });

  test('keeps the values of the user', () => {
    const env = upstreamEnv([], { PLAYWRIGHT_MCP_BROWSER: 'firefox', PLAYWRIGHT_MCP_USER_DATA_DIR: '/mine' }, cwd);
    assert.equal(env.PLAYWRIGHT_MCP_BROWSER, 'firefox');
    assert.equal(env.PLAYWRIGHT_MCP_USER_DATA_DIR, '/mine');
  });

  test('sets no PLAYWRIGHT_MCP_* default with a config file', () => {
    const env = upstreamEnv(['--config', 'c.json'], {}, cwd);
    assert.equal(Object.keys(env).filter((key) => key.startsWith('PLAYWRIGHT_MCP_')).length, 0);
  });

  test('sets the temp folder only when it is given', () => {
    assert.equal(upstreamEnv([], {}, cwd).TMPDIR, undefined);
    assert.equal(upstreamEnv([], {}, cwd, '/t').TMPDIR, '/t');
  });
});

describe('renderMode', () => {
  const mode = (value, { platform = 'linux', wsl = false, ...env } = {}) => renderMode({ PLAYWRIGHT_RENDER_MODE: value, ...env }, platform, wsl);
  const display = { DISPLAY: ':0' };

  test('gives HEADLESS only from the setting', () => {
    for (const platform of ['linux', 'win32', 'darwin']) assert.equal(mode('HEADLESS', { platform }), 'HEADLESS');
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

describe('render mode arguments', () => {
  test('removes --headless', () => {
    assert.deepEqual(withoutHeadless(['--headless', '--isolated', '--headless=true']), ['--isolated']);
  });

  test('finds a browser that runs already', () => {
    assert.ok(connectsToBrowser(['--cdp-endpoint=http://x']));
    assert.ok(connectsToBrowser(['--extension']));
    assert.ok(!connectsToBrowser(['--isolated']));
  });
});

describe('patchXkbBinDir', () => {
  const binary = (...parts) => Buffer.from(parts.join('\0'));

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

describe('writeChromePrefs', () => {
  const dir = path.join(ASSETS_DIR, 'test-unit', 'chrome-prefs');
  const file = path.join(dir, 'Default', 'Preferences');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

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
