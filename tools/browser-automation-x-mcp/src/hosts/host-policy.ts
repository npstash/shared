// The host check of the server: the access of hosts.json (see src/hosts.ts).
// onOpened(host, page): optional; runs for each opened page of an allowed host, e.g. to record it
// (REQ-042).
import type { HostTree } from '../hosts.ts';
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
  readonly hosts: HostTree;
  readonly onOpened?: OnOpened;
}

export class SiteAccessPolicy implements HostPolicy {
  private readonly hosts: HostTree;
  private readonly onOpened: OnOpened | undefined;

  constructor({ hosts, onOpened }: SiteAccessPolicyOptions) {
    this.hosts = hosts;
    this.onOpened = onOpened;
  }

  async check(url: string): Promise<HostCheck> {
    const host = hostOfUrl(url);
    if (!host) return { allowed: true };
    const access = this.hosts.access(host);
    return access.allowed ? { allowed: true, host } : { allowed: false, host, reason: access.reason };
  }

  async opened(url: string, page: Omit<OpenedPage, 'url'> = {}): Promise<void> {
    const host = hostOfUrl(url);
    if (!host || !this.hosts.access(host).allowed) return;
    await this.onOpened?.(host, { url, ...page });
  }
}
