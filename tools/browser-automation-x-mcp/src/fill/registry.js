// Values for form fields: the server asks the providers in the order of "providers" in server.json.
// The first provider that has the key gives the value. An approval provider gets one approval for
// all its keys of one fill (REQ-031, REQ-036c of sdd/SRS.md).
// The client never sees a value of a masked provider ("mask": true, the default): the server
// replaces it with MASK in each result and in each file that upstream wrote (scrub).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApprovalError, FillError } from './provider.js';

export const MASK = '***';

const KINDS = ['value', 'key-value', 'approval'];

export class FillRegistry {
  // providers: the provider objects, each with "masked" (true or false).
  constructor({ providers, logger }) {
    this.providers = providers;
    this.logger = logger;
    // The values to replace, for the scrub. Kept for the session.
    this.secrets = new Set();
  }

  // entries: the providers of server.json that are on, as ServerConfig.providers() gives them.
  static async load({ entries, providersDir, sites, logger }) {
    const make = async (type, settings, extra = {}) => {
      const dir = path.join(providersDir, type);
      if (!fs.existsSync(path.join(dir, 'index.js'))) throw new Error(`the provider type "${type}" of server.json does not exist`);
      const { default: Provider } = await import(pathToFileURL(path.join(dir, 'index.js')).href);
      const provider = new Provider({ name: type, dir, settings, sites, logger, ...extra });
      if (!KINDS.includes(provider.kind)) throw new Error(`the provider type "${type}" has no known kind`);
      return provider;
    };
    const providers = [];
    for (const { type, mask, settings } of entries) {
      let provider = await make(type, settings);
      if (provider.kind === 'approval') throw new Error(`the provider "${type}" of server.json is an approval provider; attach it to a key-value provider with "approval"`);
      const approval = settings.approval;
      if (approval !== undefined) {
        if (provider.kind !== 'key-value') throw new Error(`the provider "${type}" of server.json is not a key-value provider; remove "approval"`);
        if (!approval || typeof approval !== 'object' || !approval.type) throw new Error(`the provider "${type}" of server.json needs "approval" with a "type"`);
        // "enabled": false in "approval" turns the approval off: the provider fills without approval.
        if (approval.enabled !== false) {
          const approver = await make(approval.type, approval, { inner: provider });
          if (approver.kind !== 'approval') throw new Error(`"approval" of the provider "${type}" of server.json: "${approval.type}" is not an approval provider`);
          provider = approver;
        }
      }
      provider.masked = mask;
      providers.push(provider);
    }
    logger.info('fill_providers', {
      providers: providers.map((p) => (p.inner ? `${p.name}(${p.inner.name})` : p.name)),
      masked: providers.filter((p) => p.masked).map((p) => p.name),
    });
    return new FillRegistry({ providers, logger });
  }

  // The key-value provider of a provider for the discovery and the match: itself, or the wrapped one.
  static keyValue(provider) {
    if (provider.kind === 'approval') return provider.inner;
    return provider.kind === 'key-value' ? provider : undefined;
  }

  // The values of the keys of one fill: a Map key → value. A key without a value is missing.
  // discovery: no value providers, and no approvals (REQ-031).
  // Throw a FillError when a provider fails or an approval is refused.
  async resolveAll(keys, ctx, { discovery = false } = {}) {
    const values = new Map();
    const approvals = new Map();
    for (const key of keys) {
      for (const provider of this.providers) {
        if (discovery && provider.kind === 'value') continue;
        if (provider.kind === 'approval') {
          if (!await provider.inner.has(key, ctx)) continue;
          if (discovery) {
            this.add(values, key, await provider.inner.resolve(key, ctx), provider, ctx);
          } else {
            if (!approvals.has(provider)) approvals.set(provider, []);
            approvals.get(provider).push(key);
          }
          break;
        }
        const value = await provider.resolve(key, ctx);
        if (value === undefined) continue;
        this.add(values, key, value, provider, ctx);
        break;
      }
    }
    for (const [provider, approvalKeys] of approvals) {
      const request = { host: ctx.host, keys: approvalKeys, client: ctx.client };
      const approved = await provider.approve(request, ctx);
      this.logger.info(approved ? 'fill_approved' : 'fill_refused', { provider: provider.name, host: ctx.host, keys: approvalKeys });
      if (!approved) throw new ApprovalError(`the fill of ${approvalKeys.join(', ')} was not approved`);
      for (const key of approvalKeys) this.add(values, key, await provider.inner.resolve(key, ctx), provider, ctx);
    }
    return values;
  }

  add(values, key, value, provider, ctx) {
    if (value === undefined) return;
    this.logger.info('fill_value', { field: key, provider: provider.name, host: ctx.host });
    if (value && provider.masked) this.secrets.add(value);
    values.set(key, value);
  }

  // The value for one key, or undefined if no provider has it.
  async resolve(key, ctx, options) {
    return (await this.resolveAll([key], ctx, options)).get(key);
  }

  // The key of a value from the key-value providers, in their order (REQ-039a), or undefined.
  // A value of a masked provider goes into the scrub.
  async match(value, ctx) {
    if (!value) return undefined;
    for (const provider of this.providers) {
      const keyValue = FillRegistry.keyValue(provider);
      if (!keyValue) continue;
      const key = await keyValue.match(value, ctx);
      if (key === undefined) continue;
      if (provider.masked) this.secrets.add(value);
      return key;
    }
    return undefined;
  }

  // True if a provider has a system for the page (the vault provider: "provider-config" in sites.json).
  canLogIn(ctx) {
    return this.providers.some((provider) => typeof provider.system === 'function' && Boolean(provider.system(ctx)));
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
