// Discovery mode (BROWSER_AUTOMATION_X_MCP_DISCOVER=1). See README.md, section "Discovery".
// - discover(): write the visible fields and buttons of a page into DISCOVERED_FILE. One section for
//   each URL pattern. Discovery adds only new selectors to a section. It never removes a line.
// - syncRecorder(): get the fills, button clicks and submits in the browser since the last call:
//   of the user, of the agent and of the form fill. Log them and mark the entries with "; used: ...".
// The values of the fields are never recorded.
import fs from 'node:fs';
import path from 'node:path';
import { urlPattern } from '../../src/fill/fields.js';
import { writeFileAtomic } from '../../src/ini.js';
import { ASSETS_DIR } from '../../src/paths.js';
import { pageLib } from './page-lib.js';
import { runCode } from './run-code.js';

export const DISCOVERED_FILE = path.join(ASSETS_DIR, 'discovered-fields.ini');

// Maximum time to wait for a field or a button after a submit.
export const DISCOVER_WAIT = 5000;

// An event of the agent comes in the time of its call, or this much later.
const AGENT_SLACK = 500;

const POLL_INTERVAL = 250;
const LIB = pageLib.toString();

const HEADER = [
  '# Fields and buttons that the discovery mode found. One section for each URL pattern.',
  '# "; used: ..." marks a field or button that the user, the agent or the auto-fill used.',
  '# Copy the used lines into fields.ini of the config folder. See README.md.',
];

// Page code: the fields and buttons of each frame. Wait up to data.wait ms for one.
// Each Playwright locator must find one element, else the item has no selector.
async function listItems(page, { lib, wait, interval }) {
  const deadline = Date.now() + wait;
  for (;;) {
    const out = [];
    for (const frame of page.frames()) {
      const items = await frame.evaluate(`(${lib})().discover()`).catch(() => []);
      for (const item of items) {
        if (item.selector && !item.css && await frame.locator(item.selector).count().catch(() => 0) !== 1) item.selector = undefined;
        out.push({ ...item, frame: frame === page.mainFrame() ? '' : frame.url() });
      }
    }
    if (out.length || Date.now() >= deadline) return out;
    await page.waitForTimeout(interval);
  }
}

// Page code: install the recorder in the browser context one time, and give its events.
// The events stay on the context object: they survive a new page.
async function takeEvents(page, { lib }) {
  const context = page.context();
  let state = context.__baxRecorder;
  if (!state) {
    state = { events: [] };
    context.__baxRecorder = state;
    const script = `(${lib})().installRecorder()`;
    await context.exposeBinding('__baxRecord', (source, event) => {
      const pageUrl = source.page?.url() ?? source.frame?.url();
      const frame = source.page && source.frame !== source.page.mainFrame() ? source.frame.url() : '';
      state.events.push({ ...event, url: pageUrl, frame });
    });
    await context.addInitScript({ content: script });
    for (const each of context.pages()) {
      for (const frame of each.frames()) await frame.evaluate(script).catch(() => {});
    }
  }
  return state.events.splice(0);
}

// Discover the page. wait: maximum ms to wait for a field or a button.
export async function discover(session, url, { wait = 0 } = {}) {
  const { client, logger } = session;
  let items;
  try {
    items = await runCode(client, listItems, { lib: LIB, wait, interval: POLL_INTERVAL }) ?? [];
  } catch (error) {
    logger.error('discover_error', { url, message: error.message });
    return;
  }
  if (!items.length) return;
  const pattern = urlPattern(url);
  const added = updateSection(pattern, (section) => items.flatMap((item) => (section.add(item) ? [item] : [])));
  if (added.length) {
    logger.info('fields_discovered', { url, pattern, new: added.map((item) => `${entryKey(item)}=${item.selector ?? '?'}`) });
  } else {
    logger.debug('fields_known', { url, pattern });
  }
}

