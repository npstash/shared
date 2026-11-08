// sites.json in the config folder: what the server knows about sites. Only the discovery mode
// writes it (updateSites(), REQ-039a of sdd/SRS.md).
//
//   {
//     "defaultAccess": "allow" | "deny",            access of a host without a site
//     "sites": {
//       "<root domain>": {                           e.g. amazon.pl; see rootDomain()
//         "access": "allow" | "deny",                optional; inherited by the subdomains
//         "provider-config": {                       optional; inherited by the subdomains
//           "<provider type>": { ... },              e.g. "vault": { "vault": "vault-main", "entry": "<system>" }
//         },
//         "forms": [                                 optional; also for the subdomains
//           {
//             "fields": { "<selector>": "<key>" },   form fields; the key of a provider value
//             "submit": ["<selector>" | "enter"]     optional; the first visible, or Enter
//           }
//         ],
//         "login": ["<selector>"],                   optional; login links; also for the subdomains
//         "subdomains": {
//           "<subdomain>": { ... }                   e.g. www.amazon.pl; the same keys as a site
//         }
//       }
//     }
//   }
//
// A form applies on each page of the host where one of its fields is visible: no path selects it.
// The nearest value wins: the host, then its parent domains. For "provider-config", this applies
// to each provider type separately. A "deny" of a parent wins over an "allow" below it.
// A selector is CSS, or a label or role locator of Playwright.
import type { JsonObject } from './json.ts';
import { isJsonObject, mtimeOf, readJson, writeJson } from './json.ts';
import { getDomain } from 'tldts';
import { hostOfUrl, normalizeHost } from './hosts/patterns.ts';

export type Access = 'allow' | 'deny';
export const ACCESS: readonly Access[] = ['allow', 'deny'];

// One form of a node.
export interface FormEntry {
  fields?: Record<string, string>;
  submit?: string[];
  [key: string]: unknown;
}

// One node of the tree: a root domain or a subdomain.
export interface SiteNode {
  access?: Access;
  'provider-config'?: Record<string, JsonObject>;
  forms?: FormEntry[];
  login?: string[];
  subdomains?: Record<string, SiteNode>;
  [key: string]: unknown;
}

// The content of sites.json.
export interface SitesData {
  defaultAccess: Access;
  sites: Record<string, SiteNode>;
}

// The content of sites.json for a change: the file as it is.
export interface SitesFileData {
  defaultAccess?: Access;
  sites: Record<string, SiteNode>;
  [key: string]: unknown;
}

// One node of the chain of a host.
export interface ChainLink {
  readonly host: string;
  readonly node: SiteNode;
}

export interface AccessResult {
  readonly allowed: boolean;
  readonly reason?: string;
  // The node that decided.
  readonly site?: string;
}

// One field of a form: the key of its value (in lowercase) and its selector.
export interface FormField {
  readonly name: string;
  readonly selector: string;
}

// One form for a URL. key identifies the form in the log and in the loop guard of the server:
// "<node host> form <number>".
export interface FormMatch {
  readonly key: string;
  readonly fields: readonly FormField[];
  readonly submits: readonly string[];
}

// The forms and the login links for a URL.
export interface PageMatch {
  readonly forms: readonly FormMatch[];
  readonly logins: readonly string[];
}

// The tree of sites.json.
export interface SiteTree {
  readonly file: string;
  // The nodes of the tree that cover the host, from the root domain to the most specific node.
  // Empty if no site covers the host.
  chainOf(host: string): ChainLink[];
  // True if a site of sites.json covers the host.
  has(host: string): boolean;
  // The access of a host.
  access(host: string): AccessResult;
  // The forms and login links for a URL, or undefined.
  match(url: string): PageMatch | undefined;
  // The config of a provider type for a URL, or undefined.
  providerConfig(url: string, type: string): JsonObject | undefined;
}

// True if the site host covers the host: the same host or a subdomain.
export function covers(siteHost: string, host: string): boolean {
  const site = normalizeHost(siteHost);
  const h = normalizeHost(host);
  return h === site || h.endsWith(`.${site}`);
}

// The provider-config keys that each provider type needs (REQ-037 of sdd/SRS.md).
const PROVIDER_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = { vault: ['vault', 'entry'] };

