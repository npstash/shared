// Static analysis: the type check of all code in strict mode (rule typed-code).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { TOOL_DIR } from '../../src/paths.ts';

test('tsc --noEmit finds no type error', () => {
  const tsc = path.join(TOOL_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', TOOL_DIR], { cwd: TOOL_DIR, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
