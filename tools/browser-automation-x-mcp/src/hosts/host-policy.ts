// The host check of the server: the access of sites.json (see src/sites.ts).
// onOpened(host, ctx): optional; runs for each opened page of an allowed host. The discovery mode
// records the hosts itself, at each page load (playwright/src/discover.ts).
import type { SiteTree } from '../sites.ts';
import { hostOfUrl } from './patterns.ts';

export interface HostCheck {
  readonly allowed: boolean;
  readonly host?: string;
  readonly reason?: string;
}

// The data of an opened page for onOpened.
export interface OpenedPage {
  readonly url: string;
  readonly tool?: string;
}

export type OnOpened = (host: string, page: OpenedPage) => Promise<void> | void;

// The access check of the hosts.
export interface HostPolicy {
  // Give { allowed: true } or { allowed: false, reason }. A URL without a host is allowed.
  check(url: string): Promise<HostCheck>;
  // A page of the host opened. A denied host is never recorded.
  opened(url: string, page?: Omit<OpenedPage, 'url'>): Promise<void>;
}

export interface SiteAccessPolicyOptions {
  readonly sites: SiteTree;
  readonly onOpened?: OnOpened;
}

export class SiteAccessPolicy implements HostPolicy {
  private readonly sites: SiteTree;
  private readonly onOpened: OnOpened | undefined;

  constructor({ sites, onOpened }: SiteAccessPolicyOptions) {
    this.sites = sites;
    this.onOpened = onOpened;
  }

  async check(url: string): Promise<HostCheck> {
    const host = hostOfUrl(url);
    if (!host) return { allowed: true };
    const access = this.sites.access(host);
    return access.allowed ? { allowed: true, host } : { allowed: false, host, reason: access.reason };
  }

  async opened(url: string, page: Omit<OpenedPage, 'url'> = {}): Promise<void> {
    const host = hostOfUrl(url);
    if (!host || !this.sites.access(host).allowed) return;
    await this.onOpened?.(host, { url, ...page });
  }
}
