// Discovery mode (BROWSER_AUTOMATION_X_MCP_DISCOVER=1). See README.md, section "Discovery", and
// REQ-039, REQ-039a, REQ-042 of sdd/SRS.md.
// The page code of page-lib.ts reports to the binding __baxRecord of the server, without a call of
// the agent: the fills, button clicks, link clicks and submits of the user, of the agent and of the
// form fill. A button click and a submit also give the values of the fields that the form fill did
// not fill. The server logs each record at once, without values.
//
// The server writes sites.json (updateSites() of src/sites.ts):
// - at each page load: the host, with "access": "allow";
// - at a submit, a navigation or the close of the lane: a form with the fields that the user
//   filled, with the key of the value from the key-value providers ("<selector>": "<key>"), and the
//   button that the user clicked into "submit"; the link that the user followed before into "login".
//   A form that has a selector of the new form gets the new selectors; else the form is added.
//   The form and the link go into the nearest node with a "provider-config", else the root domain.
// The values are discarded after the match. They are never logged or written.
import type { BrowserContext, Frame, Page } from 'playwright-core';
import type { FillContext } from '../../src/fill/provider.ts';
import type { FillValues } from '../../src/fill/registry.ts';
import { hostOfUrl } from '../../src/hosts/patterns.ts';
import { errorMessage } from '../../src/json.ts';
import type { Logger } from '../../src/logger.ts';
import type { FormEntry, SiteNode, SitesFileData, SiteTree } from '../../src/sites.ts';
import { chainIn, rootDomain, updateSites } from '../../src/sites.ts';
import type { ButtonInfo, FieldInfo, LinkInfo, RecorderReport } from './page-lib.ts';
import { pageLib } from './page-lib.ts';
import type { LaneSession } from './session.ts';

// An event of the agent comes in the time of its call, or this much later.
const AGENT_SLACK: number = 500;

const SCRIPT: string = `(${pageLib.toString()})().installRecorder();`;

export type Actor = 'user' | 'agent' | 'auto-fill';

// A type of the union without the key "values", for each member.
type WithoutValues<T> = T extends unknown ? Omit<T, 'values'> : never;

// One record of the recorder, without the values of the report.
export type DiscoveryRecord = WithoutValues<RecorderReport> & {
  readonly url: string | undefined;
  readonly who: Actor;
  // The values of the fields of the user: selector → value. Discarded after the match.
  values?: Map<string, string>;
  // The selector of the element; a submit without a button has none.
  selector?: string | undefined;
};

// The records of one page since the last write.
interface PendingPage {
  readonly records: DiscoveryRecord[];
}

// The discovery state of one lane.
interface LaneState {
  readonly pending: Map<Page, PendingPage>;
  // The last link that the user followed.
  lastLink: { readonly url: string; readonly selector: string } | undefined;
}

// The field of the user and the key of its value, or the name from its attributes.
interface FieldKey {
  readonly key: string | undefined;
  readonly fallback: string;
}

// The recorder of the discovery mode.
export interface InteractionRecorder {
  // Start the discovery in the browser context of a lane.
  start(lane: LaneSession, context: BrowserContext): Promise<void>;
  // Write the records that wait, e.g. before a lane closes.
  stop(lane: LaneSession): Promise<void>;
}

export interface DiscoveryOptions {
  readonly sites: SiteTree;
  readonly fill: FillValues;
  readonly logger: Logger;
  // The client name of MCP initialize, or undefined.
  readonly clientName: () => string | undefined;
}

export class Discovery implements InteractionRecorder {
  private readonly sites: SiteTree;
  private readonly fill: FillValues;
  private readonly logger: Logger;
  private readonly clientName: () => string | undefined;
  private readonly lanes: Map<LaneSession, LaneState> = new Map();

  constructor({ sites, fill, logger, clientName }: DiscoveryOptions) {
    this.sites = sites;
    this.fill = fill;
    this.logger = logger;
    this.clientName = clientName;
  }

