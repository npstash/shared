// The host check of the facade: the deny-list first, then the allow provider.
import { firstMatch, hostOfUrl } from './patterns.js';

export class HostPolicy {
  constructor({ hostsFile, allowProvider }) {
    this.hostsFile = hostsFile;
    this.allowProvider = allowProvider;
  }

  // Give { allowed: true } or { allowed: false, reason }. A URL without a host is allowed.
  async check(url, ctx) {
    const host = hostOfUrl(url);
    if (!host) return { allowed: true };
    this.hostsFile.load();
    const denied = firstMatch(this.hostsFile.deny, host);
    if (denied) return { allowed: false, host, reason: `the host ${host} matches "${denied}" in [deny] of ${this.hostsFile.file}` };
    if (!(await this.allowProvider.isAllowed(host, { url, ...ctx }))) {
      return { allowed: false, host, reason: `the host ${host} is not in [allow] of ${this.hostsFile.file}` };
    }
    return { allowed: true, host };
  }

  // A page of the host opened. A denied host is never recorded.
  async opened(url, ctx) {
    const host = hostOfUrl(url);
    if (!host) return;
    this.hostsFile.load();
    if (firstMatch(this.hostsFile.deny, host)) return;
    await this.allowProvider.recordOpened(host, { url, ...ctx });
  }
}
