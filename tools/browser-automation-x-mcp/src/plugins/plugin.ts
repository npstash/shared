// The common API of the plugins (REQ-031 of sdd/SRS.md). A plugin is one implementation in
// plugins/<category>/<plugin>/index.ts. Its default export is a class of its category. A plugin
// instance is one entry of "plugins" in server.json.
// A plugin gets only its context and the data of each call: no object of the server and no
// object of Playwright.
import type { JsonObject } from '../json.ts';

// The categories of the plugins. An approval plugin is only in "approval" of a key-value-source.
export type Category = 'key-value-source' | 'approval-plugin' | 'dom-classifier' | 'match-strategy' | 'page-script';

// The categories with their own array in "plugins" of server.json, in this order.
export const INSTANCE_CATEGORIES: readonly Category[] = ['key-value-source', 'dom-classifier', 'match-strategy', 'page-script'];

// The page that a call is about. It has no page content.
export interface PageInfo {
  readonly url: string;
  readonly host: string | undefined;
  // The host, then its parent domains; the root domain is last (from the Public Suffix List).
  // Empty for a page without a host.
  readonly hosts: readonly string[];
}

// The log of one plugin instance. The server adds the instance name to each event.
export interface PluginLogger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

// What the server gives to an instance when it makes it.
export interface PluginContext {
  // "name" of the instance in server.json.
  readonly name: string;
  // "config" of the instance.
  readonly config: JsonObject;
  // The config folder: a relative path in "config" is relative to it.
  readonly configDir: string;
  readonly logger: PluginLogger;
}

export interface Plugin {
  // Release the resources of the instance, e.g. at the shutdown of the server.
  dispose?(): Promise<void>;
}

// The default export of plugins/<category>/<plugin>/index.ts: a class of the category.
export type PluginClass<P extends Plugin> = new (context: PluginContext) => P;
