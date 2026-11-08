// Hosts of pages and of hosts.json. A host has no scheme, port or path. Case does not matter.

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');
}

// The host of a URL, or undefined for a page without a host (about:, data:, blob:, chrome:).
export function hostOfUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:', 'ws:', 'wss:', 'ftp:'].includes(parsed.protocol)) return undefined;
  return parsed.hostname ? normalizeHost(parsed.hostname) : undefined;
}
