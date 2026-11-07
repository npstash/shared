// Discovery mode (BROWSER_AUTOMATION_X_MCP_DISCOVER=1). See README.md, section "Discovery", and
// REQ-039, REQ-039a, REQ-042 of sdd/SRS.md.
// The page code of page-lib.js reports to the binding __baxRecord of the server, without a call of
// the agent: the fills, button clicks, link clicks and submits of the user, of the agent and of the
// form fill. A button click and a submit also give the values of the fields that the form fill did
// not fill. The server logs each record at once, without values.
//
// The server writes sites.json (updateSites() of src/sites.js):
// - at each page load: the host, with "access": "allow";
// - at a submit, a navigation or the close of the lane: a form with the fields that the user
//   filled, with the key of the value from the key-value providers ("<selector>": "<key>"), and the
//   button that the user clicked into "submit"; the link that the user followed before into "login".
//   A form that has a selector of the new form gets the new selectors; else the form is added.
//   The form and the link go into the nearest node with a "provider-config", else the root domain.
// The values are discarded after the match. They are never logged or written.
import { hostOfUrl } from '../../src/hosts/patterns.js';
import { chainIn, rootDomain, updateSites } from '../../src/sites.js';
import { pageLib } from './page-lib.js';

// An event of the agent comes in the time of its call, or this much later.
const AGENT_SLACK = 500;

const SCRIPT = `(${pageLib.toString()})().installRecorder();`;

// Start the discovery in the browser context of a lane.
// session.fields: the Sites object of sites.json; session.fill: the fill registry.
export async function startDiscovery(session, context) {
  const file = session.fields.file;
  // Page → { records, writing }: the records of the page since the last write.
  const pending = new Map();
  session.discoveryState = { file, pending, lastLink: undefined };

  await context.exposeBinding('__baxRecord', async (source, event) => {
    const page = source.page;
    const url = page?.url() ?? source.frame?.url();
    const values = event.values;
    delete event.values;
    const record = { ...event, url, who: whoOf(session, event) };
    // A Playwright locator must find one element, else the record has no selector.
    if (record.selector && !record.css && record.kind !== 'link'
      && await source.frame.locator(record.selector).count().catch(() => 0) !== 1) record.selector = undefined;
    logRecord(session, record);
    if (!page || !url || !hostOfUrl(url)) return;
    if (record.who === 'user' && values?.length) record.values = new Map(values.map(({ selector, value }) => [selector, value]));
    if (record.action === 'link' && record.who === 'user' && record.selector) session.discoveryState.lastLink = { url, selector: record.selector };
    entryOf(pending, page).records.push(record);
    if (record.action === 'submit') await flush(session, page);
  });

  await context.addInitScript({ content: SCRIPT });
  const watch = (page) => {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      flush(session, page).catch((error) => session.logger.error('discovery_error', { message: error.message }));
    });
    page.on('load', () => recordHost(session, page.url()));
  };
  for (const page of context.pages()) {
    watch(page);
    for (const frame of page.frames()) await frame.evaluate(SCRIPT).catch(() => {});
  }
  context.on('page', watch);
}

// Write the records that wait, e.g. before a lane closes.
export async function stopDiscovery(session) {
  if (!session.discoveryState) return;
  for (const page of [...session.discoveryState.pending.keys()]) await flush(session, page);
}

// Record a loaded page of an allowed host as a site with "access": "allow". An access that the file
// has stays. A denied host is never recorded (REQ-042).
export function recordHost(session, url) {
  const host = hostOfUrl(url);
  if (!host || !session.fields.access(host).allowed) return;
  // The root domain gets the access; the subdomains inherit it (REQ-037).
  const root = rootDomain(host);
  const added = updateSites(session.fields.file, (data) => {
    const site = data.sites[root] ??= {};
    if (site.access) return false;
    site.access = 'allow';
    return true;
  });
  if (added) session.logger.info('host_recorded', { host: root });
}

function entryOf(pending, page) {
  if (!pending.has(page)) pending.set(page, { records: [] });
  return pending.get(page);
}

// The fill, click or submit was of the form fill, of the agent (in the time of its call) or of the user.
function whoOf(session, event) {
  if (event.auto) return 'auto-fill';
  return session.agentCalls.some(({ start, end }) => event.ts >= start && event.ts <= (end ?? Infinity) + AGENT_SLACK) ? 'agent' : 'user';
}

