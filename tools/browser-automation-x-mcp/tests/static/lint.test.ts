// Static analysis: the lint of all code (rule typed-code): no explicit any, typed functions.
// ESLint loads eslint.config.ts with the type stripping of Node.js (flag unstable_native_nodejs_ts_config).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { TOOL_DIR } from '../../src/paths.ts';

test('eslint finds no problem', () => {
  const eslint = path.join(TOOL_DIR, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const result = spawnSync(process.execPath, [eslint, '--flag', 'unstable_native_nodejs_ts_config', '--max-warnings', '0', '.'], { cwd: TOOL_DIR, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
