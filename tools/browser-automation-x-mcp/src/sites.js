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
//         "pages": {                                 only for this host, not for the subdomains
//           "<path pattern>": {                      "*" in the path is each sequence of characters
//             "fields": { "<selector>": "<key>" },   form fields; the key of a provider value
//             "submit": ["<selector>" | "enter"],    optional; the first visible, or Enter
//             "login":  ["<selector>"],              optional; the login links of the page
//             "provider-config": { ... }             optional; only for this page
//           }
//         },
//         "subdomains": {
//           "<subdomain>": { ... }                   e.g. www.amazon.pl; the same keys as a site
//         }
//       }
//     }
//   }
//
// The nearest value wins: the page, then the host, then its parent domains. For "provider-config",
// this applies to each provider type separately. A "deny" of a parent wins over an "allow" below it.
// A selector is CSS, or a label or role locator of Playwright.
import { mtimeOf, readJson, writeJson } from './json.js';
import { getDomain } from 'tldts';
import { hostOfUrl, normalizeHost } from './hosts/patterns.js';

export const ACCESS = ['allow', 'deny'];

// A path segment that is an ID: only digits, a UUID, or more than 16 characters of hex or
// base64url with a digit and a letter.
const ID_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]{17,}$/,
];

// True if the site host covers the host: the same host or a subdomain.
export function covers(siteHost, host) {
  const site = normalizeHost(siteHost);
  const h = normalizeHost(host);
  return h === site || h.endsWith(`.${site}`);
}

// True if the path pattern matches the path of a URL.
export function pathMatches(pattern, pathname) {
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return regex.test(pathname);
}

// The host and the path pattern of a page: each ID segment of the path becomes "*".
export function pageOf(url) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').map((segment) => (ID_SEGMENT.some((re) => re.test(segment)) ? '*' : segment));
  return { host: parsed.hostname.toLowerCase(), path: segments.join('/') };
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
    const { sites } = this.load();
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

  // The pages of the node of the exact host that match a URL, the most specific (longest path) first.
  pagesOf(url) {
    const host = hostOfUrl(url);
    if (!host) return [];
    const exact = this.chainOf(host).at(-1);
    if (!exact || exact.host !== host) return [];
    const { pathname } = new URL(url);
    return Object.entries(exact.node.pages ?? {})
      .filter(([pattern]) => pathMatches(pattern, pathname))
      .map(([pattern, page]) => ({ key: `${host}${pattern}`, page: page ?? {} }))
      .sort((a, b) => b.key.length - a.key.length);
  }

  // The form of a URL, or undefined: { key, fields: [{ name, selector }], submits, logins }.
  // name is the key of the value, in lowercase. All matching pages apply. For a selector in more
  // pages, the more specific page wins.
  // submits and logins: the more specific page first, each page in file order.
  // key: the matching pages; it identifies the form for the loop guard of the server.
  match(url) {
    const pages = this.pagesOf(url);
    if (!pages.length) return undefined;
    const fields = new Map();
    for (const { page } of [...pages].reverse()) {
      for (const [selector, name] of Object.entries(page.fields ?? {})) fields.set(selector, String(name).toLowerCase());
    }
    const list = (key) => [...new Set(pages.flatMap(({ page }) => page[key] ?? []))];
    const logins = list('login');
    if (!fields.size && !logins.length) return undefined;
    return {
      key: pages.map(({ key }) => key).reverse().join(' '),
      fields: [...fields].map(([selector, name]) => ({ name, selector })),
      submits: list('submit'),
      logins,
    };
  }

  // The config of a provider type for a URL, or undefined: the nearest "provider-config" with this
  // type. The order: the matching pages (the most specific first), then the host, then its parents.
  providerConfig(url, type) {
    const host = hostOfUrl(url);
    if (!host) return undefined;
    const page = this.pagesOf(url).find(({ page: p }) => p['provider-config']?.[type]);
    if (page) return page.page['provider-config'][type];
    return this.chainOf(host).reverse().find(({ node }) => node['provider-config']?.[type])?.node['provider-config'][type];
  }
}

// Check one node of the tree and its subdomains.
function checkNode(file, host, node) {
  const where = `${file}: the site "${host}"`;
  if (node.credentials !== undefined) throw new Error(`${where} has "credentials"; use "provider-config": { "vault": { "vault": "<vault>", "entry": "<system>" } }`);
  if (node.access !== undefined && !ACCESS.includes(node.access)) throw new Error(`${where}: access must be "allow" or "deny"`);
  checkProviderConfig(where, node['provider-config']);
  for (const [pattern, page] of Object.entries(node.pages ?? {})) {
    const at = `${where}, page "${pattern}"`;
    if (page?.credentials !== undefined) throw new Error(`${at} has "credentials"; use "provider-config"`);
    checkProviderConfig(at, page?.['provider-config']);
  }
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
