// The host check of the server: the access of sites.json (see src/sites.js).
// onOpened(host, ctx): optional; runs for each opened page of an allowed host. The discovery mode
// records the hosts itself, at each page load (playwright/src/discover.js).
import { hostOfUrl } from './patterns.js';

export class HostPolicy {
  constructor({ sites, onOpened }) {
    this.sites = sites;
    this.onOpened = onOpened;
  }

  // Give { allowed: true } or { allowed: false, reason }. A URL without a host is allowed.
  async check(url) {
    const host = hostOfUrl(url);
    if (!host) return { allowed: true };
    const access = this.sites.access(host);
    return access.allowed ? { allowed: true, host } : { allowed: false, host, reason: access.reason };
  }

  // A page of the host opened. A denied host is never recorded.
  async opened(url, ctx) {
    const host = hostOfUrl(url);
    if (!host || !this.sites.access(host).allowed) return;
    await this.onOpened?.(host, { url, ...ctx });
  }
}
