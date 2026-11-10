// Run the test phases (section "Verification" of the SDD workflow). run.sh test
// starts this script.
//   node tests/run-phases.ts            all phases, in order
//   node tests/run-phases.ts <phase>... the given phases only, e.g. "unit"
// A failure does not stop the run. The exit code is 1 if a test failed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR: string = path.dirname(fileURLToPath(import.meta.url));
const PHASES: readonly string[] = ['static', 'unit', 'functional', 'online'];
const REPORTER: string = path.join(TESTS_DIR, 'reporter.ts');

function testFiles(phase: string): string[] {
  const dir = path.join(TESTS_DIR, phase);
  return fs.readdirSync(dir).filter((name) => name.endsWith('.test.ts')).sort().map((name) => path.join(dir, name));
}

function runPhase(phase: string): boolean {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', `--test-reporter=${REPORTER}`, ...testFiles(phase)], {
    stdio: 'inherit',
    env: { ...process.env, BROWSER_AUTOMATION_X_MCP_TEST_PHASE: phase },
  });
  return result.status === 0;
}

function main(args: readonly string[]): number {
  const unknown = args.filter((phase) => !PHASES.includes(phase));
  if (unknown.length) {
    process.stderr.write(`unknown test phase: ${unknown.join(', ')}. The phases are: ${PHASES.join(', ')}.\n`);
    return 2;
  }
  const phases = args.length ? PHASES.filter((phase) => args.includes(phase)) : PHASES;
  const failed = phases.filter((phase) => !runPhase(phase));
  process.stdout.write(failed.length ? `\nFailed phases: ${failed.join(', ')}\n` : '\nAll phases passed.\n');
  return failed.length ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
