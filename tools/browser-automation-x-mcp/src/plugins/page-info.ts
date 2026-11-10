// The PageInfo of a URL for the plugins.
import { hostChain } from '../hosts.ts';
import { hostOfUrl } from '../hosts/patterns.ts';
import type { PageInfo } from './plugin.ts';

export function pageInfo(url: string): PageInfo {
  const host = hostOfUrl(url);
  return { url, host, hosts: hostChain(host) };
}
