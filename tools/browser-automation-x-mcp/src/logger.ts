// Logger of the server. Each server start writes two files into <dir>/<client name>/:
//   <mm-dd_hhmmss_pid>.log.json   JSON Lines with all fields of each event
//   <mm-dd_hhmmss_pid>.log        one short line for each event, for a person: see formatLine()
// The files open with open(name), when the client name is known. Events before it stay in a buffer.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'error' | 'info' | 'debug';
export type LogFields = Readonly<Record<string, unknown>>;

export interface LogFiles {
  readonly json: string;
  readonly text: string;
}

// One event of the log.
export interface LogEntry {
  readonly ts: string;
  readonly level: LogLevel;
  readonly session: string;
  readonly event: string;
  readonly [field: string]: unknown;
}

// The log of the server and of its parts.
export interface Logger {
  // The files of the log, or undefined before open().
  readonly files: LogFiles | undefined;
  readonly level: LogLevel;
  readonly isDebug: boolean;
  // Open the files in the folder of the client. Write the buffered events. Only the first call has an effect.
  open(clientName?: string): LogFiles | undefined;
  error(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  // The tool arguments for the log: the secret values are redacted, except with LOG_SECRETS.
  args(value: unknown): unknown;
}

export interface FileLoggerOptions {
  readonly dir: string;
  readonly level?: LogLevel;
  readonly secrets?: boolean;
  readonly session?: string;
  readonly keep?: number;
}

const LEVELS: Readonly<Record<LogLevel, number>> = { error: 0, info: 1, debug: 2 };

// Maximum length of a line in the .log file.
export const LOG_LINE_MAX: number = 160;

// The number of log file pairs that stay in the folder of one client.
export const LOG_KEEP: number = 5;

// The values of these argument keys are secret by default: typed text and form values.
const SECRET_KEYS: ReadonlySet<string> = new Set(['text', 'value', 'values', 'password']);

// Fields that the .log file does not show.
const HIDDEN_KEYS: ReadonlySet<string> = new Set(['stack']);

export function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(LEVELS, value);
}

// The log in two files of the folder of the client.
export class FileLogger implements Logger {
  readonly level: LogLevel;
  readonly isDebug: boolean;
  private readonly dir: string;
  private readonly secrets: boolean;
  private readonly session: string;
  private readonly keep: number;
  private readonly max: number;
  private readonly buffer: LogEntry[] = [];
  private openFiles: LogFiles | undefined;

  constructor({ dir, level = 'info', secrets = false, session = String(process.pid), keep = LOG_KEEP }: FileLoggerOptions) {
    this.dir = dir;
    this.level = level;
    this.secrets = secrets;
    this.session = session;
    this.keep = keep;
    this.max = LEVELS[level] ?? LEVELS.info;
    this.isDebug = this.max >= LEVELS.debug;
  }

  get files(): LogFiles | undefined {
    return this.openFiles;
  }

  open(clientName?: string): LogFiles | undefined {
    if (this.openFiles) return this.openFiles;
    const folder = path.join(this.dir, folderName(clientName));
    try {
      fs.mkdirSync(folder, { recursive: true });
      prune(folder, this.keep - 1);
    } catch {
      // The log stays in the buffer if the folder cannot be made.
    }
    const base = path.join(folder, `${stamp(new Date())}_${this.session}`);
    this.openFiles = { json: `${base}.log.json`, text: `${base}.log` };
    for (const entry of this.buffer.splice(0)) this.append(this.openFiles, entry);
    return this.openFiles;
  }

  error(event: string, fields?: LogFields): void {
    this.write('error', event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.write('info', event, fields);
  }

  debug(event: string, fields?: LogFields): void {
    this.write('debug', event, fields);
  }

  args(value: unknown): unknown {
    return this.secrets ? value : redact(value);
  }

  private write(level: LogLevel, event: string, fields: LogFields = {}): void {
    if (LEVELS[level] > this.max) return;
    const entry: LogEntry = { ts: new Date().toISOString(), level, session: this.session, event, ...fields };
    if (this.openFiles) this.append(this.openFiles, entry);
    else this.buffer.push(entry);
  }

  private append(files: LogFiles, entry: LogEntry): void {
    try {
      fs.appendFileSync(files.json, JSON.stringify(entry) + '\n');
      if (entry.level !== 'debug') fs.appendFileSync(files.text, formatLine(entry) + '\n');
    } catch {
      // A log failure must not stop the MCP server.
    }
  }
}

// A logger that writes nothing, e.g. for tests.
export class NullLogger implements Logger {
  readonly files: LogFiles | undefined = undefined;
  readonly level: LogLevel = 'error';
  readonly isDebug: boolean = false;

