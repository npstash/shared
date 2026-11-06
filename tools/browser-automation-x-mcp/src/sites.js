// sites.json in the config folder: what the server knows about sites. Only the discovery mode
// writes it (updateSites(), REQ-039a of sdd/SRS.md).
//
//   {
//     "defaultAccess": "allow" | "deny",          access of a host without a site
//     "sites": {
//       "<host>": {                                 the host and all its subdomains
//         "access": "allow" | "deny",              optional; without it, defaultAccess
//         "credentials": { "vault": "<system>" },  optional; the vault system of the site
//         "pages": {
//           "<path pattern>": {                     "*" in the path is each sequence of characters
//             "fields": { "<selector>": "<key>" },  form fields; the key of a provider value
//             "submit": ["<selector>" | "enter"],   optional; the first visible, or Enter
//             "login":  ["<selector>"],             optional; the login links of the page
//             "credentials": { "vault": "<system>" } optional; overrides the site
//           }
//         }
//       }
//     }
//   }
//
// A selector is CSS, or a label or role locator of Playwright.
import { mtimeOf, readJson, writeJson } from './json.js';
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

export class Sites {
  constructor(file) {
    this.file = file;
    this.mtime = undefined;
    this.data = { defaultAccess: 'allow', sites: {} };
  }

  // Read the file again if it changed.
  load() {
    const mtime = mtimeOf(this.file);
    if (mtime === this.mtime) return this.data;
    const data = readJson(this.file) ?? {};
    const defaultAccess = data.defaultAccess ?? 'allow';
    if (!ACCESS.includes(defaultAccess)) throw new Error(`${this.file}: defaultAccess must be "allow" or "deny"`);
    this.data = { defaultAccess, sites: data.sites ?? {} };
    this.mtime = mtime;
    return this.data;
  }

  // The sites that cover the host, the most specific (longest host) first.
  sitesOf(host) {
    const { sites } = this.load();
    return Object.entries(sites)
      .filter(([siteHost]) => covers(siteHost, host))
      .sort(([a], [b]) => b.length - a.length)
      .map(([siteHost, site]) => ({ host: siteHost, site: site ?? {} }));
  }

  // True if a site of sites.json covers the host.
  has(host) {
    return this.sitesOf(host).length > 0;
  }

  // The access of a host: { allowed, reason }. A site with "deny" wins over each other site. Else the
  // most specific site with an access decides, else defaultAccess.
  access(host) {
    const matching = this.sitesOf(host);
    const denied = matching.find(({ site }) => site.access === 'deny');
    if (denied) return { allowed: false, reason: `the host ${host} is denied`, site: denied.host };
    const decided = matching.find(({ site }) => site.access);
    if (decided) return { allowed: true, site: decided.host };
    if (this.data.defaultAccess === 'allow') return { allowed: true };
    return { allowed: false, reason: `the host ${host} is not allowed` };
  }

  // The pages of the sites that match a URL, the most specific (longest host and path) first.
  pagesOf(url) {
    const host = hostOfUrl(url);
    if (!host) return [];
    const { pathname } = new URL(url);
    return this.sitesOf(host).flatMap(({ host: siteHost, site }) => Object.entries(site.pages ?? {})
      .filter(([pattern]) => pathMatches(pattern, pathname))
      .map(([pattern, page]) => ({ key: `${siteHost}${pattern}`, page: page ?? {} })))
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

  // The vault system of a URL: of the most specific page with credentials, else of the most specific
  // site with credentials, else undefined.
  vaultSystem(url) {
    const page = this.pagesOf(url).find(({ page: p }) => p.credentials?.vault);
    if (page) return page.page.credentials.vault;
    const host = hostOfUrl(url);
    return host ? this.sitesOf(host).find(({ site }) => site.credentials?.vault)?.site.credentials.vault : undefined;
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
