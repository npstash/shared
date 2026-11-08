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
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { JsonObject } from './json.ts';
import { isJsonObject, mtimeOf, readJson, writeJson } from './json.ts';
import type { Logger } from './logger.ts';

// One provider of server.json that is on.
export interface ProviderEntry {
  readonly type: string;
  readonly mask: boolean;
  // The entry of server.json: the settings of the provider.
  readonly settings: JsonObject;
}

// The switch of one tool in server.json.
export type ToolEntry = JsonObject & { enabled?: unknown };

// The content of server.json.
export interface ServerConfigData {
  readonly providers: readonly unknown[];
  readonly tools: Readonly<Record<string, ToolEntry | undefined>>;
  readonly [key: string]: unknown;
}

// The config of the server: server.json.
export interface ServerConfig {
  readonly file: string;
  // The content of the file, read again if it changed.
  data(): ServerConfigData;
  // The providers that are on, in the order of the file.
  providers(): ProviderEntry[];
  // Write the tools: the other keys of the file stay.
  writeTools(tools: Record<string, ToolEntry>): void;
}

// The tool switches of server.json.
export interface ToolSwitches {
  // Add each tool that the file does not list, with its default. The tools stay sorted.
  addMissing(names: readonly string[]): void;
  isEnabled(name: string): boolean;
  // The tool as the client sees it: a disabled tool gets a note in its description.
  describe(tool: Tool): Tool;
  // The error result of a call of a disabled tool.
  disabledResult(name: string): CallToolResult;
}

export class ServerConfigFile implements ServerConfig {
  readonly file: string;
  private mtime: number | undefined = undefined;
  private content: ServerConfigData = { providers: [], tools: {} };

  constructor(file: string) {
    this.file = file;
  }

  data(): ServerConfigData {
    this.load();
    return this.content;
  }

  // Read the file again if it changed. Give true if it changed.
  load(): boolean {
    const mtime = mtimeOf(this.file);
    if (mtime === this.mtime) return false;
    const raw = readJson(this.file) ?? {};
    if (!isJsonObject(raw)) throw new Error(`${this.file}: the file must have a JSON object`);
    if (raw.providers !== undefined && !Array.isArray(raw.providers)) throw new Error(`${this.file}: "providers" must be an array`);
    const tools = isJsonObject(raw.tools) ? raw.tools as Record<string, ToolEntry> : {};
    this.content = { ...raw, providers: raw.providers ?? [], tools };
    this.mtime = mtime;
    return true;
  }

  providers(): ProviderEntry[] {
    return this.data().providers
      .filter((entry): entry is JsonObject => isJsonObject(entry) && entry.enabled !== false)
      .map((entry) => {
        if (typeof entry.type !== 'string' || !entry.type) throw new Error(`${this.file}: each provider needs a "type"`);
        return { type: entry.type, mask: entry.mask !== false, settings: entry };
      });
  }

  writeTools(tools: Record<string, ToolEntry>): void {
    const raw = readJson(this.file) ?? {};
    writeJson(this.file, { ...(isJsonObject(raw) ? raw : {}), tools });
    this.mtime = undefined;
    this.load();
  }
}

// The tool switches of server.json. A disabled tool stays in the tool list, but a call to it fails
// with the reason.
export class ToolsConfig implements ToolSwitches {
  private readonly config: ServerConfig;
  private readonly logger: Logger;
  private readonly dangerous: Readonly<Record<string, string>>;

  // dangerous: { <tool>: reason } — tools that a web page can misuse through prompt injection.
  // They are disabled by default.
  constructor(serverConfig: ServerConfig, logger: Logger, dangerous: Readonly<Record<string, string>> = {}) {
    this.config = serverConfig;
    this.logger = logger;
    this.dangerous = dangerous;
  }

  private states(): Map<string, boolean> {
    const states = new Map<string, boolean>();
    for (const [name, value] of Object.entries(this.config.data().tools)) {
      if (typeof value?.enabled !== 'boolean') this.logger.error('tools_config_invalid', { tool: name, value, file: this.config.file });
      // A value that is not true disables the tool: the safe side.
      states.set(name, value?.enabled === true);
    }
    return states;
  }

  addMissing(names: readonly string[]): void {
    const states = this.states();
    const missing = names.filter((name) => !states.has(name));
    if (!missing.length) return;
    for (const name of missing) states.set(name, !(name in this.dangerous));
    const current = this.config.data().tools;
    const tools = Object.fromEntries([...states.keys()].sort().map((name): [string, ToolEntry] => [name, { ...current[name], enabled: states.get(name) ?? false }]));
    this.config.writeTools(tools);
    this.logger.info('tools_config_added', { tools: missing, file: this.config.file });
  }

  isEnabled(name: string): boolean {
    return this.states().get(name) !== false;
  }

  // The text for the client. It does not name upstream or the config file.
  private reason(name: string): string {
    const why = this.dangerous[name] ? ` Reason: ${this.dangerous[name]}.` : '';
    return `this tool is turned off in the configuration.${why}`;
  }

  describe(tool: Tool): Tool {
    if (this.isEnabled(tool.name)) return tool;
    return { ...tool, description: `DISABLED: ${this.reason(tool.name)} ${tool.description ?? ''}`.trim() };
  }

  disabledResult(name: string): CallToolResult {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `### Error\nThe tool ${name} did not run: ${this.reason(name)}`,
      }],
    };
  }
}
