// Values provider (key-value): fixed values from "values" of its entry in server.json. For values
// that are not secret, e.g. a name. sites.json gives the pages and the fields for each value.
import { KeyValueProvider } from '../../src/fill/provider.js';

export default class ValuesProvider extends KeyValueProvider {
  constructor(options) {
    super(options);
    this.values = Object.fromEntries(Object.entries(this.settings.values ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  }

  async has(key) {
    return Object.hasOwn(this.values, String(key).toLowerCase());
  }

  async resolve(key) {
    const name = String(key).toLowerCase();
    return Object.hasOwn(this.values, name) ? this.values[name] : undefined;
  }

  async match(value) {
    return Object.keys(this.values).find((key) => this.values[key] === value);
  }
}