  open(): LogFiles | undefined {
    return undefined;
  }

  error(): void {}

  info(): void {}

  debug(): void {}

  args(value: unknown): unknown {
    return redact(value);
  }
}

// The folder name of a client: lowercase, only a-z, 0-9 and "-".
export function folderName(clientName: string | undefined): string {
  const name = String(clientName ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return name || 'unknown';
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function stamp(date: Date): string {
  return `${two(date.getMonth() + 1)}-${two(date.getDate())}_${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

// Keep the newest `count` file pairs of a folder. Delete the others.
function prune(folder: string, count: number): void {
  const bases = new Map<string, number>();
  for (const name of fs.readdirSync(folder)) {
    const match = name.match(/^(.+)\.log(\.json)?$/);
    if (!match?.[1]) continue;
    const time = fs.statSync(path.join(folder, name)).mtimeMs;
    bases.set(match[1], Math.max(bases.get(match[1]) ?? 0, time));
  }
  const old = [...bases].sort((a, b) => b[1] - a[1]).slice(Math.max(count, 0));
  for (const [base] of old) {
    for (const suffix of ['.log', '.log.json']) fs.rmSync(path.join(folder, base + suffix), { force: true });
  }
}

// One line of the .log file: "HH:MM:SS event url key=value ...", a maximum of LOG_LINE_MAX characters.
// No level, no session, no date: the file name gives the client, the date and the process.
export function formatLine(entry: LogEntry): string {
  const { ts, level: _level, session: _session, event, url, ...fields } = entry;
  const time = new Date(ts);
  const parts = [`${two(time.getHours())}:${two(time.getMinutes())}:${two(time.getSeconds())}`, event];
  if (url !== undefined) parts.push(compactUrl(String(url)));
  for (const [key, value] of Object.entries(fields)) {
    if (HIDDEN_KEYS.has(key) || value === undefined || value === '' || isEmpty(value)) continue;
    parts.push(`${key}=${compactValue(value)}`);
  }
  const line = parts.join(' ').replace(/\s*\n\s*/g, ' ');
  return line.length > LOG_LINE_MAX ? line.slice(0, LOG_LINE_MAX - 1) + '…' : line;
}

// A short URL: no scheme and no fragment; path segments of more than 24 characters and query
// values of more than 4 characters are cut.
export function compactUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return text;
  const segments = url.pathname.split('/').map((segment) => cut(decodeSafe(segment), 24));
  const query = [...url.searchParams].map(([key, value]) => `${cut(key, 16)}=${cut(value, 4)}`).join('&');
  return `${url.host}${segments.join('/')}${query ? `?${query}` : ''}`;
}

function compactValue(value: unknown): string {
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) return compactUrl(value);
    if (path.isAbsolute(value) && value.includes(path.sep)) return path.basename(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join(',');
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([k, v]: [string, unknown]) => `${k}:${typeof v === 'object' ? JSON.stringify(v) : compactValue(v)}`).join(',');
  }
  return String(value);
}

function isEmpty(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Object.keys(value).length === 0;
}

function cut(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// Replace the secret values in tool arguments with their length.
export function redact(value: unknown, key?: string): unknown {
  const secret = key !== undefined && SECRET_KEYS.has(key);
  if (Array.isArray(value)) {
    return secret ? `<redacted ${value.length} items>` : value.map((item: unknown) => redact(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]: [string, unknown]) => [k, redact(v, k)]));
  }
  if (secret && typeof value === 'string') return `<redacted ${value.length} chars>`;
  return value;
}

// The shape of one part of a tool result, without its content.
export type ContentSummary =
  | { readonly type: 'text'; readonly chars: number }
  | { readonly type: 'image' | 'audio'; readonly mimeType: string; readonly base64Chars: number }
  | { readonly type: string };

export interface ResultSummary {
  readonly isError: boolean;
  readonly content: ContentSummary[];
}

// Give the shape of a tool result without its content.
export function summarizeResult(result: CallToolResult | undefined): ResultSummary {
  return {
    isError: Boolean(result?.isError),
    content: (result?.content ?? []).map((part): ContentSummary => {
      if (part.type === 'text') return { type: 'text', chars: part.text.length };
      if (part.type === 'image' || part.type === 'audio') {
        return { type: part.type, mimeType: part.mimeType, base64Chars: part.data?.length ?? 0 };
      }
      return { type: part.type };
    }),
  };
}