  async start(lane: LaneSession, context: BrowserContext): Promise<void> {
    const state: LaneState = { pending: new Map(), lastLink: undefined };
    this.lanes.set(lane, state);

    await context.exposeBinding('__baxRecord', async (source: { page: Page; frame: Frame }, report: RecorderReport) => {
      const page = source.page;
      const url = page?.url() ?? source.frame?.url();
      const { values, ...event } = report as RecorderReport & { values?: { selector: string | undefined; value: string }[] };
      const record: DiscoveryRecord = { ...event, url, who: this.whoOf(lane, report) };
      // A Playwright locator must find one element, else the record has no selector.
      if (record.selector && !('css' in record && record.css) && record.kind !== 'link'
        && await source.frame.locator(record.selector).count().catch(() => 0) !== 1) record.selector = undefined;
      this.logRecord(record);
      if (!page || !url || !hostOfUrl(url)) return;
      if (record.who === 'user' && values?.length) {
        record.values = new Map(values.filter((item) => item.selector).map(({ selector, value }) => [selector ?? '', value]));
      }
      if (record.action === 'link' && record.who === 'user' && record.selector) state.lastLink = { url, selector: record.selector };
      entryOf(state.pending, page).records.push(record);
      if (record.action === 'submit') await this.flush(lane, page);
    });

    await context.addInitScript({ content: SCRIPT });
    const watch = (page: Page): void => {
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return;
        this.flush(lane, page).catch((error: unknown) => this.logger.error('discovery_error', { message: errorMessage(error) }));
      });
      page.on('load', () => this.recordHost(page.url()));
    };
    for (const page of context.pages()) {
      watch(page);
      for (const frame of page.frames()) await frame.evaluate(SCRIPT).catch(() => {});
    }
    context.on('page', watch);
  }

  async stop(lane: LaneSession): Promise<void> {
    const state = this.lanes.get(lane);
    if (!state) return;
    for (const page of [...state.pending.keys()]) await this.flush(lane, page);
    this.lanes.delete(lane);
  }

  // Record a loaded page of an allowed host as a site with "access": "allow". An access that the
  // file has stays. A denied host is never recorded (REQ-042).
  recordHost(url: string): void {
    const host = hostOfUrl(url);
    if (!host || !this.sites.access(host).allowed) return;
    // The root domain gets the access; the subdomains inherit it (REQ-037).
    const root = rootDomain(host);
    const added = updateSites(this.sites.file, (data) => {
      const site = data.sites[root] ??= {};
      if (site.access) return false;
      site.access = 'allow';
      return true;
    });
    if (added) this.logger.info('host_recorded', { host: root });
  }

  // The fill, click or submit was of the form fill, of the agent (in the time of its call) or of the user.
  private whoOf(lane: LaneSession, report: RecorderReport): Actor {
    if (report.auto) return 'auto-fill';
    return lane.agentCalls.some(({ start, end }) => report.ts >= start && report.ts <= (end ?? Infinity) + AGENT_SLACK) ? 'agent' : 'user';
  }

  private logRecord(record: DiscoveryRecord): void {
    if (record.who === 'auto-fill') return;
    const verb = { fill: 'filled', press: 'pressed', submit: 'submitted', link: 'followed' }[record.action];
    const at = new Date(record.ts).toTimeString().slice(0, 8);
    let target: string | undefined;
    try {
      target = record.action === 'link' && record.href ? `${new URL(record.href).hostname}${new URL(record.href).pathname}` : undefined;
    } catch {
      target = undefined;
    }
    this.logger.info(`${record.who}_${verb}`, {
      url: record.url, at, selector: record.selector,
      field: record.action === 'fill' ? entryName(record) : undefined,
      button: record.action === 'press' ? record.text : record.action === 'submit' ? record.button?.text : undefined,
      target,
    });
  }

  // Write the records of one page that wait (REQ-039a).
  private async flush(lane: LaneSession, page: Page): Promise<void> {
    const state = this.lanes.get(lane);
    const entry = state?.pending.get(page);
    if (!state || !entry?.records.length) return;
    const records = entry.records.splice(0);
    const url = records.find((record) => record.url)?.url;
    if (!url || !hostOfUrl(url)) return;

    // The fields of the user, and the last values of each (from a click or a submit).
    const fills = new Map<string, DiscoveryRecord & FieldInfo>();
    const values = new Map<string, string>();
    const autoFilled = new Set<string>();
    for (const record of records) {
      if (record.action === 'fill' && record.selector) {
        if (record.who === 'user') fills.set(record.selector, record);
        if (record.who === 'auto-fill') autoFilled.add(record.selector);
      }
      for (const [selector, value] of record.values ?? []) values.set(selector, value);
    }

    // The submit: a submit with a button of the user, else the last button click of the user.
    let submit: string | undefined;
    const formSubmit = records.findLast((record) => record.action === 'submit' && record.who === 'user');
    if (formSubmit?.action === 'submit') submit = formSubmit.button?.selector ?? (formSubmit.enter && !formSubmit.button ? 'enter' : undefined);
    if (!submit) submit = records.findLast((record) => record.action === 'press' && record.who === 'user' && record.selector)?.selector;
    if (!fills.size && !(autoFilled.size && submit)) return;

    // The keys of the values of the user. The values are discarded after this step.
    const ctx: FillContext = { host: hostOfUrl(url), url, client: this.clientName(), elicit: undefined };
    const keys = new Map<string, FieldKey>();
    for (const [selector, record] of fills) {
      let key: string | undefined;
      const value = values.get(selector);
      if (value !== undefined) {
        try {
          key = await this.fill.match(value, ctx);
        } catch (error) {
          this.logger.error('discovery_match_error', { url, selector, message: errorMessage(error) });
        }
      }
      keys.set(selector, { key, fallback: entryName(record) });
    }
    values.clear();
    for (const record of records) delete record.values;

    const link = fills.size && submit ? state.lastLink : undefined;
    const written: string[] = [];
    updateSites(this.sites.file, (data) => {
      // Only the form fill filled: the submit goes to its form, if there is one.
      const target = formEntry(nodeEntry(data, url), [...keys.keys(), ...autoFilled], keys.size > 0);
      const fields = target?.fields ?? {};
      for (const [selector, { key, fallback }] of target ? keys : []) {
        if (key !== undefined) {
          if (fields[selector] !== key) written.push(`${selector}=${key}`);
          fields[selector] = key;
        } else if (fields[selector] === undefined) {
          fields[selector] = fallback;
          written.push(`${selector}=${fallback}?`);
        }
      }
      if (target && submit && !(target.submit ??= []).includes(submit)) {
        target.submit.push(submit);
        written.push(`submit=${submit}`);
      }
      if (link) {
        const from = nodeEntry(data, link.url);
        if (!(from.login ??= []).includes(link.selector)) {
          from.login.push(link.selector);
          written.push(`login=${link.selector}`);
        }
      }
      return written;
    });
    if (link) state.lastLink = undefined;
    if (written.length) this.logger.info('fields_written', { url, written });
  }
}

