// INI provider: values from [values] of provider-ini.ini in the config folder. For values that are
// not secret. fields.ini gives the pages and the fields for each value.
import { sectionValues } from '../../src/ini.js';
import { FillProvider } from '../../src/fill/provider.js';

export default class IniProvider extends FillProvider {
  constructor(options) {
    super(options);
    this.values = Object.fromEntries(Object.entries(sectionValues(this.config, 'values')).map(([key, value]) => [key.toLowerCase(), value]));
  }

  async resolve(name) {
    return Object.hasOwn(this.values, name) ? this.values[name] : undefined;
  }
}
