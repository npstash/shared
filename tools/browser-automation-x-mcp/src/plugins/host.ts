// The plugin host: it loads the plugin instances of server.json and gives the server the values,
// the approvals, the keys of a value and the scrub of masked values (REQ-031, REQ-031a, REQ-032,
// REQ-036c of sdd/SRS.md). It never gives a server object or a Playwright object to a plugin.
// The client never sees a value of a masked instance ("mask": true, the default): the server
// replaces it with MASK in each result and in each file that upstream wrote (scrub).
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonObject, JsonValue } from '../json.ts';
import { errorMessage } from '../json.ts';
import type { Logger } from '../logger.ts';
import type { ApprovalEntry, InstanceEntry, PluginEntries } from '../server-config.ts';
import type { ApprovalPlugin, Dialog } from './approval-plugin.ts';
import type { DomClassifier } from './dom-classifier.ts';
import type { KeyValueSource } from './key-value-source.ts';
import { SourceError } from './key-value-source.ts';
import type { MatchStrategy } from './match-strategy.ts';
import type { PageScriptPlugin } from './page-script.ts';
import type { Category, PageInfo, Plugin, PluginClass, PluginContext, PluginLogger } from './plugin.ts';

export const MASK: string = '***';

// The fill stops: a source failed, or an approval was refused.
export class FillError extends Error {}

// An approval plugin refused the fill, or did not answer in APPROVAL_TIMEOUT.
export class ApprovalError extends FillError {}

// One instance with its name.
export interface Named<P extends Plugin> {
  readonly name: string;
  readonly plugin: P;
}

// One key-value-source instance, with its mask and its approval.
export interface SourceInstance extends Named<KeyValueSource> {
  readonly masked: boolean;
  readonly approval: Named<ApprovalPlugin> | undefined;
}

// The page, the client and the dialog of one fill.
export interface FillRequest {
  readonly page: PageInfo;
  readonly client: string | undefined;
  readonly dialog: Dialog | undefined;
}

// The values of the form fill and the scrub of masked values.
export interface ValueService {
  // The keys of all key-value-source instances for the page, without duplicates (any case).
  keys(page: PageInfo): Promise<string[]>;
  // The values of the keys of one fill: key → value. A key without a value is missing.
  // The first instance in order that has the key gives the value. Each instance with an approval
  // gets one approval for all its keys of the fill. Throw a FillError when a source fails or an
  // approval is refused.
  values(keys: readonly string[], request: FillRequest): Promise<Map<string, string>>;
  // The keys whose value is equal to the value, in the order of the instances. A value of a masked
  // instance goes into the scrub.
  keysOf(value: string, page: PageInfo): Promise<string[]>;
  // Replace each masked value with MASK, in one text.
  clean(text: string): string;
  // Replace each masked value with MASK, in each text of a result.
  scrub(result: CallToolResult): CallToolResult;
  // The same for files that upstream wrote. Binary files stay.
  scrubFiles(files: readonly string[]): void;
}

export interface PluginHostLoad {
  readonly entries: PluginEntries;
  // The folder of the plugins: plugins/<category>/<plugin>/index.ts.
  readonly pluginsDir: string;
  readonly configDir: string;
  readonly logger: Logger;
}

// The log of one instance: the server adds the instance name to each event.
class InstanceLogger implements PluginLogger {
  private readonly logger: Logger;
  private readonly name: string;

  constructor(logger: Logger, name: string) {
    this.logger = logger;
    this.name = name;
  }

  info(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.logger.info(event, { plugin: this.name, ...fields });
  }

  error(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.logger.error(event, { plugin: this.name, ...fields });
  }
}

// Make an instance of a plugin from plugins/<category>/<plugin>/index.ts.
async function makeInstance<P extends Plugin>(pluginsDir: string, category: Category, plugin: string, context: PluginContext): Promise<P> {
  const file = path.join(pluginsDir, category, plugin, 'index.ts');
  if (!fs.existsSync(file)) throw new Error(`the plugin "${plugin}" of server.json is not in plugins/${category}/`);
  const module = await import(pathToFileURL(file).href) as { default?: PluginClass<P> };
  if (typeof module.default !== 'function') throw new Error(`plugins/${category}/${plugin}/index.ts has no default export of a class`);
  return new module.default(context);
}

