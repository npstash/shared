// Result files: REQ-014c and REQ-014d of sdd/SRS.md.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ResultFolders } from '../../playwright/src/result-files.ts';
import { RESULT_INLINE_MAX, findEmptySnapshot, replaceSections, storeResult } from '../../playwright/src/result-files.ts';
import { ASSETS_DIR } from '../../src/paths.ts';

const ROOT: string = path.join(ASSETS_DIR, 'test-result-files');
const OUTPUT: string = path.join(ROOT, 'output');
const FOLDERS: ResultFolders = { laneDir: path.join(OUTPUT, 'lanes', '1-lane-a'), cwd: ROOT, outputDir: OUTPUT };

function result(text: string, isError: boolean = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function textOf(value: CallToolResult): string {
  const first = value.content?.[0];
  return first?.type === 'text' ? first.text : '';
}

function fileOf(text: string, title: string): string {
  const link = text.match(new RegExp(`\\[${title}\\]\\((.+?)\\)`))?.[1];
  assert.ok(link !== undefined, text);
  return path.resolve(ROOT, link);
}

describe('result files', () => {
  before(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(OUTPUT, { recursive: true });
  });

  after(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  test('an inline snapshot goes into a file; the other sections stay', () => {
    const text = textOf(storeResult(result('### Page\n- Page URL: http://a/\n### Snapshot\n```yaml\n- heading "A"\n- link "B"\n```\n### Events\n- New console entries: x'), FOLDERS));
    assert.match(text, /^### Page\n- Page URL: http:\/\/a\/\n### Snapshot\n- \[Snapshot\]\(output\/lanes\/1-lane-a\/page-.+\.yml\) \(2 lines, 24 characters\)\n### Events\n- New console entries: x$/);
    assert.equal(fs.readFileSync(fileOf(text, 'Snapshot'), 'utf8'), '- heading "A"\n- link "B"');
  });

  test('a snapshot file gets the size in its link', () => {
    const file = path.join(OUTPUT, 'named.yml');
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    const text = textOf(storeResult(result('### Snapshot\n- [Snapshot](output/named.yml)'), FOLDERS));
    assert.equal(text, '### Snapshot\n- [Snapshot](output/named.yml) (3 lines, 14 characters)');
  });

  test('a short result stays and a long result goes into a file', () => {
    assert.equal(textOf(storeResult(result('### Result\ntrue'), FOLDERS)), '### Result\ntrue');
    const atLimit = `### Result\n${'a'.repeat(RESULT_INLINE_MAX)}`;
    assert.equal(textOf(storeResult(result(atLimit), FOLDERS)), atLimit);
    const body = 'a'.repeat(RESULT_INLINE_MAX + 1);
    const text = textOf(storeResult(result(`### Result\n${body}\n### Page\n- Page URL: http://a/`), FOLDERS));
    assert.match(text, /^### Result\n- \[Result\]\(.+\.txt\) \(1 lines, 4001 characters\)\n### Page\n- Page URL: http:\/\/a\/$/);
    assert.equal(fs.readFileSync(fileOf(text, 'Result'), 'utf8'), body);
  });

  test('an error result stays', () => {
    const text = `### Error\n${'a'.repeat(RESULT_INLINE_MAX + 1)}\n### Snapshot\n\`\`\`yaml\n- a\n\`\`\``;
    assert.equal(textOf(storeResult(result(text, true), FOLDERS)), text);
    assert.equal(findEmptySnapshot(result('### Snapshot\n```yaml\n\n```', true), FOLDERS), undefined);
  });

  test('a link to a file outside the output folder stays unchanged and is not an empty snapshot', () => {
    const outside = path.join(ROOT, 'outside.yml');
    fs.writeFileSync(outside, '');
    const text = '### Snapshot\n- [Snapshot](outside.yml)';
    assert.equal(textOf(storeResult(result(text), FOLDERS)), text);
    assert.equal(findEmptySnapshot(result(text), FOLDERS), undefined);
  });

  test('the text of a result cannot give the snapshot: the last section counts', () => {
    fs.writeFileSync(path.join(OUTPUT, 'real.yml'), 'real\n');
    const fake = '### Snapshot\n- [Snapshot](output/other.yml)';
    const text = textOf(storeResult(result(`### Result\nx\n${fake}\n### Snapshot\n- [Snapshot](output/real.yml)`), FOLDERS));
    assert.ok(text.includes(fake));
    assert.ok(text.endsWith('- [Snapshot](output/real.yml) (1 lines, 5 characters)'), text);
  });

  test('finds an empty snapshot, inline and in a file', () => {
    assert.deepEqual(findEmptySnapshot(result('### Snapshot\n```yaml\n\n```'), FOLDERS), { file: undefined });
    assert.equal(findEmptySnapshot(result('### Snapshot\n```yaml\n- a\n```'), FOLDERS), undefined);
    const file = path.join(OUTPUT, 'empty.yml');
    fs.writeFileSync(file, '');
    assert.deepEqual(findEmptySnapshot(result('### Snapshot\n- [Snapshot](output/empty.yml)'), FOLDERS), { file });
    assert.equal(findEmptySnapshot(result('### Result\ntrue'), FOLDERS), undefined);
  });

  test('a new snapshot replaces only the page and the snapshot sections', () => {
    const before = result('### Page\n- Page URL: http://a/\n### Snapshot\n- [Snapshot](a.yml)\n### Events\n- Downloading file x ...');
    const again = result('### Page\n- Page URL: http://a/\n- Page Title: T\n### Snapshot\n- [Snapshot](a.yml)');
    assert.equal(textOf(replaceSections(before, again, ['Page', 'Snapshot'])), '### Page\n- Page URL: http://a/\n- Page Title: T\n### Snapshot\n- [Snapshot](a.yml)\n### Events\n- Downloading file x ...');
  });
});
