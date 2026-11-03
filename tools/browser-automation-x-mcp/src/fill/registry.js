// Values for form fields: the server asks the providers in the order of "[fill] providers" in
// server.ini. The first provider that has a value gives it.
// The client never sees a value of a masked provider ("[mask] <provider> = true", the default):
// the server replaces it with MASK in each result and in each file that upstream wrote (scrub).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readIni } from '../ini.js';
import { configFile } from '../paths.js';

export const MASK = '***';

export class FillRegistry {
  // masked: the names of the providers whose values the scrub replaces.
  constructor({ providers, logger, masked = new Set(providers.map((provider) => provider.name)) }) {
    this.providers = providers;
    this.masked = masked;
    this.logger = logger;
    // The values to replace, for the scrub. Kept for the session.
    this.secrets = new Set();
  }

  // The config of a provider is provider-<name>.ini in configDir, first a copy of its template.
  // mask: { <provider>: 'true' | 'false' } from [mask] of server.ini. A missing entry is true.
  static async load({ names, providersDir, configDir, logger, mask = {} }) {
    const providers = [];
    for (const name of names) {
      const dir = path.join(providersDir, name);
      const file = configFile(configDir, `provider-${name}.ini`, path.join(dir, 'config.template.ini'));
      const { default: Provider } = await import(pathToFileURL(path.join(dir, 'index.js')).href);
      providers.push(new Provider({ name, dir, configFile: file, config: readIni(file), logger }));
    }
    const masked = new Set(names.filter((name) => mask[name] !== 'false'));
    logger.info('fill_providers', { providers: names, masked: [...masked] });
    return new FillRegistry({ providers, logger, masked });
  }

  // The value for a field name, or undefined if no provider has it.
  async resolve(name, ctx) {
    let lastProvider = null;
    for (const provider of this.providers) {
      const value = await provider.resolve(name, ctx);
      if (value === undefined) continue;
      this.logger.info('fill_value', { field: name, provider: provider.name, host: ctx.host });
      if (value && this.masked.has(provider.name)) this.secrets.add(value);
      lastProvider = provider;
      return value;
    }
    // Expose the last provider that was attempted
    this.lastProvider = lastProvider;
    return undefined;
  }

  // Replace each masked value with MASK, in one text.
  clean(text) {
    const values = [...this.secrets].sort((a, b) => b.length - a.length);
    return values.reduce((out, value) => out.split(value).join(MASK), text);
  }

  // Replace each masked value with MASK, in each text of a result.
  scrub(result) {
    if (!this.secrets.size) return result;
    const content = result.content?.map((part) => (part.type === 'text' ? { ...part, text: this.clean(part.text) } : part));
    const scrubbed = { ...result, content };
    if (result.structuredContent) scrubbed.structuredContent = JSON.parse(this.clean(JSON.stringify(result.structuredContent)));
    return scrubbed;
  }

  // The same for files that upstream wrote, e.g. snapshots and console logs. Binary files stay.
  scrubFiles(files) {
    if (!this.secrets.size) return;
    for (const file of files) {
      let text;
      try {
        const data = fs.readFileSync(file);
        if (data.includes(0)) continue;
        text = data.toString('utf8');
      } catch {
        continue;
      }
      const clean = this.clean(text);
      if (clean === text) continue;
      fs.writeFileSync(file, clean);
      this.logger.info('scrub_file', { file });
    }
  }

  async dispose() {
    await Promise.allSettled(this.providers.map((provider) => provider.dispose()));
  }
}
