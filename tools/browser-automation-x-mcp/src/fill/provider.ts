// API of a fill provider. A provider gives the values for the keys of sites.json, e.g. "password".
// To add a provider: make providers-form-fill/<type>/index.ts (default export: a subclass of one of
// the classes below), then add { "type": "<type>", ... } to "providers" in server.json. The other
// keys of that entry are the settings of the provider.
//
// Kinds (REQ-031 of sdd/SRS.md):
//   value       FillProvider: gives a value for a key; it has no list of keys, e.g. ask.
//   key-value   KeyValueProvider: has keys and values; it also gives the key of a value (discovery).
//   approval    ApprovalProvider: is attached to one key-value provider (the "approval" of its entry)
//               and gets the approval of the user before that provider gives its values.
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { JsonObject } from '../json.ts';
import type { Logger } from '../logger.ts';
import type { SiteTree } from '../sites.ts';

// Maximum time of one approval of an approval provider, in ms (APPROVAL_TIMEOUT of sdd/SRS.md).
export const APPROVAL_TIMEOUT: number = 15000;

export type ProviderKind = 'value' | 'key-value' | 'approval';
export const PROVIDER_KINDS: readonly ProviderKind[] = ['value', 'key-value', 'approval'];

// The form of a dialog of the client (MCP elicitation).
export type ElicitSchema = ElicitRequestFormParams['requestedSchema'];

// Show a dialog of the client. Give the result of the MCP elicitation.
export type Elicit = (message: string, requestedSchema: ElicitSchema, timeout?: number) => Promise<ElicitResult>;

// The page that gets the value.
export interface FillContext {
  // The host of the page, or undefined if the page has no host.
  readonly host?: string | undefined;
  readonly url?: string | undefined;
  // The client name of MCP initialize, or undefined.
  readonly client?: string | undefined;
  // A dialog of the client, or undefined if the client cannot show a form to the user.
  readonly elicit?: Elicit | undefined;
}

// The request of one approval: no value and no URL.
export interface ApprovalRequest {
  readonly host: string | undefined;
  readonly keys: readonly string[];
  readonly client: string | undefined;
}

export interface ProviderOptions {
  // The type of the provider.
  readonly name: string;
  // The folder of the provider.
  readonly dir?: string;
  // The entry in server.json.
  readonly settings?: JsonObject;
  // The sites of sites.json.
  readonly sites?: SiteTree;
  readonly logger?: Logger;
}

export interface ApprovalProviderOptions extends ProviderOptions {
  // The key-value provider that the approval is attached to.
  readonly inner: KeyValueProvider;
}

// A value provider: gives a value for a key.
export abstract class FillProvider {
  readonly name: string;
  readonly dir: string;
  readonly settings: JsonObject;
  readonly sites: SiteTree | undefined;
  readonly logger: Logger | undefined;
  // True if the values of the provider are masked for the client (set by the fill registry).
  masked: boolean = true;

  constructor({ name, dir = '', settings = {}, sites, logger }: ProviderOptions) {
    this.name = name;
    this.dir = dir;
    this.settings = settings;
    this.sites = sites;
    this.logger = logger;
  }

  abstract get kind(): ProviderKind;

  // The value for the key, or undefined if this provider does not have it.
  // Throw a FillError to stop the fill, e.g. when the user declined.
  abstract resolve(key: string, ctx: FillContext): Promise<string | undefined>;

  // The vault system of the page, if the provider has one (see FillRegistry.canLogIn).
  system(_ctx: FillContext): string | undefined {
    return undefined;
  }

  async dispose(): Promise<void> {}
}

// A key-value provider: has keys and values.
export abstract class KeyValueProvider extends FillProvider {
  get kind(): ProviderKind {
    return 'key-value';
  }

  // True if the provider has a value for the key. It does not read the value if possible.
  async has(key: string, ctx: FillContext): Promise<boolean> {
    return (await this.resolve(key, ctx)) !== undefined;
  }

  // The first key whose value is equal to the value, or undefined.
  abstract match(value: string, ctx: FillContext): Promise<string | undefined>;
}

// An approval provider: approves the fill of the keys of its key-value provider.
export abstract class ApprovalProvider extends FillProvider {
  readonly inner: KeyValueProvider;

  constructor(options: ApprovalProviderOptions) {
    super(options);
    this.inner = options.inner;
  }

  get kind(): ProviderKind {
    return 'approval';
  }

  override system(ctx: FillContext): string | undefined {
    return this.inner.system(ctx);
  }

  // True if the user approves the fill of the keys on the host. Never give a value to the approver.
  abstract approve(request: ApprovalRequest, ctx: FillContext): Promise<boolean>;

  async resolve(key: string, ctx: FillContext): Promise<string | undefined> {
    return this.inner.resolve(key, ctx);
  }

  override async dispose(): Promise<void> {
    await this.inner.dispose();
  }
}

// The class of a provider type: the default export of providers-form-fill/<type>/index.ts.
export type ProviderClass = new (options: ProviderOptions | ApprovalProviderOptions) => FillProvider;

export class FillError extends Error {}

// An approval provider refused the fill, or did not answer in APPROVAL_TIMEOUT.
export class ApprovalError extends FillError {}
