// API of a fill provider. A provider gives the values for placeholders such as {{email}}.
// To add a provider: make providers-form-fill/<name>/index.js (default export: a FillProvider subclass)
// and providers-form-fill/<name>/config.ini, then add <name> to "[fill] providers" in config/facade.ini.
//
// ctx = { host, url, tool, field, elicit }
//   host, url  the page that gets the value (host is undefined if the page has no host)
//   tool       the tool that types the value, e.g. browser_fill_form
//   field      the human-readable field name that the agent gave, if any
//   elicit     a function (message, requestedSchema) → result of the MCP elicitation, or
//              undefined if the client cannot show a form to the user

export class FillProvider {
  // dir: the folder of the provider; config: its parsed config.ini (see src/ini.js).
  constructor({ name, dir, configFile, config, logger }) {
    this.name = name;
    this.dir = dir;
    this.configFile = configFile;
    this.config = config;
    this.logger = logger;
  }

  // Placeholder names that this provider can fill for ctx. Never values.
  async list(ctx) {
    return [];
  }

  // The value for the placeholder name, or undefined if this provider does not have it.
  // Throw a FillError to stop the call, e.g. when the user declined.
  async resolve(name, ctx) {
    return undefined;
  }

  async dispose() {}
}

export class FillError extends Error {}
