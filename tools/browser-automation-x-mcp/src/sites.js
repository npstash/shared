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
import { mtimeOf, readJson, writeJson } from './json.js';
import { getDomain } from 'tldts';
import { hostOfUrl, normalizeHost } from './hosts/patterns.js';

export const ACCESS = ['allow', 'deny'];

// True if the site host covers the host: the same host or a subdomain.
export function covers(siteHost, host) {
  const site = normalizeHost(siteHost);
  const h = normalizeHost(host);
  return h === site || h.endsWith(`.${site}`);
}

// The provider-config keys that each provider type needs (REQ-037 of sdd/SRS.md).
const PROVIDER_CONFIG_KEYS = { vault: ['vault', 'entry'] };

// The root domain of a host: the registrable domain of the Public Suffix List, also for private
// suffixes (e.g. user.github.io). An IP address or a host without a registrable domain stays.
export function rootDomain(host) {
  const h = normalizeHost(host);
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

export class Sites {
  constructor(file) {
    this.file = file;
    this.mtime = undefined;
    this.data = { defaultAccess: 'allow', sites: {} };
  }

  // Read the file again if it changed. Throw an error for an entry that is not valid.
  load() {
    const mtime = mtimeOf(this.file);
    if (mtime === this.mtime) return this.data;
    const data = readJson(this.file) ?? {};
    const defaultAccess = data.defaultAccess ?? 'allow';
    if (!ACCESS.includes(defaultAccess)) throw new Error(`${this.file}: defaultAccess must be "allow" or "deny"`);
    const sites = data.sites ?? {};
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

  // The nodes of the tree that cover the host, from the root domain to the most specific node:
  // [{ host, node }]. Empty if no site covers the host.
  chainOf(host) {
    return chainIn(this.load().sites, host);
  }

  // True if a site of sites.json covers the host.
  has(host) {
    return this.chainOf(host).length > 0;
  }

  // The access of a host: { allowed, reason }. A "deny" in the chain wins over each "allow" (also a
  // nearer one). Else the nearest node with an access decides, else defaultAccess.
  access(host) {
    const chain = this.chainOf(host).reverse();
    const denied = chain.find(({ node }) => node.access === 'deny');
    if (denied) return { allowed: false, reason: `the host ${host} is denied`, site: denied.host };
    const decided = chain.find(({ node }) => node.access);
    if (decided) return { allowed: true, site: decided.host };
    if (this.data.defaultAccess === 'allow') return { allowed: true };
    return { allowed: false, reason: `the host ${host} is not allowed` };
  }

  // The forms and login links for a URL, or undefined: { forms: [{ key, fields: [{ name, selector }],
  // submits }], logins }. name is the key of the value, in lowercase. The forms of the host come
  // first, then the forms of its parents; each node in file order. key identifies the form in the
  // log and in the loop guard of the server: "<node host> form <number>".
  match(url) {
    const host = hostOfUrl(url);
    if (!host) return undefined;
    const chain = this.chainOf(host).reverse();
    const forms = chain.flatMap(({ host: nodeHost, node }) => (node.forms ?? []).map((form, index) => ({
      key: `${nodeHost} form ${index + 1}`,
      fields: Object.entries(form.fields ?? {}).map(([selector, name]) => ({ name: String(name).toLowerCase(), selector })),
      submits: form.submit ?? [],
    }))).filter((form) => form.fields.length);
    const logins = [...new Set(chain.flatMap(({ node }) => node.login ?? []))];
    if (!forms.length && !logins.length) return undefined;
    return { forms, logins };
  }

  // The config of a provider type for a URL, or undefined: the nearest "provider-config" with this
  // type, from the host to its parents.
  providerConfig(url, type) {
    const host = hostOfUrl(url);
    if (!host) return undefined;
    return this.chainOf(host).reverse().find(({ node }) => node['provider-config']?.[type])?.node['provider-config'][type];
  }
}

// The nodes of the sites object of sites.json that cover the host, from the root domain to the
// most specific node: [{ host, node }]. Empty if no site covers the host.
export function chainIn(sites, host) {
  const h = normalizeHost(host);
  const root = rootDomain(h);
  const rootKey = Object.keys(sites).find((key) => normalizeHost(key) === root);
  if (rootKey === undefined) return [];
  const chain = [{ host: root, node: sites[rootKey] ?? {} }];
  for (;;) {
    const { node } = chain[chain.length - 1];
    const next = Object.entries(node.subdomains ?? {})
      .filter(([key]) => covers(key, h))
      .sort(([a], [b]) => b.length - a.length)[0];
    if (!next) return chain;
    chain.push({ host: normalizeHost(next[0]), node: next[1] ?? {} });
  }
}

// Check one node of the tree and its subdomains.
function checkNode(file, host, node) {
  const where = `${file}: the site "${host}"`;
  if (node.credentials !== undefined) throw new Error(`${where} has "credentials"; use "provider-config": { "vault": { "vault": "<vault>", "entry": "<system>" } }`);
  if (node.access !== undefined && !ACCESS.includes(node.access)) throw new Error(`${where}: access must be "allow" or "deny"`);
  checkProviderConfig(where, node['provider-config']);
  if (node.pages !== undefined) throw new Error(`${where} has "pages"; use "forms" and "login"`);
  if (node.forms !== undefined && !Array.isArray(node.forms)) throw new Error(`${where}: "forms" must be an array`);
  for (const [index, form] of (node.forms ?? []).entries()) {
    const at = `${where}, form ${index + 1}`;
    if (!form || typeof form !== 'object' || Array.isArray(form)) throw new Error(`${at} must be an object`);
    if (!form.fields || typeof form.fields !== 'object' || Array.isArray(form.fields)) throw new Error(`${at} needs "fields"`);
    if (form.submit !== undefined && !Array.isArray(form.submit)) throw new Error(`${at}: "submit" must be an array`);
    if (form['provider-config'] !== undefined) throw new Error(`${at} has "provider-config"; put it on the site`);
  }
  if (node.login !== undefined && !Array.isArray(node.login)) throw new Error(`${where}: "login" must be an array`);
  for (const [sub, child] of Object.entries(node.subdomains ?? {})) {
    if (normalizeHost(sub) === normalizeHost(host) || !covers(host, sub)) throw new Error(`${where}: "${sub}" in "subdomains" is not a subdomain of "${host}"`);
    checkNode(file, sub, child ?? {});
  }
}

function checkProviderConfig(where, config) {
  if (config === undefined) return;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${where}: "provider-config" must be an object`);
  for (const [type, settings] of Object.entries(config)) {
    if (!settings || typeof settings !== 'object') throw new Error(`${where}: "provider-config"."${type}" must be an object`);
    for (const key of PROVIDER_CONFIG_KEYS[type] ?? []) {
      if (typeof settings[key] !== 'string' || !settings[key]) throw new Error(`${where}: "provider-config"."${type}" needs "${key}"`);
    }
  }
}

// Change sites.json: read it again, give it to change(data), and write it in one step if change()
// gives a truthy value or a non-empty array. Entries that change() does not touch stay. Give the
// value of change(). The Sites object reads the file again at its next use (by the mtime).
export function updateSites(file, change) {
  const data = readJson(file) ?? {};
  data.sites ??= {};
  const result = change(data);
  if (Array.isArray(result) ? result.length : result) writeJson(file, data);
  return result;
}
