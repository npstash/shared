// Placeholders in form values: the agent writes {{email}}, the facade puts in the value.
// The facade asks the providers in the order of "[fill] providers" in config/facade.ini.
// The first provider that has a value gives it. The client never sees the value: the facade
// replaces it with the placeholder in each result (scrub).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readIni } from '../ini.js';
import { FillError } from './provider.js';

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}/g;

// The string arguments that can hold placeholders, for each tool.
// Each entry gives the values and a function that sets them back.
const FILL_ARGUMENTS = {
  browser_type: (args) => [{ value: args.text, field: args.element, set: (v) => { args.text = v; } }],
  browser_fill_form: (args) => (args.fields ?? []).map((field) => ({ value: field.value, field: field.name, set: (v) => { field.value = v; } })),
  browser_select_option: (args) => (args.values ?? []).map((value, i) => ({ value, field: args.element, set: (v) => { args.values[i] = v; } })),
};

export function placeholdersIn(text) {
  return typeof text === 'string' ? [...text.matchAll(PLACEHOLDER)].map((match) => match[1].toLowerCase()) : [];
}

export class FillRegistry {
  constructor({ providers, logger }) {
    this.providers = providers;
    this.logger = logger;
    // value → placeholder, for the scrub. Kept for the session.
    this.secrets = new Map();
  }

  static async load({ names, providersDir, providersConfigDir, logger }) {
    const providers = [];
    for (const name of names) {
      const dir = path.join(providersDir, name);
      const configFile = path.join(providersConfigDir, name, 'config.ini');
      const { default: Provider } = await import(pathToFileURL(path.join(dir, 'index.js')).href);
      providers.push(new Provider({ name, dir, configFile, config: readIni(configFile), logger }));
    }
    logger.info('fill_providers', { providers: names });
    return new FillRegistry({ providers, logger });
  }

  handles(tool) {
    return tool in FILL_ARGUMENTS;
  }

  // Replace the placeholders in the arguments of a call. Give the changed copy.
  async fill(tool, args, ctx) {
    if (!this.handles(tool)) return args;
    const copy = structuredClone(args ?? {});
    for (const item of FILL_ARGUMENTS[tool](copy)) {
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

  // Replace each value that the facade filled in with its placeholder, in each text of a result.
  scrub(result) {
    if (!this.secrets.size) return result;
    const values = [...this.secrets.keys()].sort((a, b) => b.length - a.length);
    const clean = (text) => values.reduce((out, value) => out.split(value).join(this.secrets.get(value)), text);
    const content = result.content?.map((part) => (part.type === 'text' ? { ...part, text: clean(part.text) } : part));
    const scrubbed = { ...result, content };
    if (result.structuredContent) scrubbed.structuredContent = JSON.parse(clean(JSON.stringify(result.structuredContent)));
    return scrubbed;
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