export class PluginHost implements ValueService {
  readonly sources: readonly SourceInstance[];
  readonly classifiers: readonly Named<DomClassifier<JsonValue>>[];
  readonly strategies: readonly Named<MatchStrategy>[];
  readonly pageScripts: readonly Named<PageScriptPlugin<JsonValue>>[];
  // The values to replace, for the scrub. Kept for the session.
  readonly secrets: Set<string> = new Set();
  private readonly logger: Logger;

  constructor({ sources, classifiers, strategies, pageScripts, logger }: {
    sources: readonly SourceInstance[];
    classifiers: readonly Named<DomClassifier<JsonValue>>[];
    strategies: readonly Named<MatchStrategy>[];
    pageScripts: readonly Named<PageScriptPlugin<JsonValue>>[];
    logger: Logger;
  }) {
    this.sources = sources;
    this.classifiers = classifiers;
    this.strategies = strategies;
    this.pageScripts = pageScripts;
    this.logger = logger;
  }

  // Load the instances that are on. A missing plugin stops the server (REQ-031).
  static async load({ entries, pluginsDir, configDir, logger }: PluginHostLoad): Promise<PluginHost> {
    const context = (name: string, config: JsonObject): PluginContext => ({ name, config, configDir, logger: new InstanceLogger(logger, name) });
    const make = <P extends Plugin>(category: Category, entry: InstanceEntry): Promise<Named<P>> =>
      makeInstance<P>(pluginsDir, category, entry.plugin, context(entry.name, entry.config)).then((plugin) => ({ name: entry.name, plugin }));
    const approvalOf = async (owner: string, approval: ApprovalEntry | undefined): Promise<Named<ApprovalPlugin> | undefined> => {
      if (!approval?.enabled) return undefined;
      const name = `${owner}.approval`;
      const plugin = await makeInstance<ApprovalPlugin>(pluginsDir, 'approval-plugin', approval.plugin, context(name, approval.config));
      return { name, plugin };
    };
    const on = <E extends InstanceEntry>(list: readonly E[]): E[] => list.filter((entry) => entry.enabled);
    const sources: SourceInstance[] = [];
    for (const entry of on(entries['key-value-source'])) {
      const { plugin } = await make<KeyValueSource>('key-value-source', entry);
      sources.push({ name: entry.name, plugin, masked: entry.mask, approval: await approvalOf(entry.name, entry.approval) });
    }
    const all = async <P extends Plugin>(category: Category, list: readonly InstanceEntry[]): Promise<Named<P>[]> => {
      const result: Named<P>[] = [];
      for (const entry of on(list)) result.push(await make<P>(category, entry));
      return result;
    };
    const host = new PluginHost({
      sources,
      classifiers: await all<DomClassifier<JsonValue>>('dom-classifier', entries['dom-classifier']),
      strategies: await all<MatchStrategy>('match-strategy', entries['match-strategy']),
      pageScripts: await all<PageScriptPlugin<JsonValue>>('page-script', entries['page-script']),
      logger,
    });
    logger.info('plugins_loaded', {
      'key-value-source': sources.map((s) => (s.approval ? `${s.name}(approval)` : s.name)),
      masked: sources.filter((s) => s.masked).map((s) => s.name),
      'dom-classifier': host.classifiers.map((c) => c.name),
      'match-strategy': host.strategies.map((m) => m.name),
      'page-script': host.pageScripts.map((p) => p.name),
    });
    return host;
  }

  // The keys of each source for the page. A failed source has no keys; its error goes to the log.
  private async sourceKeys(page: PageInfo): Promise<Map<SourceInstance, readonly string[]>> {
    const result = new Map<SourceInstance, readonly string[]>();
    for (const source of this.sources) {
      try {
        result.set(source, await source.plugin.keys(page));
      } catch (error) {
        this.logger.error('source_error', { plugin: source.name, url: page.url, message: errorMessage(error) });
        result.set(source, []);
      }
    }
    return result;
  }

