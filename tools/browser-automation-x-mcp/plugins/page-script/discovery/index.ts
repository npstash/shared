// Page-script "discovery" (REQ-039, REQ-039a of sdd/SRS.md): the recorder. The page code (page.ts)
// reports the actions of the user. This Node code writes the discovery file:
// - at a submit, a navigation or the close of the lane: a form with the fields that the user
//   filled, with the key of the value ("<selector>": "<key>"), and the button that the user clicked
//   into "submit"; the link that the user followed before into "login".
//   A form that has a selector of the new form gets the new selectors; else the form is added.
//   The form and the link go into the node of the root domain.
// The server gives only the keys of the values: this code never sees a value.
//
//   "config": { "file": "<discovery file in the config folder>" }
import type { PageMessage, PageScriptPlugin } from '../../../src/plugins/page-script.ts';
import type { PageInfo, PluginContext, PluginLogger } from '../../../src/plugins/plugin.ts';
import type { DiscoveryForm, DiscoveryNode, Matcher } from '../../common/discovery/index.ts';
import { DiscoveryFile } from '../../common/discovery/index.ts';
import { pluginFile } from '../../common/files/index.ts';
import type { FieldInfo, RecorderMessage } from './page.ts';
import { recorder } from './page.ts';

// A button click without a submit is written after this time, if no submit or navigation comes
// first: a page can change without a navigation.
const PRESS_WAIT: number = 1000;

// One message with its page and the keys of its values: selector → keys.
interface PageRecord {
  readonly message: RecorderMessage;
  readonly page: PageInfo;
  readonly keys: ReadonlyMap<string, readonly string[]>;
}

// The state of one lane.
interface LaneState {
  // The records of each page URL since the last write.
  readonly pending: Map<string, PageRecord[]>;
  // The last link that the user followed.
  lastLink: { readonly page: PageInfo; readonly matcher: Matcher } | undefined;
  // The timers of the button clicks that wait, by page URL.
  readonly timers: Map<string, NodeJS.Timeout>;
}

// A field of the user and the key of its value, or the name from its attributes.
interface FieldKey {
  readonly key: string | undefined;
  readonly fallback: string;
}

// The name of a field without a key: username, password, email, otp, else its name.
function entryName(field: FieldInfo): string {
  const tokens = field.autocomplete.toLowerCase().split(/\s+/);
  if (tokens.includes('username')) return 'username';
  if (field.type === 'password' || tokens.includes('current-password') || tokens.includes('new-password')) return 'password';
  if (tokens.includes('one-time-code')) return 'otp';
  if (field.type === 'email' || tokens.includes('email')) return 'email';
  return field.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
}

// The text of a matcher for the log.
function matcherText(matcher: Matcher): string {
  return typeof matcher === 'string' ? matcher : `${matcher.css} "${matcher.text}"`;
}

// The node of the root domain of a page. Make it if it is missing (REQ-039a).
function rootNode(hosts: Record<string, DiscoveryNode>, page: PageInfo): DiscoveryNode | undefined {
  const root = page.hosts.at(-1);
  if (root === undefined) return undefined;
  return hosts[root] ??= {};
}

// The form of a node with one of the selectors, else a new form at the end if create is true.
function formEntry(node: DiscoveryNode, selectors: readonly string[], create: boolean): DiscoveryForm | undefined {
  let form = (node.forms ?? []).find((entry) => selectors.some((selector) => entry.fields[selector] !== undefined));
  if (!form && !create) return undefined;
  if (!form) {
    form = { fields: {} };
    (node.forms ??= []).push(form);
  }
  return form;
}

export default class DiscoveryRecorder implements PageScriptPlugin<RecorderMessage> {
  private readonly file: DiscoveryFile;
  private readonly logger: PluginLogger;
  private readonly lanes: Map<string, LaneState> = new Map();

  constructor(context: PluginContext) {
    this.file = new DiscoveryFile(pluginFile(context, 'file'));
    this.logger = context.logger;
  }

  async pageScript(): Promise<string> {
    return recorder.toString();
  }

  async onMessage({ lane, data, identified }: PageMessage<RecorderMessage>, page: PageInfo): Promise<void> {
    const state = this.stateOf(lane);
    this.log(data, page);
    const record: PageRecord = { message: data, page, keys: new Map(identified.map(({ id, keys }) => [id, keys])) };
    if (data.action === 'link' && !data.touched && data.link.matcher) state.lastLink = { page, matcher: data.link.matcher };
    const list = state.pending.get(page.url) ?? [];
    list.push(record);
    state.pending.set(page.url, list);
    if (data.action === 'submit' || data.action === 'leave') {
      this.flush(state, page.url);
    } else if (data.action === 'press' && !data.touched) {
      clearTimeout(state.timers.get(page.url));
      const timer = setTimeout(() => this.flush(state, page.url), PRESS_WAIT);
      timer.unref();
      state.timers.set(page.url, timer);
    }
  }

