// Values for form fields: the server asks the providers in the order of "providers" in server.json.
// The first provider that has the key gives the value. An approval provider gets one approval for
// all its keys of one fill (REQ-031, REQ-036c of sdd/SRS.md).
// The client never sees a value of a masked provider ("mask": true, the default): the server
// replaces it with MASK in each result and in each file that upstream wrote (scrub).
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isJsonObject } from '../json.ts';
import type { Logger } from '../logger.ts';
import type { ProviderEntry } from '../server-config.ts';
import type { SiteTree } from '../sites.ts';
import type { FillContext, ProviderClass } from './provider.ts';
import { ApprovalError, ApprovalProvider, FillProvider, KeyValueProvider, PROVIDER_KINDS } from './provider.ts';

export const MASK: string = '***';

export interface ResolveOptions {
  // The discovery mode: no value providers, and no approvals (REQ-031).
  readonly discovery?: boolean;
}

// The values of the form fill and the scrub of masked values.
export interface FillValues {
  // The values of the keys of one fill: a Map key → value. A key without a value is missing.
  // Throw a FillError when a provider fails or an approval is refused.
  resolveAll(keys: readonly string[], ctx: FillContext, options?: ResolveOptions): Promise<Map<string, string>>;
  // The value for one key, or undefined if no provider has it.
  resolve(key: string, ctx: FillContext, options?: ResolveOptions): Promise<string | undefined>;
  // The key of a value from the key-value providers, in their order (REQ-039a), or undefined.
  match(value: string, ctx: FillContext): Promise<string | undefined>;
  // True if a provider has a system for the page.
  canLogIn(ctx: FillContext): boolean;
  // Replace each masked value with MASK, in one text.
  clean(text: string): string;
  // Replace each masked value with MASK, in each text of a result.
  scrub(result: CallToolResult): CallToolResult;
  // The same for files that upstream wrote. Binary files stay.
  scrubFiles(files: readonly string[]): void;
  dispose(): Promise<void>;
}

export interface FillRegistryLoad {
  // The providers of server.json that are on.
  readonly entries: readonly ProviderEntry[];
  readonly providersDir: string;
  readonly sites: SiteTree;
  readonly logger: Logger;
}

export class FillRegistry implements FillValues {
  readonly providers: readonly FillProvider[];
  private readonly logger: Logger;
  // The values to replace, for the scrub. Kept for the session.
  readonly secrets: Set<string> = new Set();

  constructor({ providers, logger }: { providers: readonly FillProvider[]; logger: Logger }) {
    this.providers = providers;
    this.logger = logger;
  }

  static async load({ entries, providersDir, sites, logger }: FillRegistryLoad): Promise<FillRegistry> {
    const make = async (type: string, options: Record<string, unknown>): Promise<FillProvider> => {
      const dir = path.join(providersDir, type);
      const file = path.join(dir, 'index.ts');
      if (!fs.existsSync(file)) throw new Error(`the provider type "${type}" of server.json does not exist`);
      const module = await import(pathToFileURL(file).href) as { default: ProviderClass };
      const provider = new module.default({ name: type, dir, sites, logger, ...options } as never);
      if (!PROVIDER_KINDS.includes(provider.kind)) throw new Error(`the provider type "${type}" has no known kind`);
      return provider;
    };
    const providers: FillProvider[] = [];
    for (const { type, mask, settings } of entries) {
      let provider = await make(type, { settings });
      if (provider.kind === 'approval') throw new Error(`the provider "${type}" of server.json is an approval provider; attach it to a key-value provider with "approval"`);
      const approval = settings.approval;
      if (approval !== undefined) {
        if (!(provider instanceof KeyValueProvider)) throw new Error(`the provider "${type}" of server.json is not a key-value provider; remove "approval"`);
        if (!isJsonObject(approval) || typeof approval.type !== 'string' || !approval.type) throw new Error(`the provider "${type}" of server.json needs "approval" with a "type"`);
        // "enabled": false in "approval" turns the approval off: the provider fills without approval.
        if (approval.enabled !== false) {
          const approver = await make(approval.type, { settings: approval, inner: provider });
          if (!(approver instanceof ApprovalProvider)) throw new Error(`"approval" of the provider "${type}" of server.json: "${approval.type}" is not an approval provider`);
          provider = approver;
        }
      }
      provider.masked = mask;
      providers.push(provider);
    }
    logger.info('fill_providers', {
      providers: providers.map((p) => (p instanceof ApprovalProvider ? `${p.name}(${p.inner.name})` : p.name)),
      masked: providers.filter((p) => p.masked).map((p) => p.name),
    });
    return new FillRegistry({ providers, logger });
  }

  // The key-value provider of a provider for the discovery and the match: itself, or the wrapped one.
  static keyValue(provider: FillProvider): KeyValueProvider | undefined {
    if (provider instanceof ApprovalProvider) return provider.inner;
    return provider instanceof KeyValueProvider ? provider : undefined;
  }

  async resolveAll(keys: readonly string[], ctx: FillContext, { discovery = false }: ResolveOptions = {}): Promise<Map<string, string>> {
    const values = new Map<string, string>();
    const approvals = new Map<ApprovalProvider, string[]>();
    for (const key of keys) {
      for (const provider of this.providers) {
        if (discovery && provider.kind === 'value') continue;
        if (provider instanceof ApprovalProvider) {
          if (!await provider.inner.has(key, ctx)) continue;
          if (discovery) {
            this.add(values, key, await provider.inner.resolve(key, ctx), provider, ctx);
          } else {
            const list = approvals.get(provider) ?? [];
            list.push(key);
            approvals.set(provider, list);
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

  private add(values: Map<string, string>, key: string, value: string | undefined, provider: FillProvider, ctx: FillContext): void {
    if (value === undefined) return;
    this.logger.info('fill_value', { field: key, provider: provider.name, host: ctx.host });
    if (value && provider.masked) this.secrets.add(value);
    values.set(key, value);
  }

  async resolve(key: string, ctx: FillContext, options?: ResolveOptions): Promise<string | undefined> {
    return (await this.resolveAll([key], ctx, options)).get(key);
  }

  // A value of a masked provider goes into the scrub.
  async match(value: string, ctx: FillContext): Promise<string | undefined> {
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

  // The vault provider has a system when sites.json has a "provider-config" for the page.
  canLogIn(ctx: FillContext): boolean {
    return this.providers.some((provider) => Boolean(provider.system(ctx)));
  }

  clean(text: string): string {
    const values = [...this.secrets].sort((a, b) => b.length - a.length);
    return values.reduce((out, value) => out.split(value).join(MASK), text);
  }

  scrub(result: CallToolResult): CallToolResult {
    if (!this.secrets.size) return result;
    const content = result.content?.map((part) => (part.type === 'text' ? { ...part, text: this.clean(part.text) } : part));
    const scrubbed: CallToolResult = { ...result, content };
    if (result.structuredContent) scrubbed.structuredContent = JSON.parse(this.clean(JSON.stringify(result.structuredContent))) as Record<string, unknown>;
    return scrubbed;
  }

  scrubFiles(files: readonly string[]): void {
    if (!this.secrets.size) return;
    for (const file of files) {
      let text: string;
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

  async dispose(): Promise<void> {
    await Promise.allSettled(this.providers.map((provider) => provider.dispose()));
  }
}
