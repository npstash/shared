// API of a fill provider. A provider gives the values for the keys of sites.json, e.g. "password".
// To add a provider: make providers-form-fill/<type>/index.js (default export: a subclass of one of
// the classes below), then add { "type": "<type>", ... } to "providers" in server.json. The other
// keys of that entry are the settings of the provider.
//
// Kinds (REQ-031 of sdd/SRS.md):
//   value       FillProvider: gives a value for a key; it has no list of keys, e.g. ask.
//   key-value   KeyValueProvider: has keys and values; it also gives the key of a value (discovery).
//   approval    ApprovalProvider: is attached to one key-value provider (the "approval" of its entry)
//               and gets the approval of the user before that provider gives its values.
//
// ctx = { host, url, client, elicit }
//   host, url  the page that gets the value (host is undefined if the page has no host)
//   client     the client name of MCP initialize, or undefined
//   elicit     a function (message, requestedSchema, timeout) → result of the MCP elicitation, or
//              undefined if the client cannot show a form to the user

// Maximum time of one approval of an approval provider, in ms (APPROVAL_TIMEOUT of sdd/SRS.md).
export const APPROVAL_TIMEOUT = 15000;

export class FillProvider {
  static kind = 'value';

  // name: the type of the provider. settings: its entry in server.json. sites: the sites of
  // sites.json (src/sites.js).
  constructor({ name, dir, settings = {}, sites, logger }) {
    this.name = name;
    this.dir = dir;
    this.settings = settings;
    this.sites = sites;
    this.logger = logger;
  }

  get kind() {
    return this.constructor.kind;
  }

  // The value for the key, or undefined if this provider does not have it.
  // Throw a FillError to stop the fill, e.g. when the user declined.
  async resolve(key, ctx) {
    return undefined;
  }

  async dispose() {}
}

export class KeyValueProvider extends FillProvider {
  static kind = 'key-value';

  // True if the provider has a value for the key. It does not read the value if possible.
  async has(key, ctx) {
    return (await this.resolve(key, ctx)) !== undefined;
  }

  // The first key whose value is equal to the value, or undefined.
  async match(value, ctx) {
    return undefined;
  }
}

export class ApprovalProvider extends FillProvider {
  static kind = 'approval';

  // inner: the key-value provider that the approval is attached to.
  constructor(options) {
    super(options);
    this.inner = options.inner;
  }

  // The vault system of the page, from the wrapped provider (see FillRegistry.canLogIn).
  system(ctx) {
    return typeof this.inner.system === 'function' ? this.inner.system(ctx) : undefined;
  }

  // True if the user approves the fill of the keys on the host. Never give a value to the approver.
  async approve(request, ctx) {
    return false;
  }

  async resolve(key, ctx) {
    return this.inner.resolve(key, ctx);
  }

  async dispose() {
    await this.inner.dispose();
  }
}

export class FillError extends Error {}

// An approval provider refused the fill, or did not answer in APPROVAL_TIMEOUT.
export class ApprovalError extends FillError {}
