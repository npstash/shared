// Key-value-source "vault" (REQ-034 of sdd/SRS.md): the secrets of a vault (maya/tools/auth),
// through its run.sh.
//
//   "config": { "vault": "vault-<name>", "file": "<file in the config folder>" }
//
// The file is a host tree; each node has an optional "system": the exact name of a vault system.
//   { "hosts": { "amazon.pl": { "system": "Amazon - Nestor", "subdomains": { ... } } } }
// The nearest node with a "system" gives the system of a page. The plugin does not search the vault.
// The keys of a page are the secret names of its system. The case of a key has no effect.
// keysOf(): compares a value with each secret of the system; the values are not kept.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { KeyValueSource } from '../../../src/plugins/key-value-source.ts';
import { SourceError } from '../../../src/plugins/key-value-source.ts';
import type { PageInfo, PluginContext } from '../../../src/plugins/plugin.ts';
import type { TreeNode } from '../../common/files/index.ts';
import { chainOf, mtimeOf, pluginFile, readObject, writeObject } from '../../common/files/index.ts';

const run = promisify(execFile);

// The launcher of the vault tool beside this tool. Tests give a test double in BROWSER_AUTOMATION_X_MCP_VAULT_TOOL.
const VAULT_TOOL: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'auth', 'run.sh');

// The data of a node of the vault file.
interface VaultNode {
  system?: string;
}

interface VaultFileContent {
  hosts: Record<string, TreeNode<VaultNode>>;
}

export default class VaultSource implements KeyValueSource {
  private readonly vaultName: string;
  private readonly file: string;
  private readonly tool: string;
  private mtime: number | undefined = undefined;
  private content: VaultFileContent = { hosts: {} };
  // The secret names of each system, from get-system. Kept for the session.
  private readonly secretNames: Map<string, Promise<string[]>> = new Map();

  constructor(context: PluginContext) {
    const vault = context.config.vault;
    if (typeof vault !== 'string' || !vault) throw new Error(`the instance "${context.name}" needs "vault": "vault-<name>" in its config`);
    this.vaultName = vault;
    this.file = pluginFile(context, 'file');
    const tool = process.env.BROWSER_AUTOMATION_X_MCP_VAULT_TOOL || VAULT_TOOL;
    this.tool = tool;
    // A missing file is a new empty file.
    if (mtimeOf(this.file) === undefined) writeObject(this.file, { hosts: {} });
  }

  // The vault system of the page, or undefined.
  private system(page: PageInfo): string | undefined {
    const mtime = mtimeOf(this.file);
    if (mtime === undefined || mtime !== this.mtime) {
      const data = readObject(this.file, () => ({ hosts: {} }));
      if (!data.hosts || typeof data.hosts !== 'object' || Array.isArray(data.hosts)) throw new SourceError(`${this.file}: "hosts" must be an object`);
      this.content = data as unknown as VaultFileContent;
      this.mtime = mtime;
    }
    return chainOf(this.content.hosts, page).reverse().find((node) => typeof node.system === 'string' && node.system)?.system;
  }

  private async vault(args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await run(this.tool, ['--vault', this.vaultName, ...args], { maxBuffer: 1024 * 1024 });
      return stdout;
    } catch (error) {
      // stderr of the vault tool has no secret values.
      const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError(`the vault tool failed (${args[0]}): ${(stderr || message).trim()}`);
    }
  }

  // The secret names of a system, from get-system: "name<TAB>url<TAB>secret,secret".
  private secrets(system: string): Promise<string[]> {
    let names = this.secretNames.get(system);
    if (!names) {
      names = this.vault(['get-system', system]).then((stdout) => {
        const list = (stdout.split(/\r?\n/)[0] ?? '').split('\t')[2];
        return list && list !== '-' ? list.split(',') : [];
      }).catch((error: unknown) => {
        this.secretNames.delete(system);   // ask again at the next call
        throw error;
      });
      this.secretNames.set(system, names);
    }
    return names;
  }

  private async get(system: string, name: string): Promise<string> {
    const stdout = await this.vault(['get-secret', system, name]);
    return stdout.replace(/\r?\n$/, '');
  }

  async keys(page: PageInfo): Promise<readonly string[]> {
    const system = this.system(page);
    return system ? this.secrets(system) : [];
  }

  async values(keys: readonly string[], page: PageInfo): Promise<Readonly<Record<string, string>>> {
    const system = this.system(page);
    if (!system) return {};
    const names = await this.secrets(system);
    const result: Record<string, string> = {};
    for (const key of keys) {
      const name = names.find((each) => each.toLowerCase() === key.toLowerCase());
      if (name !== undefined) result[key] = await this.get(system, name);
    }
    return result;
  }

  async keysOf(value: string, page: PageInfo): Promise<readonly string[]> {
    const system = this.system(page);
    if (!system || !value) return [];
    const keys: string[] = [];
    for (const name of await this.secrets(system)) {
      if (await this.get(system, name) === value) keys.push(name);
    }
    return keys;
  }
}
