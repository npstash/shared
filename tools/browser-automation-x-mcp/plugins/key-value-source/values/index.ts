// Key-value-source "values" (REQ-035 of sdd/SRS.md): fixed values from its config. For values that
// are not secret, e.g. a name. The case of a key has no effect. It has the same keys on each page.
//
//   "config": { "values": { "<key>": "<value>" } }
import type { KeyValueSource } from '../../../src/plugins/key-value-source.ts';
import type { PluginContext } from '../../../src/plugins/plugin.ts';

export default class ValuesSource implements KeyValueSource {
  // key in lowercase → value.
  private readonly entries: ReadonlyMap<string, string>;

  constructor(context: PluginContext) {
    const values = context.config.values ?? {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`the instance "${context.name}" needs "values" as an object`);
    this.entries = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  }

  async keys(): Promise<readonly string[]> {
    return [...this.entries.keys()];
  }

  async values(keys: readonly string[]): Promise<Readonly<Record<string, string>>> {
    const result: Record<string, string> = {};
    for (const key of keys) {
      const value = this.entries.get(key.toLowerCase());
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  async keysOf(value: string): Promise<readonly string[]> {
    return [...this.entries].filter(([, each]) => each === value).map(([key]) => key);
  }
}
