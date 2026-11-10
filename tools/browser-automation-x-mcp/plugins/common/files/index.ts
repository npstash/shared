// Shared plugin code: the JSON files of a plugin, and the host trees in them.
// A host tree has the form of hosts.json (REQ-037 of sdd/SRS.md): root domains with "subdomains".
import fs from 'node:fs';
import path from 'node:path';
import type { JsonObject } from '../../../src/json.ts';
import type { PageInfo, PluginContext } from '../../../src/plugins/plugin.ts';

// A node of a host tree with the data N of the plugin.
export type TreeNode<N> = N & { subdomains?: Record<string, TreeNode<N>> };

// The file of a plugin: a path of its config, relative to the config folder.
export function pluginFile(context: PluginContext, key: string): string {
  const value = context.config[key];
  if (typeof value !== 'string' || !value) throw new Error(`the instance "${context.name}" needs "${key}" in its config`);
  return path.resolve(context.configDir, value);
}

// The modification time of a file, or undefined if it is missing.
export function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

// Read a JSON object from a file. A missing file gives the empty value.
export function readObject(file: string, empty: () => JsonObject): JsonObject {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return empty();
  }
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file}: the file must have a JSON object`);
  return data as JsonObject;
}

// Write a JSON file in one step, with 2 spaces of indent.
export function writeObject(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// The nodes of a host tree for a page, from the root domain to the most specific node.
export function chainOf<N>(tree: Record<string, TreeNode<N>>, page: PageInfo): TreeNode<N>[] {
  const hosts = [...page.hosts].reverse();
  const root = hosts[0];
  const chain: TreeNode<N>[] = [];
  let node = root === undefined ? undefined : tree[root];
  if (!node) return chain;
  chain.push(node);
  for (const host of hosts.slice(1)) {
    const next: TreeNode<N> | undefined = node?.subdomains?.[host];
    if (!next) continue;
    chain.push(next);
    node = next;
  }
  return chain;
}
