// Values provider (key-value): fixed values from "values" of its entry in server.json. For values
// that are not secret, e.g. a name. sites.json gives the pages and the fields for each value.
import type { FillContext, ProviderOptions } from '../../src/fill/provider.ts';
import { KeyValueProvider } from '../../src/fill/provider.ts';
import { isJsonObject } from '../../src/json.ts';

export default class ValuesProvider extends KeyValueProvider {
  // The values of the entry: key in lowercase → value.
  readonly values: Readonly<Record<string, string>>;

  constructor(options: ProviderOptions) {
    super(options);
    const values = isJsonObject(this.settings.values) ? this.settings.values : {};
    this.values = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  }

  override async has(key: string, _ctx?: FillContext): Promise<boolean> {
    return Object.hasOwn(this.values, String(key).toLowerCase());
  }

  async resolve(key: string, _ctx?: FillContext): Promise<string | undefined> {
    const name = String(key).toLowerCase();
    return Object.hasOwn(this.values, name) ? this.values[name] : undefined;
  }

  async match(value: string, _ctx?: FillContext): Promise<string | undefined> {
    return Object.keys(this.values).find((key) => this.values[key] === value);
  }
}
