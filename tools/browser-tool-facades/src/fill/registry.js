// Placeholders in form values: the agent writes {{email}}, the facade puts in the value.
// The facade asks the providers in the order of "[fill] providers" in facade.ini.
// Each facade gives its fill arguments: the string arguments of its tools that hold placeholders.
// The first provider that has a value gives it. The client never sees the value: the facade
// replaces it with the placeholder in each result and in each file that upstream wrote (scrub).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readIni } from '../ini.js';
import { configFile } from '../paths.js';
import { FillError } from './provider.js';

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}/g;

export function placeholdersIn(text) {
  return typeof text === 'string' ? [...text.matchAll(PLACEHOLDER)].map((match) => match[1].toLowerCase()) : [];
}

export class FillRegistry {
  // fillArguments: { <tool>: (args) => [{ value, field, set(newValue) }] } for each tool of the facade
  // that types values. The facade changes only these strings.
  constructor({ providers, logger, fillArguments = {} }) {
    this.providers = providers;
    this.fillArguments = fillArguments;
    this.logger = logger;
    // value → placeholder, for the scrub. Kept for the session.
    this.secrets = new Map();
  }

  // The config of a provider is provider-<name>.ini in configDir, first a copy of its template.
  static async load({ names, providersDir, configDir, logger, fillArguments }) {
    const providers = [];
    for (const name of names) {
      const dir = path.join(providersDir, name);
      const file = configFile(configDir, `provider-${name}.ini`, path.join(dir, 'config.template.ini'));
      const { default: Provider } = await import(pathToFileURL(path.join(dir, 'index.js')).href);
      providers.push(new Provider({ name, dir, configFile: file, config: readIni(file), logger }));
    }
    logger.info('fill_providers', { providers: names });
    return new FillRegistry({ providers, logger, fillArguments });
  }

  handles(tool) {
    return tool in this.fillArguments;
  }

  // Replace the placeholders in the arguments of a call. Give the changed copy.
  async fill(tool, args, ctx) {
    if (!this.handles(tool)) return args;
    const copy = structuredClone(args ?? {});
    for (const item of this.fillArguments[tool](copy)) {
      const names = new Set(placeholdersIn(item.value));
      if (!names.size) continue;
      const values = new Map();
      for (const name of names) values.set(name, await this.resolve(name, { ...ctx, tool, field: item.field }));
      item.set(item.value.replace(PLACEHOLDER, (_, name) => values.get(name.toLowerCase())));
    }
    return copy;
  }

  async resolve(name, ctx) {
    for (const provider of this.providers) {
      const value = await provider.resolve(name, ctx);
      if (value === undefined) continue;
      this.logger.info('fill_value', { placeholder: name, provider: provider.name, host: ctx.host, field: ctx.field });
      if (value) this.secrets.set(value, `{{${name}}}`);
      return value;
    }
    const tried = this.providers.map((provider) => provider.name).join(', ') || 'none';
    throw new FillError(`no provider has a value for {{${name}}} on the host ${ctx.host ?? '(no host)'}. Providers asked: ${tried}.`);
  }

  // Replace each value that the facade filled in with its placeholder, in one text.
  clean(text) {
    const values = [...this.secrets.keys()].sort((a, b) => b.length - a.length);
    return values.reduce((out, value) => out.split(value).join(this.secrets.get(value)), text);
  }

  // Replace each value that the facade filled in with its placeholder, in each text of a result.
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

  // The placeholders that the providers can fill for ctx, for the tool fill_values_list.
  async list(ctx) {
    const lines = [];
    for (const provider of this.providers) {
      const names = await provider.list(ctx);
      if (names.length) lines.push(`- ${provider.name}: ${names.map((name) => `{{${name}}}`).join(', ')}`);
    }
    return lines;
  }

  async dispose() {
    await Promise.allSettled(this.providers.map((provider) => provider.dispose()));
  }
}
