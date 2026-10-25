// JSON Lines logger of the facade. Each line is one event.
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { error: 0, info: 1, debug: 2 };

// Rotate the log file at start when it is larger than this.
const LOG_MAX_SIZE = 10 * 1024 * 1024;

// The values of these argument keys are secret by default: typed text and form values.
const SECRET_KEYS = new Set(['text', 'value', 'values', 'password']);

// A value that has only placeholders (e.g. "{{email}}") has no secret. The log keeps it.
const ONLY_PLACEHOLDERS = /^(\s*\{\{\s*[A-Za-z][A-Za-z0-9_.-]*\s*\}\}\s*)+$/;

export function createLogger({ file, level = 'info', secrets = false, session = String(process.pid) }) {
  const max = LEVELS[level] ?? LEVELS.info;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotate(file);

  function write(lvl, event, fields) {
    if (LEVELS[lvl] > max) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, session, event, ...fields });
    try {
      fs.appendFileSync(file, line + '\n');
    } catch {
      // A log failure must not stop the MCP server.
    }
  }

  return {
    file,
    level,
    isDebug: max >= LEVELS.debug,
    error: (event, fields) => write('error', event, fields),
    info: (event, fields) => write('info', event, fields),
    debug: (event, fields) => write('debug', event, fields),
    args: (value) => (secrets ? value : redact(value)),
  };
}

function rotate(file) {
  try {
    if (fs.statSync(file).size > LOG_MAX_SIZE) fs.renameSync(file, file + '.1');
  } catch {
    // No file yet, or another process rotated it.
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
  if (secret && typeof value === 'string') return ONLY_PLACEHOLDERS.test(value) ? value : `<redacted ${value.length} chars>`;
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
