// hosts.json in the config folder: the access of the hosts (REQ-037, REQ-040 of sdd/SRS.md).
//
//   {
//     "defaultAccess": "allow" | "deny",            access of a host without a node
//     "hosts": {
//       "<root domain>": {                           e.g. amazon.pl; see rootDomain()
//         "access": "allow" | "deny",                optional; inherited by the subdomains
//         "subdomains": {
//           "<subdomain>": { ... }                   e.g. www.amazon.pl; the same keys
//         }
//       }
//     }
//   }
//
// The nearest access wins: the host, then its parent domains. A "deny" of a parent wins over an
// "allow" below it. The server writes the file only to record an opened host (REQ-042).
import { getDomain } from 'tldts';
import { normalizeHost } from './hosts/patterns.ts';
import { isJsonObject, mtimeOf, readJson, writeJson } from './json.ts';

export type Access = 'allow' | 'deny';
export const ACCESS: readonly Access[] = ['allow', 'deny'];

// One node of the tree: a root domain or a subdomain.
export interface HostNode {
  access?: Access;
  subdomains?: Record<string, HostNode>;
}

// The content of hosts.json.
export interface HostsData {
  defaultAccess: Access;
  hosts: Record<string, HostNode>;
}

// One node of the chain of a host.
export interface ChainLink {
  readonly host: string;
  readonly node: HostNode;
}

export interface AccessResult {
  readonly allowed: boolean;
  readonly reason?: string;
  // The node that decided.
  readonly site?: string;
}

// The tree of hosts.json.
export interface HostTree {
  readonly file: string;
  // The nodes of the tree that cover the host, from the root domain to the most specific node.
  // Empty if no node covers the host.
  chainOf(host: string): ChainLink[];
  // True if a node of hosts.json covers the host.
  has(host: string): boolean;
  // The access of a host.
  access(host: string): AccessResult;
  // Record the root domain of an allowed host with "access": "allow" (REQ-042). An access that the
  // file has stays. Give true if the file changed.
  record(host: string): boolean;
}

// True if the node host covers the host: the same host or a subdomain.
export function covers(nodeHost: string, host: string): boolean {
  const node = normalizeHost(nodeHost);
  const h = normalizeHost(host);
  return h === node || h.endsWith(`.${node}`);
}

// The root domain of a host: the registrable domain of the Public Suffix List, also for private
// suffixes (e.g. user.github.io). An IP address or a host without a registrable domain stays.
export function rootDomain(host: string): string {
  const h = normalizeHost(host);
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

// The host, then its parent domains, to the root domain (for PageInfo.hosts of the plugins).
export function hostChain(host: string | undefined): string[] {
  if (!host) return [];
  const h = normalizeHost(host);
  const root = rootDomain(h);
  const chain = [h];
  let current = h;
  while (current !== root && current.endsWith(`.${root}`)) {
    current = current.slice(current.indexOf('.') + 1);
    chain.push(current);
  }
  return chain;
}

function isAccess(value: unknown): value is Access {
  return value === 'allow' || value === 'deny';
}

export class HostsFile implements HostTree {
  readonly file: string;
  private mtime: number | undefined = undefined;
  private data: HostsData = { defaultAccess: 'allow', hosts: {} };

  constructor(file: string) {
    this.file = file;
  }

  // Read the file again if it changed. Throw an error for an entry that is not valid.
  load(): HostsData {
    const mtime = mtimeOf(this.file);
    if (mtime === this.mtime) return this.data;
    const raw = readJson(this.file) ?? {};
    if (!isJsonObject(raw)) throw new Error(`${this.file}: the file must have a JSON object`);
    for (const key of Object.keys(raw)) {
      if (key !== 'defaultAccess' && key !== 'hosts') throw new Error(`${this.file}: "${key}" is not known; the file has only "defaultAccess" and "hosts"`);
    }
    const defaultAccess = raw.defaultAccess ?? 'allow';
    if (!isAccess(defaultAccess)) throw new Error(`${this.file}: defaultAccess must be "allow" or "deny"`);
    const hosts = (isJsonObject(raw.hosts) ? raw.hosts : {}) as Record<string, HostNode>;
    for (const [host, node] of Object.entries(hosts)) {
      if (rootDomain(host) !== normalizeHost(host)) {
        throw new Error(`${this.file}: the host "${host}" is not a root domain; put it into "subdomains" of "${rootDomain(host)}"`);
      }
      checkNode(this.file, host, node ?? {});
    }
    this.data = { defaultAccess, hosts };
    this.mtime = mtime;
    return this.data;
  }

  chainOf(host: string): ChainLink[] {
    return chainIn(this.load().hosts, host);
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

  record(host: string): boolean {
    if (!this.access(host).allowed) return false;
    // The root domain gets the access; the subdomains inherit it (REQ-037).
    const root = rootDomain(host);
    const raw = readJson(this.file) ?? {};
    const data = (isJsonObject(raw) ? raw : {}) as Partial<HostsData>;
    const hosts = data.hosts ??= {};
    const node = hosts[root] ??= {};
    if (node.access) return false;
    node.access = 'allow';
    writeJson(this.file, data);
    return true;
  }
}

// The nodes of a tree that cover the host, from the root domain to the most specific node.
// Empty if no node covers the host.
export function chainIn(hosts: Record<string, HostNode>, host: string): ChainLink[] {
  const h = normalizeHost(host);
  const root = rootDomain(h);
  const rootKey = Object.keys(hosts).find((key) => normalizeHost(key) === root);
  if (rootKey === undefined) return [];
  const chain: ChainLink[] = [{ host: root, node: hosts[rootKey] ?? {} }];
  for (;;) {
    const last = chain.at(-1);
    if (!last) return chain;
    const next = Object.entries(last.node.subdomains ?? {})
      .filter(([key]) => covers(key, h))
      .sort(([a], [b]) => b.length - a.length)[0];
    if (!next) return chain;
    chain.push({ host: normalizeHost(next[0]), node: next[1] ?? {} });
  }
}

// Check one node of the tree and its subdomains.
function checkNode(file: string, host: string, node: HostNode): void {
  const where = `${file}: the host "${host}"`;
  for (const key of Object.keys(node)) {
    if (key !== 'access' && key !== 'subdomains') throw new Error(`${where} has "${key}"; a node has only "access" and "subdomains"`);
  }
  if (node.access !== undefined && !ACCESS.includes(node.access)) throw new Error(`${where}: access must be "allow" or "deny"`);
  for (const [sub, child] of Object.entries(node.subdomains ?? {})) {
    if (normalizeHost(sub) === normalizeHost(host) || !covers(host, sub)) throw new Error(`${where}: "${sub}" in "subdomains" is not a subdomain of "${host}"`);
    checkNode(file, sub, child ?? {});
  }
}
