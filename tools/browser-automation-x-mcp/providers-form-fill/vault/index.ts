// Vault provider (key-value): secrets from the vault (shared/tools/auth), through its run.sh / run.bat.
// The vault name is "vault" of its entry in server.json. The vault system of a page is "entry" of the
// nearest "provider-config"."vault" in sites.json (src/sites.js), if its "vault" is the vault name of
// this provider. The provider does not search the vault.
// The key of sites.json is the secret name, e.g. username, password, token. The case has no effect.
// match(): compares a value with each secret of the system; the values are not kept.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FillContext, ProviderOptions } from '../../src/fill/provider.ts';
import { FillError, KeyValueProvider } from '../../src/fill/provider.ts';
import { errorMessage } from '../../src/json.ts';
import { TOOL_DIR } from '../../src/paths.ts';

const run = promisify(execFile);

// The launcher of the vault tool beside this tool. Tests give a test double in BROWSER_AUTOMATION_X_MCP_VAULT_TOOL.
const VAULT_TOOL: string = path.resolve(TOOL_DIR, '..', 'auth', 'run.sh');

// A secret of a vault system.
export interface SecretName {
  readonly system: string;
  readonly name: string;
}

export default class VaultProvider extends KeyValueProvider {
  readonly tool: string;
  readonly vaultName: string | undefined;
  // The secret names of each system, from get-system. Kept for the session.
  private readonly secretNames: Map<string, Promise<string[]>>;

  constructor(options: ProviderOptions) {
    super(options);
    const tool = process.env.BROWSER_AUTOMATION_X_MCP_VAULT_TOOL || VAULT_TOOL;
    this.tool = process.platform === 'win32' ? tool.replace(/\.sh$/, '.bat') : tool;
    this.vaultName = typeof this.settings.vault === 'string' ? this.settings.vault : undefined;
    this.secretNames = new Map();
  }

  requireVaultName(): string {
    if (!this.vaultName) throw new FillError('the vault provider needs "vault": "vault-<name>" in server.json');
    return this.vaultName;
  }

  async vault(args: readonly string[]): Promise<string> {
    const vaultName = this.requireVaultName();
    const [command, prefix] = process.platform === 'win32' ? ['cmd', ['/c', this.tool]] : [this.tool, []];
    try {
      const { stdout } = await run(command, [...prefix, '--vault', vaultName, ...args], { maxBuffer: 1024 * 1024, windowsHide: true });
      return stdout;
    } catch (error) {
      // stderr of the vault tool has no secret values.
      const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
      throw new FillError(`the vault tool failed (${args[0]}): ${(stderr || errorMessage(error)).trim()}`);
    }
  }

  // The vault system of the page (sites.json), or undefined.
  override system(ctx: FillContext): string | undefined {
    const config = ctx.url ? this.sites?.providerConfig(ctx.url, 'vault') : undefined;
    return config && config.vault === this.vaultName && typeof config.entry === 'string' ? config.entry : undefined;
  }

  // The secret names of a system, from get-system: "name<TAB>url<TAB>secret,secret".
  async secrets(system: string): Promise<string[]> {
    if (!this.secretNames.has(system)) {
      this.secretNames.set(system, this.vault(['get-system', system]).then((stdout) => {
        const names = (stdout.split(/\r?\n/)[0] ?? '').split('\t')[2];
        return names && names !== '-' ? names.split(',') : [];
      }).catch((error: unknown) => {
        this.secretNames.delete(system);   // ask again at the next call
        throw error;
      }));
    }
    return this.secretNames.get(system) ?? [];
  }

  // The secret name of the system for the key, or undefined.
  async secretName(key: string, ctx: FillContext): Promise<SecretName | undefined> {
    this.requireVaultName();
    const system = this.system(ctx);
    if (!system) return undefined;
    const wanted = String(key).toLowerCase();
    const name = (await this.secrets(system)).find((each) => each.toLowerCase() === wanted);
    return name === undefined ? undefined : { system, name };
  }

  async get(system: string, name: string): Promise<string> {
    const stdout = await this.vault(['get-secret', system, name]);
    return stdout.replace(/\r?\n$/, '');
  }

  override async has(key: string, ctx: FillContext): Promise<boolean> {
    return (await this.secretName(key, ctx)) !== undefined;
  }

  async resolve(key: string, ctx: FillContext): Promise<string | undefined> {
    const secret = await this.secretName(key, ctx);
    return secret ? this.get(secret.system, secret.name) : undefined;
  }

  async match(value: string, ctx: FillContext): Promise<string | undefined> {
    this.requireVaultName();
    const system = this.system(ctx);
    if (!system) return undefined;
    for (const name of await this.secrets(system)) {
      if (await this.get(system, name) === value) return name;
    }
    return undefined;
  }
}
