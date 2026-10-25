// Unit tests: redaction, result summary and the upstream environment.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ASSETS_DIR, upstreamEnv } from '../src/config.js';
import { redact, summarizeResult } from '../src/logger.js';

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
