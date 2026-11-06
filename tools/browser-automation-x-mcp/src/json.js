// Read and write the JSON files of the server: the config files and the storage state.
import fs from 'node:fs';
import path from 'node:path';

// Read a JSON file. A missing file gives undefined. A file that is not valid JSON is an error that
// names the file.
export function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

// Write a JSON file with 2 spaces of indent, in one step: a parallel reader sees the old or the
// new file, never a part.
export function writeJson(file, data) {
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// The modification time of a file, or undefined if it is missing.
export function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}
