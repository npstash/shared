// Read and write the JSON files of the server: the config files and the storage state.
import fs from 'node:fs';
import path from 'node:path';

// A value that JSON can hold.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// True if the value is a JSON object: not null, not an array.
export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The message of an error of any type.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The code of a Node.js system error, e.g. "ENOENT", or undefined.
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

// Read a JSON file. A missing file gives undefined. A file that is not valid JSON is an error that
// names the file.
export function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: ${errorMessage(error)}`, { cause: error });
  }
}

// Write a JSON file with 2 spaces of indent, in one step: a parallel reader sees the old or the
// new file, never a part.
export function writeJson(file: string, data: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// The modification time of a file, or undefined if it is missing.
export function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}
