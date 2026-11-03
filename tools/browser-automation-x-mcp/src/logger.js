// Logger of the server. Each server start writes two files into <dir>/<client name>/:
//   <mm-dd_hhmmss_pid>.log.json   JSON Lines with all fields of each event
//   <mm-dd_hhmmss_pid>.log        one short line for each event, for a person: see formatLine()
// The files open with open(name), when the client name is known. Events before it stay in a buffer.
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { error: 0, info: 1, debug: 2 };

// Maximum length of a line in the .log file.
export const LOG_LINE_MAX = 160;

// The number of log file pairs that stay in the folder of one client.
export const LOG_KEEP = 5;

// The values of these argument keys are secret by default: typed text and form values.
const SECRET_KEYS = new Set(['text', 'value', 'values', 'password']);

// Fields that the .log file does not show.
const HIDDEN_KEYS = new Set(['stack']);

export function createLogger({ dir, level = 'info', secrets = false, session = String(process.pid), keep = LOG_KEEP }) {
  const max = LEVELS[level] ?? LEVELS.info;
  let files;
  const buffer = [];

  function append(entry) {
    try {
      fs.appendFileSync(files.json, JSON.stringify(entry) + '\n');
      if (entry.level !== 'debug') fs.appendFileSync(files.text, formatLine(entry) + '\n');
    } catch {
      // A log failure must not stop the MCP server.
    }
  }

  function write(lvl, event, fields) {
    if (LEVELS[lvl] > max) return;
    const entry = { ts: new Date().toISOString(), level: lvl, session, event, ...fields };
    if (files) append(entry);
    else buffer.push(entry);
  }

  // Open the files in the folder of the client. Write the buffered events. Only the first call has an effect.
  function open(clientName) {
    if (files) return files;
    const folder = path.join(dir, folderName(clientName));
    try {
      fs.mkdirSync(folder, { recursive: true });
      prune(folder, keep - 1);
    } catch {
      // The log stays in the buffer if the folder cannot be made.
    }
    const base = path.join(folder, `${stamp(new Date())}_${session}`);
    files = { json: `${base}.log.json`, text: `${base}.log` };
    for (const entry of buffer.splice(0)) append(entry);
    return files;
  }

  return {
    get files() { return files; },
    level,
    isDebug: max >= LEVELS.debug,
    open,
    error: (event, fields) => write('error', event, fields),
    info: (event, fields) => write('info', event, fields),
    debug: (event, fields) => write('debug', event, fields),
    args: (value) => (secrets ? value : redact(value)),
  };
}

// The folder name of a client: lowercase, only a-z, 0-9 and "-".
export function folderName(clientName) {
  const name = String(clientName ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return name || 'unknown';
}

function stamp(date) {
  const two = (n) => String(n).padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())}_${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

// Keep the newest `count` file pairs of a folder. Delete the others.
function prune(folder, count) {
  const bases = new Map();
  for (const name of fs.readdirSync(folder)) {
    const match = name.match(/^(.+)\.log(\.json)?$/);
    if (!match) continue;
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
export function formatLine(entry) {
  const { ts, level, session, event, url, ...fields } = entry;
  const time = new Date(ts);
  const two = (n) => String(n).padStart(2, '0');
  const parts = [`${two(time.getHours())}:${two(time.getMinutes())}:${two(time.getSeconds())}`, event];
  if (url !== undefined) parts.push(compactUrl(String(url)));
  for (const [key, value] of Object.entries(fields)) {
    if (HIDDEN_KEYS.has(key) || value === undefined || value === '' || isEmpty(value)) continue;
    parts.push(`${key}=${compactValue(key, value)}`);
  }
  const line = parts.join(' ').replace(/\s*\n\s*/g, ' ');
  return line.length > LOG_LINE_MAX ? line.slice(0, LOG_LINE_MAX - 1) + '…' : line;
}

// A short URL: no scheme and no fragment; path segments of more than 24 characters and query
// values of more than 4 characters are cut.
export function compactUrl(text) {
  let url;
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

function compactValue(key, value) {
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) return compactUrl(value);
    if (path.isAbsolute(value) && value.includes(path.sep)) return path.basename(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join(',');
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${k}:${typeof v === 'object' ? JSON.stringify(v) : compactValue(k, v)}`).join(',');
  }
  return String(value);
}

function isEmpty(value) {
  return value !== null && typeof value === 'object' && Object.keys(value).length === 0;
}

function cut(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function decodeSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// Replace the secret values in tool arguments with their length.
export function redact(value, key) {
  const secret = key !== undefined && SECRET_KEYS.has(key);
  if (Array.isArray(value)) {
    return secret ? `<redacted ${value.length} items>` : value.map((item) => redact(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  if (secret && typeof value === 'string') return `<redacted ${value.length} chars>`;
  return value;
}

// Give the shape of a tool result without its content.
export function summarizeResult(result) {
  return {
    isError: Boolean(result?.isError),
    content: (result?.content ?? []).map((part) => {
      if (part.type === 'text') return { type: 'text', chars: part.text.length };
      if (part.type === 'image' || part.type === 'audio') {
        return { type: part.type, mimeType: part.mimeType, base64Chars: part.data?.length ?? 0 };
      }
      return { type: part.type };
    }),
  };
}