// The root domain of a host: the registrable domain of the Public Suffix List, also for private
// suffixes (e.g. user.github.io). An IP address or a host without a registrable domain stays.
export function rootDomain(host: string): string {
  const h = normalizeHost(host);
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

function isAccess(value: unknown): value is Access {
  return value === 'allow' || value === 'deny';
}

export class Sites implements SiteTree {
  readonly file: string;
  private mtime: number | undefined = undefined;
  private data: SitesData = { defaultAccess: 'allow', sites: {} };

  constructor(file: string) {
    this.file = file;
  }

  // Read the file again if it changed. Throw an error for an entry that is not valid.
  load(): SitesData {
    const mtime = mtimeOf(this.file);
    if (mtime === this.mtime) return this.data;
    const raw = readJson(this.file) ?? {};
    if (!isJsonObject(raw)) throw new Error(`${this.file}: the file must have a JSON object`);
    const defaultAccess = raw.defaultAccess ?? 'allow';
    if (!isAccess(defaultAccess)) throw new Error(`${this.file}: defaultAccess must be "allow" or "deny"`);
    const sites = (isJsonObject(raw.sites) ? raw.sites : {}) as Record<string, SiteNode>;
    for (const [host, node] of Object.entries(sites)) {
      if (rootDomain(host) !== normalizeHost(host)) {
        throw new Error(`${this.file}: the site "${host}" is not a root domain; put it into "subdomains" of "${rootDomain(host)}"`);
      }
      checkNode(this.file, host, node ?? {});
    }
    this.data = { defaultAccess, sites };
    this.mtime = mtime;
    return this.data;
  }

  chainOf(host: string): ChainLink[] {
    return chainIn(this.load().sites, host);
  }

  has(host: string): boolean {
    return this.chainOf(host).length > 0;
  }

  // A "deny" in the chain wins over each "allow" (also a nearer one). Else the nearest node with an
  // access decides, else defaultAccess.
  access(host: string): AccessResult {
    const chain = this.chainOf(host).reverse();
    const denied = chain.find(({ node }) => node.access === 'deny');
    if (denied) return { allowed: false, reason: `the host ${host} is denied`, site: denied.host };
    const decided = chain.find(({ node }) => node.access);
    if (decided) return { allowed: true, site: decided.host };
    if (this.data.defaultAccess === 'allow') return { allowed: true };
    return { allowed: false, reason: `the host ${host} is not allowed` };
  }

  // The forms of the host come first, then the forms of its parents; each node in file order.
  match(url: string): PageMatch | undefined {
    const host = hostOfUrl(url);
    if (!host) return undefined;
    const chain = this.chainOf(host).reverse();
    const forms = chain.flatMap(({ host: nodeHost, node }) => (node.forms ?? []).map((form, index): FormMatch => ({
      key: `${nodeHost} form ${index + 1}`,
      fields: Object.entries(form.fields ?? {}).map(([selector, name]) => ({ name: String(name).toLowerCase(), selector })),
      submits: form.submit ?? [],
    }))).filter((form) => form.fields.length);
    const logins = [...new Set(chain.flatMap(({ node }) => node.login ?? []))];
    if (!forms.length && !logins.length) return undefined;
    return { forms, logins };
  }

  // The nearest "provider-config" with this type, from the host to its parents.
  providerConfig(url: string, type: string): JsonObject | undefined {
    const host = hostOfUrl(url);
    if (!host) return undefined;
    return this.chainOf(host).reverse().find(({ node }) => node['provider-config']?.[type])?.node['provider-config']?.[type];
  }
}

// The nodes of the sites object of sites.json that cover the host, from the root domain to the
// most specific node. Empty if no site covers the host.
export function chainIn(sites: Record<string, SiteNode>, host: string): ChainLink[] {
  const h = normalizeHost(host);
  const root = rootDomain(h);
  const rootKey = Object.keys(sites).find((key) => normalizeHost(key) === root);
  if (rootKey === undefined) return [];
  const chain: ChainLink[] = [{ host: root, node: sites[rootKey] ?? {} }];
  for (;;) {
    const last = chain.at(-1);
    if (!last) return chain;
    const { node } = last;
    const next = Object.entries(node.subdomains ?? {})
      .filter(([key]) => covers(key, h))
      .sort(([a], [b]) => b.length - a.length)[0];
    if (!next) return chain;
    chain.push({ host: normalizeHost(next[0]), node: next[1] ?? {} });
  }
}

// Check one node of the tree and its subdomains.
function checkNode(file: string, host: string, node: SiteNode): void {
  const where = `${file}: the site "${host}"`;
  if (node.credentials !== undefined) throw new Error(`${where} has "credentials"; use "provider-config": { "vault": { "vault": "<vault>", "entry": "<system>" } }`);
  if (node.access !== undefined && !ACCESS.includes(node.access)) throw new Error(`${where}: access must be "allow" or "deny"`);
  checkProviderConfig(where, node['provider-config']);
  if (node.pages !== undefined) throw new Error(`${where} has "pages"; use "forms" and "login"`);
  if (node.forms !== undefined && !Array.isArray(node.forms)) throw new Error(`${where}: "forms" must be an array`);
  for (const [index, form] of (node.forms ?? []).entries()) {
    const at = `${where}, form ${index + 1}`;
    if (!isJsonObject(form)) throw new Error(`${at} must be an object`);
    if (!isJsonObject(form.fields)) throw new Error(`${at} needs "fields"`);
    if (form.submit !== undefined && !Array.isArray(form.submit)) throw new Error(`${at}: "submit" must be an array`);
    if (form['provider-config'] !== undefined) throw new Error(`${at} has "provider-config"; put it on the site`);
  }
  if (node.login !== undefined && !Array.isArray(node.login)) throw new Error(`${where}: "login" must be an array`);
  for (const [sub, child] of Object.entries(node.subdomains ?? {})) {
    if (normalizeHost(sub) === normalizeHost(host) || !covers(host, sub)) throw new Error(`${where}: "${sub}" in "subdomains" is not a subdomain of "${host}"`);
    checkNode(file, sub, child ?? {});
  }
}

function checkProviderConfig(where: string, config: unknown): void {
  if (config === undefined) return;
  if (!isJsonObject(config)) throw new Error(`${where}: "provider-config" must be an object`);
  for (const [type, settings] of Object.entries(config)) {
    if (!settings || typeof settings !== 'object') throw new Error(`${where}: "provider-config"."${type}" must be an object`);
    const values = settings as JsonObject;
    for (const key of PROVIDER_CONFIG_KEYS[type] ?? []) {
      if (typeof values[key] !== 'string' || !values[key]) throw new Error(`${where}: "provider-config"."${type}" needs "${key}"`);
    }
  }
}

// Change sites.json: read it again, give it to change(data), and write it in one step if change()
// gives a truthy value or a non-empty array. Entries that change() does not touch stay. Give the
// value of change(). The Sites object reads the file again at its next use (by the mtime).
export function updateSites<T>(file: string, change: (data: SitesFileData) => T): T {
  const raw = readJson(file) ?? {};
  const data = (isJsonObject(raw) ? raw : {}) as SitesFileData;
  data.sites ??= {};
  const result = change(data);
  if (Array.isArray(result) ? result.length : result) writeJson(file, data);
  return result;
}
