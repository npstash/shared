// Read and write the INI files of the facade and its providers.
// Format: "[section]" lines, "key = value" lines or plain lines (e.g. host patterns),
// and comment lines that start with "#" or ";". There are no comments at the end of a line.
import fs from 'node:fs';
import path from 'node:path';

// Parse INI text. Comment lines before the first section are the header.
// Each line of a section is { key, value } for "key = value", else { key } (a plain line).
export function parseIni(text) {
  const header = [];
  const sections = new Map();
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith(';')) {
      if (!current) header.push(raw);
      continue;
    }
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      const name = section[1].trim();
      if (!sections.has(name)) sections.set(name, []);
      current = sections.get(name);
      continue;
    }
    if (!current) throw new Error(`line before the first section: ${line}`);
    const eq = line.indexOf('=');
    current.push(eq < 0 ? { key: line } : { key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() });
  }
  return { header, sections };
}

export function readIni(file) {
  try {
    return parseIni(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { header: [], sections: new Map() };
    throw new Error(`${file}: ${error.message}`);
  }
}

// The "key = value" lines of a section as an object.
export function sectionValues(ini, name) {
  return Object.fromEntries((ini.sections.get(name) ?? []).filter((line) => line.value !== undefined).map((line) => [line.key, line.value]));
}

// Give INI text. sections: [[name, lines]], each line a string.
export function formatIni(header, sections) {
  const parts = [];
  if (header.length) parts.push(header.join('\n'));
  for (const [name, lines] of sections) parts.push([`[${name}]`, ...lines].join('\n'));
  return parts.join('\n\n') + '\n';
}

// Write a file in one step: a parallel reader sees the old or the new file, never a part.
export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Split a list value: "vault, ini, ask" → ['vault', 'ini', 'ask'].
export function listValue(value) {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}
