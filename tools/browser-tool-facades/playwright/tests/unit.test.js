// Unit tests: redaction, result summary and the upstream environment.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ASSETS_DIR } from '../../src/paths.js';
import { redact, summarizeResult } from '../../src/logger.js';
import { packageCandidates, parseLdd } from '../src/setup/syslibs.js';
import { upstreamEnv } from '../src/config.js';

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
    assert.equal(env.PLAYWRIGHT_MCP_HEADLESS, 'true');
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
    const env = upstreamEnv([], { PLAYWRIGHT_MCP_BROWSER: 'firefox', PLAYWRIGHT_MCP_USER_DATA_DIR: '/mine', PLAYWRIGHT_MCP_HEADLESS: 'false' }, cwd);
    assert.equal(env.PLAYWRIGHT_MCP_BROWSER, 'firefox');
    assert.equal(env.PLAYWRIGHT_MCP_HEADLESS, 'false');
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
