// The form fields of fields.ini in the config folder: which field gets which value on which page.
//   [<URL pattern>]
//   <value name> = <CSS selector>
//   submit = <selector>              optional, also more than one: the server clicks the first
//                                    visible one, in file order
// A URL pattern is "host/path". The host part is a host pattern (see src/hosts/patterns.js).
// In the path, "*" is each sequence of characters, also "/". A pattern without a path matches each
// path. Scheme, port, query and fragment have no effect.
import { readIni } from '../ini.js';
import { hostMatches, hostOfUrl } from '../hosts/patterns.js';

export const SUBMIT_KEY = 'submit';

// A path segment that is an ID: only digits, a UUID, or more than 16 characters of hex or
// base64url with a digit and a letter.
const ID_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]{17,}$/,
];

export function urlMatches(pattern, url) {
  const host = hostOfUrl(url);
  if (!host) return false;
  const slash = pattern.indexOf('/');
  const hostPattern = slash < 0 ? pattern : pattern.slice(0, slash);
  if (!hostMatches(hostPattern, host)) return false;
  if (slash < 0) return true;
  const pathPattern = pattern.slice(slash);
  const regex = new RegExp(`^${pathPattern.split('*').map(escapeRegExp).join('.*')}$`);
  return regex.test(new URL(url).pathname);
}

// The URL pattern of a page for fields.ini: host and path, each ID segment replaced with "*".
export function urlPattern(url) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').map((segment) => (ID_SEGMENT.some((re) => re.test(segment)) ? '*' : segment));
  return `${parsed.hostname.toLowerCase()}${segments.join('/')}`;
}

export class FieldsConfig {
  constructor(file) {
    this.file = file;
    this.sections = [...readIni(file).sections].map(([pattern, lines]) => ({
      pattern,
      lines: lines.filter((line) => line.value),
    }));
  }

  // The fields for a URL, or undefined: { key, fields: [{ name, selector }], submits: [selector] }.
  // All matching sections apply. For a name in more sections, the longer pattern wins.
  // submits: the submit lines of the longest pattern first, each section in file order.
  // key: the matching patterns; it identifies the form for the loop guard of the server.
  match(url) {
    const matching = this.sections.filter(({ pattern }) => urlMatches(pattern, url))
      .sort((a, b) => a.pattern.length - b.pattern.length);
    if (!matching.length) return undefined;
    const values = new Map();
    for (const { lines } of matching) {
      for (const { key, value } of lines) {
        if (key.toLowerCase() !== SUBMIT_KEY) values.set(key.toLowerCase(), value);
      }
    }
    if (!values.size) return undefined;
    const submits = [...matching].reverse()
      .flatMap(({ lines }) => lines.filter(({ key }) => key.toLowerCase() === SUBMIT_KEY).map(({ value }) => value));
    return {
      key: matching.map(({ pattern }) => pattern).join(' '),
      fields: [...values].map(([name, selector]) => ({ name, selector })),
      submits: [...new Set(submits)],
    };
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