  async keys(page: PageInfo): Promise<string[]> {
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const list of (await this.sourceKeys(page)).values()) {
      for (const key of list) {
        if (seen.has(key.toLowerCase())) continue;
        seen.add(key.toLowerCase());
        keys.push(key);
      }
    }
    return keys;
  }

  async values(keys: readonly string[], { page, client, dialog }: FillRequest): Promise<Map<string, string>> {
    const sourceKeys = await this.sourceKeys(page);
    // The keys of each source: the first source in order with the key (any case).
    const groups = new Map<SourceInstance, string[]>();
    for (const key of keys) {
      for (const source of this.sources) {
        const own = sourceKeys.get(source)?.find((each) => each.toLowerCase() === key.toLowerCase());
        if (own === undefined) continue;
        const list = groups.get(source) ?? [];
        list.push(own);
        groups.set(source, list);
        break;
      }
    }
    const values = new Map<string, string>();
    for (const [source, list] of groups) {
      if (source.approval) {
        const request = { host: page.host, keys: list, client };
        let approved = false;
        try {
          approved = await source.approval.plugin.approve(request, dialog);
        } catch (error) {
          this.logger.error('approval_error', { plugin: source.approval.name, message: errorMessage(error) });
        }
        this.logger.info(approved ? 'fill_approved' : 'fill_refused', { plugin: source.approval.name, host: page.host, keys: list });
        if (!approved) throw new ApprovalError(`the fill of ${list.join(', ')} was not approved`);
      }
      let given: Readonly<Record<string, string>>;
      try {
        given = await source.plugin.values(list, page);
      } catch (error) {
        if (error instanceof SourceError) throw new FillError(error.message);
        throw error;
      }
      for (const key of list) {
        const value = given[key];
        if (value === undefined) continue;
        this.logger.info('fill_value', { field: key, plugin: source.name, host: page.host });
        if (value && source.masked) this.secrets.add(value);
        values.set(key, value);
      }
    }
    // The values in the case of the requested keys.
    const result = new Map<string, string>();
    for (const key of keys) {
      const found = [...values].find(([own]) => own.toLowerCase() === key.toLowerCase());
      if (found) result.set(key, found[1]);
    }
    return result;
  }

  async keysOf(value: string, page: PageInfo): Promise<string[]> {
    if (!value) return [];
    const keys: string[] = [];
    for (const source of this.sources) {
      let found: readonly string[] = [];
      try {
        found = await source.plugin.keysOf(value, page);
      } catch (error) {
        this.logger.error('source_error', { plugin: source.name, url: page.url, message: errorMessage(error) });
      }
      if (found.length && source.masked) this.secrets.add(value);
      keys.push(...found);
    }
    return keys;
  }

  clean(text: string): string {
    const values = [...this.secrets].sort((a, b) => b.length - a.length);
    return values.reduce((out, value) => out.split(value).join(MASK), text);
  }

  scrub(result: CallToolResult): CallToolResult {
    if (!this.secrets.size) return result;
    const content = result.content?.map((part) => (part.type === 'text' ? { ...part, text: this.clean(part.text) } : part));
    const scrubbed: CallToolResult = { ...result, content };
    if (result.structuredContent) scrubbed.structuredContent = JSON.parse(this.clean(JSON.stringify(result.structuredContent))) as Record<string, unknown>;
    return scrubbed;
  }

  scrubFiles(files: readonly string[]): void {
    if (!this.secrets.size) return;
    for (const file of files) {
      let text: string;
      try {
        const data = fs.readFileSync(file);
        if (data.includes(0)) continue;
        text = data.toString('utf8');
      } catch {
        continue;
      }
      const clean = this.clean(text);
      if (clean === text) continue;
      fs.writeFileSync(file, clean);
      this.logger.info('scrub_file', { file });
    }
  }

  async dispose(): Promise<void> {
    const plugins: Plugin[] = [
      ...this.sources.flatMap((s) => (s.approval ? [s.plugin, s.approval.plugin] : [s.plugin])),
      ...this.classifiers.map((c) => c.plugin),
      ...this.strategies.map((m) => m.plugin),
      ...this.pageScripts.map((p) => p.plugin),
    ];
    await Promise.allSettled(plugins.map((plugin) => plugin.dispose?.()));
  }
}