function entryOf(pending: Map<Page, PendingPage>, page: Page): PendingPage {
  let entry = pending.get(page);
  if (!entry) {
    entry = { records: [] };
    pending.set(page, entry);
  }
  return entry;
}

// The node of sites.json for the forms and the login links of a URL: the nearest node with a
// "provider-config", else the root domain. Make the root domain if it is missing (REQ-039a).
function nodeEntry(data: SitesFileData, url: string): SiteNode {
  const host = hostOfUrl(url) ?? '';
  const chain = chainIn(data.sites, host);
  const configured = chain.findLast(({ node }) => node['provider-config']);
  if (configured) return configured.node;
  if (chain[0]) return chain[0].node;
  return data.sites[rootDomain(host)] ??= {};
}

// The form of a node with one of the selectors, else a new form at the end if create is true
// (REQ-039a).
function formEntry(node: SiteNode, selectors: readonly string[], create: boolean): (FormEntry & { fields: Record<string, string> }) | undefined {
  let form = (node.forms ?? []).find((entry) => selectors.some((selector) => entry?.fields?.[selector] !== undefined));
  if (!form && !create) return undefined;
  if (!form) {
    form = {};
    (node.forms ??= []).push(form);
  }
  form.fields ??= {};
  return form as FormEntry & { fields: Record<string, string> };
}

// The name of a field without a key: username, password, email, otp, else its name.
function entryName(item: FieldInfo | ButtonInfo | LinkInfo): string {
  if (item.kind === 'button') return 'submit';
  if (item.kind === 'link') return 'login';
  const tokens = (item.autocomplete ?? '').toLowerCase().split(/\s+/);
  if (tokens.includes('username')) return 'username';
  if (item.type === 'password' || tokens.includes('current-password') || tokens.includes('new-password')) return 'password';
  if (tokens.includes('one-time-code')) return 'otp';
  if (item.type === 'email' || tokens.includes('email')) return 'email';
  return (item.name ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
}