// Get the recorded events, log them, and mark the used entries. Give true if the user submitted.
export async function syncRecorder(session) {
  const { client, logger } = session;
  let events;
  try {
    events = await runCode(client, takeEvents, { lib: LIB }) ?? [];
  } catch (error) {
    logger.error('record_error', { message: error.message });
    return false;
  }
  let userSubmitted = false;
  for (const event of events) {
    const who = event.auto ? 'auto-fill' : session.agentCalls.some(({ start, end }) => event.ts >= start && event.ts <= (end ?? Infinity) + AGENT_SLACK) ? 'agent' : 'user';
    if (who === 'user' && event.action !== 'fill') userSubmitted = true;
    if (who !== 'auto-fill') {
      const verb = { fill: 'filled', press: 'pressed', submit: 'submitted' }[event.action];
      logger.info(`${who}_${verb}`, { url: event.url, selector: event.selector, field: event.kind === 'field' ? entryKey(event) : undefined, button: event.text });
    }
    if (!event.selector || !event.url) continue;
    let pattern;
    try {
      pattern = urlPattern(event.url);
    } catch {
      continue;
    }
    const mark = `; used: ${event.action === 'fill' ? 'filled' : 'pressed'} by ${who}`;
    updateSection(pattern, (section) => section.mark(event, mark));
  }
  return userSubmitted;
}

// The key of an entry: submit for a button; for a field username, password, email, otp, else its name.
function entryKey(item) {
  if (item.kind === 'button') return 'submit';
  const tokens = (item.autocomplete ?? '').toLowerCase().split(/\s+/);
  if (tokens.includes('username')) return 'username';
  if (item.type === 'password' || tokens.includes('current-password') || tokens.includes('new-password')) return 'password';
  if (tokens.includes('one-time-code')) return 'otp';
  if (item.type === 'email' || tokens.includes('email')) return 'email';
  return (item.name ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
}

// The comment line that describes an item.
function describe(item) {
  const parts = item.kind === 'button'
    ? ['button', item.text && `"${item.text}"`, item.tag, item.type && `type=${item.type}`, item.id && `id=${item.id}`]
    : [item.tag, item.type && `type=${item.type}`, item.autocomplete && `autocomplete=${item.autocomplete}`,
      item.name && `name=${item.name}`, item.label && `label="${item.label}"`];
  if (item.frame) parts.push(`frame=${item.frame}`);
  return `; ${parts.filter(Boolean).join(' ')}`;
}

const ENTRY = /^\s*([^;#\s][^=]*?)\s*=\s*(.*)$/;

// The lines of one section, with the operations of discovery and of the recorder.
class Section {
  constructor(lines) {
    this.lines = lines;
  }

  entries() {
    return this.lines.map((line, index) => ({ index, match: line.match(ENTRY) })).filter(({ match }) => match);
  }

  // Add an item that the section does not have. Give true if the section changed.
  add(item) {
    const description = describe(item);
    if (!item.selector) {
      if (this.lines.includes(description)) return false;
      this.lines.push(description, '; no unique selector');
      return true;
    }
    if (this.entries().some(({ match }) => match[2] === item.selector)) return false;
    const base = entryKey(item);
    const keys = new Set(this.entries().map(({ match }) => match[1]));
    let key = base;
    for (let count = 2; item.kind !== 'button' && keys.has(key); count++) key = `${base}_${count}`;
    this.lines.push(description, `${key} = ${item.selector}`);
    return true;
  }

  // Put the mark above the entry of the item. Add the entry first if it is missing.
  mark(item, mark) {
    let entry = this.entries().find(({ match }) => match[2] === item.selector);
    if (!entry) {
      this.add(item);
      entry = this.entries().find(({ match }) => match[2] === item.selector);
    }
    for (let i = entry.index - 1; i >= 0 && !ENTRY.test(this.lines[i]); i--) {
      if (this.lines[i] === mark) return false;
    }
    this.lines.splice(entry.index, 0, mark);
    return true;
  }
}

// Change one section of DISCOVERED_FILE. change(section) gives a value; a truthy value or a
// non-empty array writes the file.
function updateSection(name, change) {
  const sections = [];
  let current;
  const text = fs.existsSync(DISCOVERED_FILE) ? fs.readFileSync(DISCOVERED_FILE, 'utf8') : '';
  for (const raw of text.split(/\r?\n/)) {
    const header = raw.trim().match(/^\[(.+)\]$/);
    if (header) {
      current = { name: header[1], lines: [] };
      sections.push(current);
    } else if (current && raw.trim()) {
      current.lines.push(raw);
    }
  }
  let target = sections.find((section) => section.name === name);
  if (!target) {
    target = { name, lines: [] };
    sections.push(target);
  }
  const result = change(new Section(target.lines));
  if (Array.isArray(result) ? result.length : result) {
    const body = sections.filter((section) => section.lines.length).map((section) => [`[${section.name}]`, ...section.lines].join('\n'));
    writeFileAtomic(DISCOVERED_FILE, [HEADER.join('\n'), ...body].join('\n\n') + '\n');
  }
  return result;
}
