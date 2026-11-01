// Vault provider: secrets from the vault (shared/tools/auth), through its run.sh / run.bat.
// The provider uses only the systems in [systems] of provider-vault.ini: "<host or URL prefix> =
// <exact system name>". It does not search the vault. A host matches the page host and its
// subdomains. If more lines match, the URL prefix of the page URL wins, the longest first.
// The placeholder name is the secret name, e.g. {{username}}, {{password}}, {{token}}.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { sectionValues } from '../../src/ini.js';
import { FillError, FillProvider } from '../../src/fill/provider.js';
import { normalizeHost } from '../../src/hosts/patterns.js';
import { TOOL_DIR } from '../../src/paths.js';

const run = promisify(execFile);

// The launcher of the vault tool beside this tool. Tests give a test double in BROWSER_FACADES_VAULT_TOOL.
const VAULT_TOOL = path.resolve(TOOL_DIR, '..', 'auth', 'run.sh');

export default class VaultProvider extends FillProvider {
  constructor(options) {
    super(options);
    const tool = process.env.BROWSER_FACADES_VAULT_TOOL || VAULT_TOOL;
    this.tool = process.platform === 'win32' ? tool.replace(/\.sh$/, '.bat') : tool;
    this.vaultName = sectionValues(this.config, 'vault').vault;
    this.mappings = (this.config.sections.get('systems') ?? []).filter((line) => line.value).map(({ key, value }) => {
      const url = key.includes('://') ? key : undefined;
      let host;
      try {
        host = normalizeHost(url ? new URL(url).hostname : key);
      } catch {
        host = undefined;
      }
      return { key, url, host, system: value };
    });
    this.secretNames = new Map();
  }

  async vault(args) {
    if (!this.vaultName) throw new FillError(`the vault provider needs "vault = vault-<name>" in ${this.configFile}`);
    const [command, prefix] = process.platform === 'win32' ? ['cmd', ['/c', this.tool]] : [this.tool, []];
    try {
      const { stdout } = await run(command, [...prefix, '--vault', this.vaultName, ...args], { maxBuffer: 1024 * 1024, windowsHide: true });
      return stdout;
    } catch (error) {
      // stderr of the vault tool has no secret values.
      throw new FillError(`the vault tool failed (${args[0]}): ${(error.stderr || error.message).trim()}`);
    }
  }

  // The system name for the page, undefined if none, or { ambiguous } if two lines match equally well.
  system(ctx) {
    if (!ctx.host) return undefined;
    const matching = this.mappings.filter(({ host }) => host && (ctx.host === host || ctx.host.endsWith(`.${host}`)));
    if (matching.length <= 1) return matching[0]?.system;
    const prefixes = matching.filter(({ url }) => url && ctx.url?.startsWith(url)).sort((a, b) => b.url.length - a.url.length);
    if (prefixes.length && (prefixes.length === 1 || prefixes[0].url.length > prefixes[1].url.length)) return prefixes[0].system;
    return { ambiguous: matching.map(({ key }) => key) };
  }

  // The secret names of a system, from get-system: "name<TAB>url<TAB>secret,secret".
  async secrets(system) {
    if (!this.secretNames.has(system)) {
      this.secretNames.set(system, this.vault(['get-system', system]).then((stdout) => {
        const names = stdout.split(/\r?\n/)[0].split('\t')[2];
        return names && names !== '-' ? names.split(',') : [];
      }).catch((error) => {
        this.secretNames.delete(system);   // ask again at the next call
        throw error;
      }));
    }
    return this.secretNames.get(system);
  }

  async list(ctx) {
    const system = this.system(ctx);
    return system && !system.ambiguous ? this.secrets(system) : [];
  }

  async resolve(name, ctx) {
    const system = this.system(ctx);
    if (!system) return undefined;
    if (system.ambiguous) {
      throw new FillError(`more lines of [systems] in ${this.configFile} match the host ${ctx.host}: `
        + `${system.ambiguous.join('; ')}. Give each a more specific URL prefix.`);
    }
    if (!(await this.secrets(system)).includes(name)) return undefined;
    const stdout = await this.vault(['get-secret', system, name]);
    return stdout.replace(/\r?\n$/, '');
  }
}
