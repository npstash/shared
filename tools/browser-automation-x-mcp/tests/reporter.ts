// Test reporter of the test phases: a short summary for the passed tests, the full output of each
// failed test. tests/run-phases.ts gives the phase in BROWSER_AUTOMATION_X_MCP_TEST_PHASE.
import type { TestEvent } from 'node:test/reporters';
import { inspect } from 'node:util';

interface Counts {
  passed: number;
  failed: number;
  skipped: number;
}

function failure(event: Extract<TestEvent, { type: 'test:fail' }>): string {
  const { name, file, line, details } = event.data;
  const where = file ? ` (${file}${line ? `:${line}` : ''})` : '';
  return `\nFAIL ${name}${where}\n${inspect(details.error, { depth: 6, colors: false })}\n`;
}

export default async function* reporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string, void> {
  const counts: Counts = { passed: 0, failed: 0, skipped: 0 };
  const started = Date.now();
  const output: string[] = [];
  for await (const event of source) {
    if (event.type === 'test:stderr' || event.type === 'test:stdout') {
      output.push(event.data.message);
    } else if (event.type === 'test:pass' && event.data.details.type !== 'suite') {
      if (event.data.skip !== undefined || event.data.todo !== undefined) counts.skipped++;
      else counts.passed++;
    } else if (event.type === 'test:fail' && event.data.details.type !== 'suite') {
      counts.failed++;
      yield failure(event);
      if (output.length) yield `Output of the tests:\n${output.join('')}\n`;
    }
    if (event.type === 'test:pass' || event.type === 'test:fail') output.length = 0;
  }
  const phase = process.env.BROWSER_AUTOMATION_X_MCP_TEST_PHASE ?? 'tests';
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  yield `${phase}: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped (${seconds} s)\n`;
}
