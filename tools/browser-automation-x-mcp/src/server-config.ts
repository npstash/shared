// server.json in the config folder: how the server works (REQ-019, REQ-031 of sdd/SRS.md).
//
//   {
//     "recordHosts": false,                         record the opened hosts in hosts.json (REQ-042)
//     "plugins": {                                  the plugin instances of each category, in order
//       "key-value-source": [
//         { "name": "vault-main", "plugin": "vault", "description": "...", "enabled": true, "mask": true,
//           "config": { "vault": "vault-main", "file": "vault-main.json" },
//           "approval": { "plugin": "approve-dialog", "enabled": true, "config": {} } }
//       ],
//       "dom-classifier": [ { "name": "...", "plugin": "...", "description": "...", "enabled": true, "config": {} } ],
//       "match-strategy": [ ... ],
//       "page-script": [ ... ]
//     },
//     "tools": { "<tool>": { "enabled": true } }   the tool switches; the server adds missing tools
//   }
//
// "enabled": false turns an instance, an approval or a tool off. A key-value-source without "mask"
// is masked: its values show as *** to the agent.
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { JsonObject } from './json.ts';
import { isJsonObject, mtimeOf, readJson, writeJson } from './json.ts';
import type { Logger } from './logger.ts';
import type { Category } from './plugins/plugin.ts';
import { INSTANCE_CATEGORIES } from './plugins/plugin.ts';

// One plugin instance of server.json.
export interface InstanceEntry {
  readonly name: string;
  readonly plugin: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly config: JsonObject;
}

// The approval of a key-value-source instance.
export interface ApprovalEntry {
  readonly plugin: string;
  readonly enabled: boolean;
  readonly config: JsonObject;
}

// One key-value-source instance.
export interface SourceEntry extends InstanceEntry {
  readonly mask: boolean;
  readonly approval: ApprovalEntry | undefined;
}

// The plugin instances of server.json, by category, in the order of the file.
export interface PluginEntries {
  readonly 'key-value-source': readonly SourceEntry[];
  readonly 'dom-classifier': readonly InstanceEntry[];
  readonly 'match-strategy': readonly InstanceEntry[];
  readonly 'page-script': readonly InstanceEntry[];
}

// The switch of one tool in server.json.
export type ToolEntry = JsonObject & { enabled?: unknown };

// The content of server.json.
export interface ServerConfigData {
  readonly recordHosts: boolean;
  readonly plugins: PluginEntries;
  readonly tools: Readonly<Record<string, ToolEntry | undefined>>;
}

// The config of the server: server.json.
export interface ServerConfig {
  readonly file: string;
  // The content of the file, read again if it changed.
  data(): ServerConfigData;
  // The plugin instances, by category (REQ-031).
  plugins(): PluginEntries;
  // True if the server records the opened hosts (RECORD_HOSTS, REQ-042).
  recordHosts(): boolean;
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
  private content: ServerConfigData = { recordHosts: false, plugins: emptyPlugins(), tools: {} };

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
    if (raw.providers !== undefined) throw new Error(`${this.file}: "providers" is removed; use "plugins"`);
    if (raw.recordHosts !== undefined && typeof raw.recordHosts !== 'boolean') throw new Error(`${this.file}: "recordHosts" must be true or false`);
    const tools = isJsonObject(raw.tools) ? raw.tools as Record<string, ToolEntry> : {};
    this.content = { recordHosts: raw.recordHosts === true, plugins: parsePlugins(this.file, raw.plugins), tools };
    this.mtime = mtime;
    return true;
  }

  plugins(): PluginEntries {
    return this.data().plugins;
  }

  recordHosts(): boolean {
    return this.data().recordHosts;
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

function emptyPlugins(): PluginEntries {
  return { 'key-value-source': [], 'dom-classifier': [], 'match-strategy': [], 'page-script': [] };
}

// Read "plugins" of server.json. Throw an error for an entry that is not valid (REQ-031).
export function parsePlugins(file: string, raw: unknown): PluginEntries {
  if (raw === undefined) return emptyPlugins();
  if (!isJsonObject(raw)) throw new Error(`${file}: "plugins" must be an object with one array for each category`);
  for (const key of Object.keys(raw)) {
    if (!(INSTANCE_CATEGORIES as readonly string[]).includes(key)) throw new Error(`${file}: "plugins" has the unknown category "${key}"`);
  }
  const names = new Set<string>();
  const list = (category: Category): JsonObject[] => {
    const value = raw[category] ?? [];
    if (!Array.isArray(value)) throw new Error(`${file}: "plugins"."${category}" must be an array`);
    return value.map((entry, index) => {
      if (!isJsonObject(entry)) throw new Error(`${file}: "plugins"."${category}"[${index}] must be an object`);
      return entry;
    });
  };
  const instance = (category: Category, entry: JsonObject): InstanceEntry => {
    const where = `${file}: an instance of "${category}"`;
    for (const key of ['name', 'plugin', 'description'] as const) {
      if (typeof entry[key] !== 'string' || !entry[key]) throw new Error(`${where} needs "${key}"`);
    }
    const name = String(entry.name);
    if (names.has(name)) throw new Error(`${file}: two instances have the name "${name}"`);
    names.add(name);
    if (!isJsonObject(entry.config)) throw new Error(`${where} ("${name}") needs "config"`);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error(`${where} ("${name}"): "enabled" must be true or false`);
    return { name, plugin: String(entry.plugin), description: String(entry.description), enabled: entry.enabled !== false, config: entry.config };
  };
  const approval = (owner: string, value: unknown): ApprovalEntry | undefined => {
    if (value === undefined) return undefined;
    const where = `${file}: "approval" of "${owner}"`;
    if (!isJsonObject(value) || typeof value.plugin !== 'string' || !value.plugin) throw new Error(`${where} needs "plugin"`);
    if (value.config !== undefined && !isJsonObject(value.config)) throw new Error(`${where}: "config" must be an object`);
    return { plugin: value.plugin, enabled: value.enabled !== false, config: isJsonObject(value.config) ? value.config : {} };
  };
  const sources = list('key-value-source').map((entry): SourceEntry => {
    const base = instance('key-value-source', entry);
    return { ...base, mask: entry.mask !== false, approval: approval(base.name, entry.approval) };
  });
  const plain = (category: Category): InstanceEntry[] => list(category).map((entry) => {
    const base = instance(category, entry);
    if (entry.approval !== undefined) throw new Error(`${file}: "${base.name}" is not a key-value-source; remove "approval"`);
    return base;
  });
  return { 'key-value-source': sources, 'dom-classifier': plain('dom-classifier'), 'match-strategy': plain('match-strategy'), 'page-script': plain('page-script') };
}
