// The API of a key-value-source (REQ-031a of sdd/SRS.md): keys and values for a page.
import type { PageInfo, Plugin } from './plugin.ts';

export interface KeyValueSource extends Plugin {
  // The keys that this instance has for the page. Empty: the instance does not apply to the page.
  keys(page: PageInfo): Promise<readonly string[]>;
  // The values of the keys. A key without a value is missing in the result.
  values(keys: readonly string[], page: PageInfo): Promise<Readonly<Record<string, string>>>;
  // The keys whose value is equal to the value, in the order of the instance.
  keysOf(value: string, page: PageInfo): Promise<readonly string[]>;
}

// An error of a key-value-source or of an approval plugin: the server does not fill.
export class SourceError extends Error {}
