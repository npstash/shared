// server.json in the config folder: how the server works.
//
//   {
//     "providers": [                               the fill providers, in the order that the server asks them
//       { "type": "vault",  "enabled": true, "mask": true,  "vault": "vault-<name>" },
//       { "type": "values", "enabled": true, "mask": false, "values": { "<name>": "<value>" } },
//       { "type": "ask",    "enabled": true, "mask": true,  "fields": ["<name>"] },
//       { "type": "vault", "enabled": true, "mask": true, "vault": "vault-<name>",
//         "approval": { "type": "approve-https", "address": "https://<host>:<port>", "fingerprint": "<SHA-256>" } }
//     ],
//     "tools": { "<tool>": { "enabled": true } }   the tool switches; the server adds missing tools
//   }
//
// "enabled": false turns a provider or a tool off. A provider without "mask" is masked: its values
// show as *** to the agent. The other keys of a provider are its settings (see providers-form-fill/).
// An approval provider (approve-dialog, approve-https) is the "approval" of a key-value provider; the
// mask of that entry applies. "enabled": false in "approval" turns the approval off (REQ-031 of
// sdd/SRS.md).
import { mtimeOf, readJson, writeJson } from './json.js';

export class ServerConfig {
  constructor(file, logger) {
    this.file = file;
    this.logger = logger;
    this.mtime = undefined;
    this.data = { providers: [], tools: {} };
  }

  // Read the file again if it changed. Give true if it changed.
  load() {
    const mtime = mtimeOf(this.file);
    if (mtime === this.mtime) return false;
    const data = readJson(this.file) ?? {};
    if (data.providers !== undefined && !Array.isArray(data.providers)) throw new Error(`${this.file}: "providers" must be an array`);
    this.data = { ...data, providers: data.providers ?? [], tools: data.tools ?? {} };
    this.mtime = mtime;
    return true;
  }

  // The providers that are on: { type, mask, settings }, in the order of the file.
  providers() {
    this.load();
    return this.data.providers
      .filter((entry) => entry && entry.enabled !== false)
      .map((entry) => {
        if (!entry.type) throw new Error(`${this.file}: each provider needs a "type"`);
        return { type: entry.type, mask: entry.mask !== false, settings: entry };
      });
  }

  // Write the tools: the other keys of the file stay.
  writeTools(tools) {
    const data = readJson(this.file) ?? {};
    writeJson(this.file, { ...data, tools });
    this.mtime = undefined;
    this.load();
  }
}

// The tool switches of server.json. A disabled tool stays in the tool list, but a call to it fails
// with the reason.
export class ToolsConfig {
  // dangerous: { <tool>: reason } — tools that a web page can misuse through prompt injection.
  // They are disabled by default.
  constructor(serverConfig, logger, dangerous = {}) {
    this.config = serverConfig;
    this.logger = logger;
    this.dangerous = dangerous;
  }

  states() {
    this.config.load();
    const states = new Map();
    for (const [name, value] of Object.entries(this.config.data.tools)) {
      if (typeof value?.enabled !== 'boolean') this.logger.error('tools_config_invalid', { tool: name, value, file: this.config.file });
      // A value that is not true disables the tool: the safe side.
      states.set(name, value?.enabled === true);
    }
    return states;
  }

  // Add each tool that the file does not list, with its default. The tools stay sorted.
  addMissing(names) {
    const states = this.states();
    const missing = names.filter((name) => !states.has(name));
    if (!missing.length) return;
    for (const name of missing) states.set(name, !(name in this.dangerous));
    const tools = Object.fromEntries([...states.keys()].sort().map((name) => [name, { ...this.config.data.tools[name], enabled: states.get(name) }]));
    this.config.writeTools(tools);
    this.logger.info('tools_config_added', { tools: missing, file: this.config.file });
  }

  isEnabled(name) {
    return this.states().get(name) !== false;
  }

  // The text for the client. It does not name upstream or the config file.
  reason(name) {
    const why = this.dangerous[name] ? ` Reason: ${this.dangerous[name]}.` : '';
    return `this tool is turned off in the configuration.${why}`;
  }

  // The tool as the client sees it: a disabled tool gets a note in its description.
  describe(tool) {
    if (this.isEnabled(tool.name)) return tool;
    return { ...tool, description: `DISABLED: ${this.reason(tool.name)} ${tool.description ?? ''}`.trim() };
  }

  disabledResult(name) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `### Error\nThe tool ${name} did not run: ${this.reason(name)}`,
      }],
    };
  }
}