  async laneClosed(lane: string): Promise<void> {
    const state = this.lanes.get(lane);
    if (!state) return;
    for (const url of [...state.pending.keys()]) this.flush(state, url);
    this.lanes.delete(lane);
  }

  private stateOf(lane: string): LaneState {
    let state = this.lanes.get(lane);
    if (!state) {
      state = { pending: new Map(), lastLink: undefined, timers: new Map() };
      this.lanes.set(lane, state);
    }
    return state;
  }

  // Log each action of the user, without values.
  private log(data: RecorderMessage, page: PageInfo): void {
    if (data.touched || data.action === 'leave') return;
    const verb = { fill: 'filled', press: 'pressed', submit: 'submitted', link: 'followed' }[data.action];
    const at = new Date(data.ts).toTimeString().slice(0, 8);
    let target: string | undefined;
    if (data.action === 'link') {
      try {
        target = `${new URL(data.link.href).hostname}${new URL(data.link.href).pathname}`;
      } catch {
        target = undefined;
      }
    }
    this.logger.info(`user_${verb}`, {
      url: page.url, at,
      selector: data.action === 'fill' ? data.field.selector ?? undefined : undefined,
      field: data.action === 'fill' ? entryName(data.field) : undefined,
      button: data.action === 'press' ? data.button.text : data.action === 'submit' ? data.button?.text : undefined,
      target,
    });
  }

  // Write the records of one page that wait (REQ-039a).
  private flush(state: LaneState, url: string): void {
    clearTimeout(state.timers.get(url));
    state.timers.delete(url);
    const records = state.pending.get(url) ?? [];
    state.pending.delete(url);
    const page = records[0]?.page;
    if (!page?.host) return;

    // The fields of the user and of the server, and the keys of the values of the user.
    const fills = new Map<string, FieldInfo>();
    const touchedFills = new Set<string>();
    const keys = new Map<string, readonly string[]>();
    for (const { message, keys: own } of records) {
      if (message.action === 'fill' && message.field.selector) {
        if (message.touched) touchedFills.add(message.field.selector);
        else fills.set(message.field.selector, message.field);
      }
      for (const [selector, list] of own) keys.set(selector, list);
    }

    // The submit: a submit of the user with its button, else the last button click of the user.
    let submit: Matcher | 'enter' | undefined;
    const formSubmit = records.findLast(({ message }) => message.action === 'submit' && !message.touched)?.message;
    if (formSubmit?.action === 'submit') submit = formSubmit.button?.matcher ?? (formSubmit.enter && !formSubmit.button ? 'enter' : undefined);
    if (!submit) {
      const press = records.findLast(({ message }) => message.action === 'press' && !message.touched && message.button.matcher)?.message;
      if (press?.action === 'press') submit = press.button.matcher ?? undefined;
    }
    if (!fills.size && !(touchedFills.size && submit)) return;

    const fieldKeys = new Map<string, FieldKey>();
    for (const [selector, field] of fills) fieldKeys.set(selector, { key: keys.get(selector)?.[0], fallback: entryName(field) });

    const link = fills.size && submit ? state.lastLink : undefined;
    const written = this.file.update((content) => {
      const changes: string[] = [];
      const node = rootNode(content.hosts, page);
      // Only the server filled: the submit goes to its form, if there is one.
      const form = node && formEntry(node, [...fieldKeys.keys(), ...touchedFills], fieldKeys.size > 0);
      for (const [selector, { key, fallback }] of form ? fieldKeys : []) {
        if (!form) break;
        if (key !== undefined) {
          if (form.fields[selector] !== key) changes.push(`${selector}=${key}`);
          form.fields[selector] = key;
        } else if (form.fields[selector] === undefined) {
          form.fields[selector] = fallback;
          changes.push(`${selector}=${fallback}?`);
        }
      }
      if (form && submit && !(form.submit ??= []).some((entry) => JSON.stringify(entry) === JSON.stringify(submit))) {
        form.submit.push(submit);
        changes.push(`submit=${submit === 'enter' ? 'enter' : matcherText(submit)}`);
      }
      if (link) {
        const from = rootNode(content.hosts, link.page);
        if (from && !(from.login ??= []).some((entry) => JSON.stringify(entry) === JSON.stringify(link.matcher))) {
          from.login.push(link.matcher);
          changes.push(`login=${matcherText(link.matcher)}`);
        }
      }
      return changes;
    });
    if (link) state.lastLink = undefined;
    if (written.length) this.logger.info('fields_written', { url, written });
  }
}
