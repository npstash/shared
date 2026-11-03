// API of a fill provider. A provider gives the values for the field names of fields.ini, e.g. "password".
// To add a provider: make providers-form-fill/<name>/index.js (default export: a FillProvider subclass)
// and providers-form-fill/<name>/config.template.ini, then add <name> to "[fill] providers" in server.ini.
// The config of the provider is provider-<name>.ini in the config folder (see src/paths.js).
//
// ctx = { host, url, elicit }
//   host, url  the page that gets the value (host is undefined if the page has no host)
//   elicit     a function (message, requestedSchema) → result of the MCP elicitation, or
//              undefined if the client cannot show a form to the user

export class FillProvider {
  // dir: the folder of the provider; config: its parsed provider-<name>.ini (see src/ini.js).
  constructor({ name, dir, configFile, config, logger }) {
    this.name = name;
    this.dir = dir;
    this.configFile = configFile;
    this.config = config;
    this.logger = logger;
  }

  // The value for the field name, or undefined if this provider does not have it.
  // Throw a FillError to stop the fill, e.g. when the user declined.
  async resolve(name, ctx) {
    return undefined;
  }

  async dispose() {}
}

export class FillError extends Error {}