function logRecord(session, record) {
  if (record.who === 'auto-fill') return;
  const verb = { fill: 'filled', press: 'pressed', submit: 'submitted', link: 'followed' }[record.action];
  const at = new Date(record.ts).toTimeString().slice(0, 8);
  let target;
  try {
    target = record.href ? `${new URL(record.href).hostname}${new URL(record.href).pathname}` : undefined;
  } catch {
    target = undefined;
  }
  session.logger.info(`${record.who}_${verb}`, {
    url: record.url, at, selector: record.selector,
    field: record.kind === 'field' ? entryName(record) : undefined,
    button: record.kind === 'button' ? record.text : record.button?.text,
    target,
  });
}

// Write the records of one page that wait (REQ-039a).
async function flush(session, page) {
  const entry = session.discoveryState.pending.get(page);
  if (!entry?.records.length) return;
  const records = entry.records.splice(0);
  const url = records.find((record) => record.url)?.url;
  if (!url || !hostOfUrl(url)) return;

  // The fields of the user, and the last values of each (from a click or a submit).
  const fills = new Map();
  const values = new Map();
  const autoFilled = new Set();
  for (const record of records) {
    if (record.action === 'fill' && record.selector) {
      if (record.who === 'user') fills.set(record.selector, record);
      if (record.who === 'auto-fill') autoFilled.add(record.selector);
    }
    for (const [selector, value] of record.values ?? []) values.set(selector, value);
  }

  // The submit: a submit with a button of the user, else the last button click of the user.
  let submit;
  const formSubmit = records.findLast((record) => record.action === 'submit' && record.who === 'user');
  if (formSubmit) submit = formSubmit.button?.selector ?? (formSubmit.enter && !formSubmit.button ? 'enter' : undefined);
  if (!submit) submit = records.findLast((record) => record.action === 'press' && record.who === 'user' && record.selector)?.selector;
  if (!fills.size && !(autoFilled.size && submit)) return;

  // The keys of the values of the user. The values are discarded after this step.
  const ctx = { host: hostOfUrl(url), url, client: session.server?.getClientVersion?.()?.name };
  const keys = new Map();
  for (const [selector, record] of fills) {
    let key;
    if (values.has(selector)) {
      try {
        key = await session.fill.match(values.get(selector), ctx);
      } catch (error) {
        session.logger.error('discovery_match_error', { url, selector, message: error.message });
      }
    }
    keys.set(selector, { key, fallback: entryName(record) });
  }
  values.clear();
  for (const record of records) delete record.values;

  const link = fills.size && submit ? session.discoveryState.lastLink : undefined;
  const written = [];
  updateSites(session.fields.file, (data) => {
    // Only the form fill filled: the submit goes to its form, if there is one.
    const target = formEntry(nodeEntry(data, url), [...keys.keys(), ...autoFilled], keys.size > 0);
    for (const [selector, { key, fallback }] of target ? keys : []) {
      if (key !== undefined) {
        if (target.fields[selector] !== key) written.push(`${selector}=${key}`);
        target.fields[selector] = key;
      } else if (target.fields[selector] === undefined) {
        target.fields[selector] = fallback;
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
  if (link) session.discoveryState.lastLink = undefined;
  if (written.length) session.logger.info('fields_written', { url, written });
}

// The node of sites.json for the forms and the login links of a URL: the nearest node with a
// "provider-config", else the root domain. Make the root domain if it is missing (REQ-039a).
function nodeEntry(data, url) {
  const host = hostOfUrl(url);
  const chain = chainIn(data.sites, host);
  const configured = chain.findLast(({ node }) => node['provider-config']);
  if (configured) return configured.node;
  if (chain.length) return chain[0].node;
  return data.sites[rootDomain(host)] ??= {};
}

// The form of a node with one of the selectors, else a new form at the end if create is true
// (REQ-039a).
function formEntry(node, selectors, create) {
  let form = (node.forms ?? []).find((entry) => selectors.some((selector) => entry?.fields?.[selector] !== undefined));
  if (!form && !create) return undefined;
  if (!form) (node.forms ??= []).push(form = {});
  form.fields ??= {};
  return form;
}

// The name of a field without a key: username, password, email, otp, else its name.
function entryName(item) {
  if (item.kind === 'button') return 'submit';
  if (item.kind === 'link') return 'login';
  const tokens = (item.autocomplete ?? '').toLowerCase().split(/\s+/);
  if (tokens.includes('username')) return 'username';
  if (item.type === 'password' || tokens.includes('current-password') || tokens.includes('new-password')) return 'password';
  if (tokens.includes('one-time-code')) return 'otp';
  if (item.type === 'email' || tokens.includes('email')) return 'email';
  return (item.name ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
}
