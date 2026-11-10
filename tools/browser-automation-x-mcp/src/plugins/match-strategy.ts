// The API of a match-strategy (REQ-031c of sdd/SRS.md): it pairs the hint of a field with a key.
import type { PageInfo, Plugin } from './plugin.ts';

// A field without a key.
export interface FieldToMatch {
  // An id from the server, for one round.
  readonly ref: string;
  readonly hint: string;
}

// The key of one field.
export interface FieldMatch {
  // The ref of a FieldToMatch.
  readonly ref: string;
  // A key of a key-value-source for the page.
  readonly key: string;
}

export interface MatchStrategy extends Plugin {
  // keys: the keys of all key-value-source instances for the page.
  // The result has a FieldMatch only for the fields that the strategy matched.
  match(fields: readonly FieldToMatch[], keys: readonly string[], page: PageInfo): Promise<readonly FieldMatch[]>;
}
