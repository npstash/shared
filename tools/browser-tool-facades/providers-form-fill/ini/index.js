// INI provider: values from providers-form-fill/ini/config.ini. For values that are not secret.
//   [all]            values for each host
//   [<host pattern>] values for matching hosts only, e.g. [*.example.com] (see src/hosts/patterns.js)
// The most specific section wins: an exact host, then a longer wildcard pattern, then [all].
import { sectionValues } from '../../src/ini.js';
import { FillProvider } from '../../src/fill/provider.js';
import { bySpecificity, hostMatches } from '../../src/hosts/patterns.js';

export default class IniProvider extends FillProvider {
  // The sections for the host, the most specific first, [all] last.
  sections(host) {
    const patterns = [...this.config.sections.keys()].filter((name) => name !== 'all');
    const matching = host ? patterns.filter((pattern) => hostMatches(pattern, host)).sort(bySpecificity) : [];
    return [...matching, 'all'].map((name) => lowerKeys(sectionValues(this.config, name)));
  }

  async list(ctx) {
    return [...new Set(this.sections(ctx.host).flatMap((values) => Object.keys(values)))].sort();
  }

  async resolve(name, ctx) {
    for (const values of this.sections(ctx.host)) {
      if (name in values) return values[name];
    }
    return undefined;
  }
}

function lowerKeys(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
}
