// Match-strategy "propagate" (REQ-039d of sdd/SRS.md): the key of a field is its hint, if a
// key-value-source has this key for the page. The case has no effect.
//
//   "config": {}
import type { FieldMatch, FieldToMatch, MatchStrategy } from '../../../src/plugins/match-strategy.ts';

export default class Propagate implements MatchStrategy {
  async match(fields: readonly FieldToMatch[], keys: readonly string[]): Promise<readonly FieldMatch[]> {
    const matches: FieldMatch[] = [];
    for (const { ref, hint } of fields) {
      const key = keys.find((each) => each.toLowerCase() === hint.toLowerCase());
      if (key !== undefined) matches.push({ ref, key });
    }
    return matches;
  }
}
