// Form fill without the agent: after a call, the facade fills the fields of fields.ini on the page
// and submits the form. The agent gets the page after the submit. See sdd/DESIGN.md.
// The facade runs the page code through browser_run_code_unsafe of upstream. The tool switch of
// the agent does not apply to these calls, and their results never go to the agent.
import fs from 'node:fs';
import path from 'node:path';
import { FillError } from '../../src/fill/provider.js';
import { urlPattern } from '../../src/fill/fields.js';
import { writeFileAtomic } from '../../src/ini.js';
import { ASSETS_DIR } from '../../src/paths.js';

// Maximum time to wait for the fields of a page that matches fields.ini.
export const FILL_WAIT = 10000;

// Maximum time to wait for the page after a submit (load, then network idle).
export const SUBMIT_WAIT = 10000;

// Maximum number of fill and submit rounds in one call, e.g. a username page, then a password page.
const FILL_ROUNDS = 3;

// The time between two checks for the fields.
const POLL_INTERVAL = 250;

const RUN_CODE = 'browser_run_code_unsafe';
const CALL_TIMEOUT = FILL_WAIT + 2 * SUBMIT_WAIT + 30000;

export const DISCOVERED_FILE = path.join(ASSETS_DIR, 'discovered-fields.ini');

// Run a function (page) => value in the page of upstream. Give the value.
async function runCode(client, fn, data) {
  const code = `async (page) => (${fn.toString()})(page, ${JSON.stringify(data)})`;
  const result = await client.callTool({ name: RUN_CODE, arguments: { code } }, undefined, { timeout: CALL_TIMEOUT });
  const text = result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '';
  if (result.isError) throw new Error(text.replace(/### Ran Playwright code[\s\S]*$/, '').slice(0, 500));
  const match = text.match(/### Result\n([\s\S]*?)(\n### |$)/);
  return match ? JSON.parse(match[1].trim()) : undefined;
}

// Page code: wait up to data.wait ms for a visible field. Give the names of the visible fields.
async function findFields(page, { fields, wait, interval }) {
  const deadline = Date.now() + wait;
  for (;;) {
    const found = [];
    for (const field of fields) {
      for (const frame of page.frames()) {
        if (await frame.locator(field.selector).first().isVisible().catch(() => false)) {
          found.push(field.name);
          break;
        }
      }
    }
    if (found.length || Date.now() >= deadline) return found;
    await page.waitForTimeout(interval);
  }
}

// Page code: fill the visible fields, submit, and wait for the page.
// Submit: data.submit (a selector) if visible, else requestSubmit() of the form of the last field,
// else Enter in the last field.
async function fillAndSubmit(page, { fields, submit, submitWait }) {
  const visible = async (selector) => {
    for (const frame of page.frames()) {
      const locator = frame.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    return undefined;
  };
  let last;
  for (const field of fields) {
    const locator = await visible(field.selector);
    if (!locator) continue;
    await locator.fill(field.value);
    last = locator;
  }
  if (!last) return { submitted: false };
  let how;
  const button = submit ? await visible(submit) : undefined;
  if (button) {
    await button.click({ noWaitAfter: true });
    how = 'submit selector';
  } else if (await last.evaluate((el) => (el.form ? (el.form.requestSubmit(), true) : false))) {
    how = 'requestSubmit';
  } else {
    await last.press('Enter', { noWaitAfter: true });
    how = 'Enter';
  }
  await page.waitForTimeout(500);
  await page.waitForLoadState('load', { timeout: submitWait }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: submitWait }).catch(() => {});
  return { submitted: true, how };
}

// Page code: the visible input fields of each frame, with a selector that is unique in its frame.
// The selector uses autocomplete, then name, then an id that does not look generated, then the type.
async function listFields(page) {
  const out = [];
  for (const frame of page.frames()) {
    const items = await frame.evaluate(() => {
      const SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color']);
      const visible = (el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const unique = (selector) => {
        try {
          return document.querySelectorAll(selector).length === 1;
        } catch {
          return false;
        }
      };
      const generated = (id) => /\d{3,}|:|^[a-f0-9]{8,}$/i.test(id);
      return [...document.querySelectorAll('input, textarea, select')]
        .filter((el) => !SKIP.has((el.getAttribute('type') ?? '').toLowerCase()) && visible(el))
        .map((el) => {
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') ?? '').toLowerCase();
          const autocomplete = (el.getAttribute('autocomplete') ?? '').trim();
          const candidates = [];
          if (autocomplete && !['on', 'off'].includes(autocomplete.toLowerCase())) candidates.push(`${tag}[autocomplete=${JSON.stringify(autocomplete)}]`);
          if (el.name) candidates.push(`${tag}[name=${JSON.stringify(el.name)}]`);
          if (el.id && !generated(el.id)) candidates.push(`#${CSS.escape(el.id)}`);
          if (type === 'password' || type === 'email') candidates.push(`input[type="${type}"]`);
          const label = (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
            .trim().replace(/\s+/g, ' ').slice(0, 80);
          return { tag, type, autocomplete, name: el.name ?? '', label, selector: candidates.find(unique) };
        });
    }).catch(() => []);
    for (const item of items) out.push({ ...item, frame: frame === page.mainFrame() ? '' : frame.url() });
  }
  return out;
}

// After a call: fill the fields of fields.ini on the page and submit, in rounds. Give the snapshot
// result of the page after the last submit, or undefined if the facade did not submit.
// Errors go to the log only: the agent gets the result of its call.
export async function autofill(session, url, ctx) {
  const { client, fields, fill, logger, fillState } = session;
  let submitted = false;
  let current = url;
  for (let round = 0; round < FILL_ROUNDS; round++) {
    const match = fields.match(current);
    if (!match) {
      fillState.attempts.clear();
      fillState.waitedUrl = undefined;
      break;
    }
    // Wait for the fields only once for each URL, and after each submit.
    const wait = submitted || fillState.waitedUrl !== current ? FILL_WAIT : 0;
    fillState.waitedUrl = current;
    let found;
    try {
      found = await runCode(client, findFields, { fields: match.fields, wait, interval: POLL_INTERVAL });
    } catch (error) {
      logger.error('fill_error', { url: current, step: 'find', message: error.message });
      break;
    }
    if (!found?.length) break;

    // The loop guard: each form and field set gets one fill until the page leaves the form.
    const attempt = `${match.key}\n${[...found].sort().join(',')}`;
    if (fillState.attempts.has(attempt)) {
      if (!fillState.failed.has(attempt)) logger.info('fill_failed', { url: current, form: match.key, fields: found });
      fillState.failed.add(attempt);
      break;
    }
    fillState.attempts.add(attempt);

    const values = [];
    try {
      for (const field of match.fields.filter(({ name }) => found.includes(name))) {
        const value = await fill.resolve(field.name, ctx(current));
        if (value !== undefined) values.push({ selector: field.selector, value });
      }
    } catch (error) {
      if (!(error instanceof FillError)) throw error;
      logger.error('fill_error', { url: current, step: 'value', message: error.message });
      break;
    }
    if (!values.length) {
      logger.info('fill_no_value', { url: current, form: match.key, fields: found });
      break;
    }
    let outcome;
    try {
      outcome = await runCode(client, fillAndSubmit, { fields: values, submit: match.submit, submitWait: SUBMIT_WAIT });
    } catch (error) {
      logger.error('fill_error', { url: current, step: 'submit', message: fill.clean(error.message) });
      break;
    }
    if (!outcome?.submitted) break;
    submitted = true;
    logger.info('fill_submitted', { url: current, form: match.key, fields: found, how: outcome.how });
    current = await runCode(client, (page) => page.url(), null).catch(() => current);
  }
  if (!submitted) return undefined;
  return client.callTool({ name: 'browser_snapshot', arguments: {} }, undefined, { timeout: CALL_TIMEOUT });
}

// Discovery mode: write the input fields of the page into DISCOVERED_FILE, one section for each
// URL pattern. A later visit of the same pattern replaces its section.
export async function discover(session, url) {
  const { client, logger } = session;
  let items;
  try {
    items = await runCode(client, listFields, null);
  } catch (error) {
    logger.error('discover_error', { url, message: error.message });
    return;
  }
  if (!items?.length) return;
  const pattern = urlPattern(url);
  const used = new Map();
  const lines = [];
  for (const item of items) {
    const info = [item.tag, item.type && `type=${item.type}`, item.autocomplete && `autocomplete=${item.autocomplete}`,
      item.name && `name=${item.name}`, item.label && `label="${item.label}"`, item.frame && `frame=${item.frame}`].filter(Boolean).join(' ');
    lines.push(`; ${info}`);
    if (!item.selector) {
      lines.push('; no unique selector');
      continue;
    }
    const base = fieldName(item);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    lines.push(`${count > 1 ? `${base}_${count}` : base} = ${item.selector}`);
  }
  writeSection(DISCOVERED_FILE, pattern, lines);
  logger.info('fields_discovered', { url, pattern, count: items.length, file: DISCOVERED_FILE });
}

// A proposed field name: username, password, email, otp, else the name attribute.
function fieldName({ type, autocomplete, name }) {
  const tokens = autocomplete.toLowerCase().split(/\s+/);
  if (tokens.includes('username')) return 'username';
  if (type === 'password' || tokens.includes('current-password') || tokens.includes('new-password')) return 'password';
  if (tokens.includes('one-time-code')) return 'otp';
  if (type === 'email' || tokens.includes('email')) return 'email';
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
}

const DISCOVERED_HEADER = [
  '# Input fields that the discovery mode found. One section for each URL pattern.',
  '# Copy the lines of a login form into fields.ini of the config folder. See README.md.',
];

// Replace or add one section in an INI file. The comment lines of each section stay.
function writeSection(file, name, lines) {
  const sections = [];
  let current;
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const raw of text.split(/\r?\n/)) {
    const header = raw.trim().match(/^\[(.+)\]$/);
    if (header) {
      current = { name: header[1], lines: [] };
      sections.push(current);
    } else if (current && raw.trim()) {
      current.lines.push(raw);
    }
  }
  const existing = sections.find((section) => section.name === name);
  if (existing) existing.lines = lines;
  else sections.push({ name, lines });
  const body = sections.map((section) => [`[${section.name}]`, ...section.lines].join('\n'));
  writeFileAtomic(file, [DISCOVERED_HEADER.join('\n'), ...body].join('\n\n') + '\n');
}
