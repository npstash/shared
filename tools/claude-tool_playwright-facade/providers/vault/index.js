// Vault provider: secrets from the vault (shared/tools/auth), through its run.sh / run.bat.
// The provider selects the vault system by its "url": the page host must be the host of the url
// or a subdomain of it. If more systems match, the url that is the longest prefix of the page URL
// wins. The placeholder name is the secret name, e.g. {{username}}, {{password}}, {{token}}.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { sectionValues } from '../../src/ini.js';
import { FillError, FillProvider } from '../../src/fill/provider.js';
import { normalizeHost } from '../../src/hosts/patterns.js';

const run = promisify(execFile);

export default class VaultProvider extends FillProvider {
  constructor(options) {
    super(options);
    const values = sectionValues(this.config, 'vault');
    const configDir = path.dirname(this.configFile);
    const tool = path.resolve(configDir, values.tool || '../../../auth/run.sh');
    this.tool = process.platform === 'win32' ? tool.replace(/\.sh$/, '.bat') : tool;
    this.globalArgs = [];
    if (values.vault_home) this.globalArgs.push('--vault-home', path.resolve(configDir, values.vault_home));
    if (values.subvault) this.globalArgs.push('--subvault', values.subvault);
  }

  async vault(args) {
    const [command, prefix] = process.platform === 'win32' ? ['cmd', ['/c', this.tool]] : [this.tool, []];
    try {
      const { stdout } = await run(command, [...prefix, ...this.globalArgs, ...args], { maxBuffer: 1024 * 1024, windowsHide: true });
      return stdout;
    } catch (error) {
      // stderr of the vault tool has no secret values.
      throw new FillError(`the vault tool failed (${args[0]}): ${(error.stderr || error.message).trim()}`);
    }
  }

  // The systems of the vault: name, url, secret names. "list" needs no key.
  async systems() {
    this.cache ??= this.vault(['list']).then((stdout) => stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name, url, secrets] = line.split('\t');
      return { name, url: url === '-' ? undefined : url, secrets: secrets && secrets !== '-' ? secrets.split(',') : [] };
    }));
    return this.cache;
  }

  // The system for the page, undefined if none, or an error if two match equally well.
  async system(ctx) {
    if (!ctx.host) return undefined;
    const matching = (await this.systems()).filter((system) => {
      if (!system.url) return false;
      let host;
      try {
        host = normalizeHost(new URL(system.url).hostname);
      } catch {
        return false;
      }
      return ctx.host === host || ctx.host.endsWith(`.${host}`);
    });
    if (matching.length <= 1) return matching[0];
    const prefixes = matching.filter((system) => ctx.url?.startsWith(system.url)).sort((a, b) => b.url.length - a.url.length);
    if (prefixes.length && (prefixes.length === 1 || prefixes[0].url.length > prefixes[1].url.length)) return prefixes[0];
    return { ambiguous: matching.map((system) => system.name) };
  }

  async list(ctx) {
    const system = await this.system(ctx);
    return system && !system.ambiguous ? system.secrets : [];
  }

  async resolve(name, ctx) {
    const system = await this.system(ctx);
    if (!system) return undefined;
    if (system.ambiguous) {
      throw new FillError(`more vault systems match the host ${ctx.host}: ${system.ambiguous.join('; ')}. Give each a more specific url.`);
    }
    if (!system.secrets.includes(name)) return undefined;
    const stdout = await this.vault(['get', system.name, '--secret', name]);
    return stdout.replace(/\r?\n$/, '');
  }
}
