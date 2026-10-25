// Host patterns of the deny-list and the allow-list (config/hosts.ini) and of the ini provider.
//   *              each host
//   *.example.com  the subdomains of example.com, not example.com itself
//   example.com    only this host
//   192.168.1.*    IPv4 addresses; "*" replaces one octet
// A pattern is a host only: no scheme, port or path. Case does not matter.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV4_PATTERN = /^(\d{1,3}|\*)(\.(\d{1,3}|\*)){3}$/;

export function normalizeHost(host) {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');
}

export function hostMatches(pattern, host) {
  const p = normalizeHost(pattern);
  const h = normalizeHost(host);
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  if (IPV4_PATTERN.test(p) && p.includes('*')) {
    if (!IPV4.test(h)) return false;
    const want = p.split('.');
    return h.split('.').every((octet, i) => want[i] === '*' || want[i] === octet);
  }
  return p === h;
}

// The first pattern that matches the host, or undefined.
export function firstMatch(patterns, host) {
  return patterns.find((pattern) => hostMatches(pattern, host));
}

// Sort patterns from the most specific to the least specific:
// an exact host, then wildcard patterns with a longer text first, then "*".
export function bySpecificity(a, b) {
  const rank = (p) => (p === '*' ? 2 : p.includes('*') ? 1 : 0);
  return rank(a) - rank(b) || b.length - a.length;
}

// The host of a URL, or undefined for a page without a host (about:, data:, blob:, chrome:).
export function hostOfUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:', 'ws:', 'wss:', 'ftp:'].includes(parsed.protocol)) return undefined;
  return parsed.hostname ? normalizeHost(parsed.hostname) : undefined;
}
