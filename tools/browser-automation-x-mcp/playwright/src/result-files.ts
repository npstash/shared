// Result files (REQ-014b, REQ-014c and REQ-014d of sdd/SRS.md): a snapshot and a long result go into
// a file. The agent gets the path and the size, and reads the file as its task needs.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';

// A "### Result" section with more characters goes into a file.
export const RESULT_INLINE_MAX: number = 4000;

// The titles of the sections of a result. Other lines that start with "###" are text of a section.
const HEADING: RegExp = /^### (Error|Result|Open tabs|Page|Modal state|WebMCP tools|Snapshot|Events|Paused|Ran Playwright code|Note)$/gm;

const INLINE_SNAPSHOT: RegExp = /^```[a-z]*\n([\s\S]*?)\n?```$/;
const SNAPSHOT_LINK: RegExp = /^- \[Snapshot\]\((.+)\)$/;

// The location of one section in the text of a result.
interface Section {
  readonly title: string;
  // The start of the heading.
  readonly start: number;
  // The start of the text after the heading.
  readonly body: number;
  // The end of the text, without the line ends after it.
  readonly end: number;
}

// The folders for the result files of one call.
export interface ResultFolders {
  // The folder of the lane.
  readonly laneDir: string;
  // The folder that the links are relative to.
  readonly cwd: string;
  readonly outputDir: string;
}

// An empty snapshot of a result. file: the file of the snapshot, if it is not in the result.
export interface EmptySnapshot {
  readonly file: string | undefined;
}

// The sequence number of the result files: two files of one millisecond have different names.
let sequence: number = 0;

// A file name of the agent must be in the output folder. A relative name is relative to it.
// Give the absolute path, or undefined if the file is outside.
export function fileInOutput(outputDir: string, name: string): string | undefined {
  const file = path.resolve(outputDir, name);
  const relative = path.relative(outputDir, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return file;
}

function sectionsOf(text: string): Section[] {
  const heads = [...text.matchAll(HEADING)];
  return heads.map((head, index) => {
    const start = head.index;
    const body = Math.min(start + head[0].length + 1, text.length);
    const limit = heads[index + 1]?.index ?? text.length;
    return { title: head[1] ?? '', start, body, end: body + text.slice(body, limit).replace(/\n+$/, '').length };
  });
}

// The snapshot section is the last one: a page can write a heading into the text of a result.
function snapshotSection(sections: readonly Section[]): Section | undefined {
  return sections.filter(({ title }) => title === 'Snapshot').at(-1);
}

// The file of a link, if it is in the output folder.
function linkedFile(link: string, { cwd, outputDir }: Pick<ResultFolders, 'cwd' | 'outputDir'>): string | undefined {
  return fileInOutput(outputDir, path.resolve(cwd, link));
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

// Give the empty snapshot of a result, or undefined if the result has no empty snapshot.
export function findEmptySnapshot(result: CallToolResult, folders: Pick<ResultFolders, 'cwd' | 'outputDir'>): EmptySnapshot | undefined {
  if (result.isError) return undefined;
  for (const part of result.content ?? []) {
    if (part.type !== 'text') continue;
    const section = snapshotSection(sectionsOf(part.text));
    if (!section) continue;
    const body = part.text.slice(section.body, section.end);
    const inline = body.match(INLINE_SNAPSHOT);
    if (inline) return inline[1]?.trim() ? undefined : { file: undefined };
    const link = body.match(SNAPSHOT_LINK)?.[1];
    const file = link === undefined ? undefined : linkedFile(link, folders);
    if (file === undefined) return undefined;
    return readText(file)?.trim() === '' ? { file } : undefined;
  }
  return undefined;
}

// The text of the named sections of a text, by title. The last section of a title counts.
function sectionTexts(text: string, titles: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const { title, start, end } of sectionsOf(text)) {
    if (titles.includes(title)) found.set(title, text.slice(start, end));
  }
  return found;
}

// Replace the named sections of a result with the same sections of an other result.
export function replaceSections(result: CallToolResult, other: CallToolResult, titles: readonly string[]): CallToolResult {
  const otherText = other.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '';
  const replacements = sectionTexts(otherText, titles);
  const content = result.content?.map((part) => {
    if (part.type !== 'text') return part;
    const last = new Map(sectionsOf(part.text).map((section) => [section.title, section]));
    const selected = [...last.values()].filter(({ title }) => replacements.has(title)).sort((a, b) => b.start - a.start);
    let text = part.text;
    for (const { title, start, end } of selected) text = text.slice(0, start) + (replacements.get(title) ?? '') + text.slice(end);
    return { ...part, text };
  });
  return { ...result, content };
}

function sizeText(text: string): string {
  const lines = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
  return `(${lines} lines, ${text.length} characters)`;
}

function relativeLink(file: string, cwd: string): string {
  return path.relative(cwd, file).split(path.sep).join('/');
}

function writeNew(text: string, prefix: string, extension: string, { laneDir, cwd }: ResultFolders): string {
  fs.mkdirSync(laneDir, { recursive: true });
  sequence += 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(laneDir, `${prefix}-${stamp}-${sequence}.${extension}`);
  fs.writeFileSync(file, text);
  return `(${relativeLink(file, cwd)})`;
}

// The new text of a snapshot section: a link with the size, or undefined for no change.
function snapshotBody(body: string, folders: ResultFolders): string | undefined {
  const inline = body.match(INLINE_SNAPSHOT);
  if (inline) {
    const text = inline[1] ?? '';
    return `- [Snapshot]${writeNew(text, 'page', 'yml', folders)} ${sizeText(text)}`;
  }
  const link = body.match(SNAPSHOT_LINK)?.[1];
  if (link === undefined) return undefined;
  const file = linkedFile(link, folders);
  const text = file === undefined ? undefined : readText(file);
  return text === undefined ? undefined : `${body} ${sizeText(text)}`;
}

// The new text of a result section: a link with the size, or undefined for no change.
function resultBody(body: string, folders: ResultFolders): string | undefined {
  if (body.length <= RESULT_INLINE_MAX) return undefined;
  return `- [Result]${writeNew(body, 'result', 'txt', folders)} ${sizeText(body)}`;
}

function storeText(text: string, folders: ResultFolders): string {
  const sections = sectionsOf(text);
  const changes: { readonly section: Section; readonly body: string }[] = [];
  const snapshot = snapshotSection(sections);
  if (snapshot) {
    const body = snapshotBody(text.slice(snapshot.body, snapshot.end), folders);
    if (body !== undefined) changes.push({ section: snapshot, body });
  }
  const result = sections.find(({ title }) => title === 'Result');
  if (result) {
    const body = resultBody(text.slice(result.body, result.end), folders);
    if (body !== undefined) changes.push({ section: result, body });
  }
  let stored = text;
  for (const { section, body } of changes.sort((a, b) => b.section.start - a.section.start)) {
    stored = stored.slice(0, section.body) + body + stored.slice(section.end);
  }
  return stored;
}

// Move the snapshot and a long result of a call into files. An error result stays. Give the result
// after the scrub: the files must not hold a masked value.
export function storeResult(result: CallToolResult, folders: ResultFolders): CallToolResult {
  if (result.isError) return result;
  const content = result.content?.map((part) => (part.type === 'text' ? { ...part, text: storeText(part.text, folders) } : part));
  return { ...result, content };
}
