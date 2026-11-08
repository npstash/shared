// The page-script instances in the lanes (REQ-031d of sdd/SRS.md). The server injects the page code
// of each instance into each frame of each lane, with a PageApi. The page code sends its messages
// through the binding __baxPage. The server replaces each value with its keys from the
// key-value-sources, then gives the message to the Node code of the instance.
import type { BrowserContext, Frame, Page } from 'playwright-core';
import type { JsonValue } from '../../src/json.ts';
import { errorMessage } from '../../src/json.ts';
import type { Logger } from '../../src/logger.ts';
import type { Named, ValueService } from '../../src/plugins/host.ts';
import { pageInfo } from '../../src/plugins/page-info.ts';
import type { IdentifiedValue, PageScriptPlugin, ValueToIdentify } from '../../src/plugins/page-script.ts';

// The page-scripts of the lanes.
export interface PageScriptHost {
  // True if no page-script instance is on.
  readonly empty: boolean;
  // Inject the page code of each instance into the context of a lane.
  install(lane: string, context: BrowserContext): Promise<void>;
  // Tell each instance that a lane closes.
  laneClosed(lane: string): Promise<void>;
}

export interface PageScriptsOptions {
  readonly instances: readonly Named<PageScriptPlugin<JsonValue>>[];
  readonly values: ValueService;
  readonly logger: Logger;
}

// The script of one instance: the PageApi, then the page code with it. The binding is the only
// name that the script takes from the page.
function wrap(name: string, script: string): string {
  return `(() => {
  const binding = window.__baxPage;
  if (typeof binding !== 'function') return;
  const key = ${JSON.stringify(`__baxPageScript:${name}`)};
  if (window[key]) return;
  window[key] = true;
  const api = {
    send(data, values) { try { binding(${JSON.stringify(name)}, data, values || []); } catch {} },
    touchedByServer(element) { return Boolean(element && element.__baxTouched); },
  };
  (${script})(api);
})();`;
}

function isValueList(value: unknown): value is ValueToIdentify[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.value === 'string');
}

export class PageScripts implements PageScriptHost {
  private readonly instances: readonly Named<PageScriptPlugin<JsonValue>>[];
  private readonly values: ValueService;
  private readonly logger: Logger;
  // The wrapped scripts, made at the first install.
  private scripts: Promise<string[]> | undefined = undefined;

  constructor({ instances, values, logger }: PageScriptsOptions) {
    this.instances = instances;
    this.values = values;
    this.logger = logger;
  }

  get empty(): boolean {
    return this.instances.length === 0;
  }

  async install(lane: string, context: BrowserContext): Promise<void> {
    if (this.empty) return;
    this.scripts ??= Promise.all(this.instances.map(async ({ name, plugin }) => wrap(name, await plugin.pageScript())));
    const scripts = await this.scripts;
    await context.exposeBinding('__baxPage', async (source: { page: Page; frame: Frame }, name: unknown, data: unknown, values: unknown) => {
      const instance = this.instances.find((each) => each.name === name);
      if (!instance || !isValueList(values)) return;
      const page = pageInfo(source.page?.url() ?? source.frame?.url() ?? '');
      try {
        const identified: IdentifiedValue[] = [];
        for (const { id, value } of values) identified.push({ id, keys: await this.values.keysOf(value, page) });
        await instance.plugin.onMessage({ lane, data: data as JsonValue, identified }, page);
      } catch (error) {
        this.logger.error('page_script_error', { plugin: instance.name, url: page.url, message: errorMessage(error) });
      }
    });
    for (const content of scripts) {
      await context.addInitScript({ content });
      for (const page of context.pages()) {
        for (const frame of page.frames()) await frame.evaluate(content).catch(() => {});
      }
    }
  }

  async laneClosed(lane: string): Promise<void> {
    for (const { name, plugin } of this.instances) {
      try {
        await plugin.laneClosed(lane);
      } catch (error) {
        this.logger.error('page_script_error', { plugin: name, message: errorMessage(error) });
      }
    }
  }
}
