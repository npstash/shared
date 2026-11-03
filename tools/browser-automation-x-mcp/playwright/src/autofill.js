// Form fill without the agent: after a call, the server fills the fields of fields.ini on the page
// and submits the form. The agent gets the page after the submit. See sdd/DESIGN.md.
// The server runs the page code through browser_run_code_unsafe of upstream (see run-code.js).
import { FillError } from '../../src/fill/provider.js';
import { DISCOVER_WAIT, discover } from './discover.js';
import { runCode } from './run-code.js';

// Maximum time to wait for the fields of a page that matches fields.ini.
export const FILL_WAIT = 10000;

// Maximum time to wait for the page after a submit (load, then network idle).
export const SUBMIT_WAIT = 10000;

// Maximum number of fill and submit rounds in one call, e.g. a username page, then a password page.
const FILL_ROUNDS = 3;

// The time between two checks for the fields.
const POLL_INTERVAL = 250;

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
// Submit: the first visible element of data.submits, else requestSubmit() of the form of the last
// field, else Enter in the last field. The touched elements get __baxAuto for the recorder.
async function fillAndSubmit(page, { fields, submits, submitWait }) {
  const visible = async (selector) => {
    for (const frame of page.frames()) {
      const locator = frame.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    return undefined;
  };
  const markAuto = (locator) => locator.evaluate((el) => {
    el.__baxAuto = true;
    if (el.form) el.form.__baxAuto = true;
  }).catch(() => {});
  let last;
  for (const field of fields) {
    const locator = await visible(field.selector);
    if (!locator) continue;
    await markAuto(locator);
    await locator.fill(field.value);
    last = locator;
  }
  if (!last) return { submitted: false };
  let how;
  let button;
  for (const selector of submits) {
    button = await visible(selector);
    if (button) {
      how = selector;
      break;
    }
  }
  if (button) {
    await markAuto(button);
    await button.click({ noWaitAfter: true });
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

// After a call: fill the fields of fields.ini on the page and submit, in rounds.
// checkPage(url): the host check and record of a page; it gives { allowed, reason }.
// Give { submitted, blocked }: blocked is { url, check } when a page after a submit is not allowed.
// Errors go to the log only: the agent gets the result of its call.
export async function autofill(session, url, ctx, checkPage) {
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
        if (value !== undefined) values.push({ name: field.name, selector: field.selector, value });
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
      outcome = await runCode(client, fillAndSubmit, {
        fields: values.map(({ selector, value }) => ({ selector, value })),
        submits: match.submits,
        submitWait: SUBMIT_WAIT,
      });
    } catch (error) {
      logger.error('fill_error', { url: current, step: 'submit', message: fill.clean(error.message) });
      break;
    }
    if (!outcome?.submitted) break;
    submitted = true;
    logger.info('fill_submitted', { url: current, form: match.key, fields: values.map(({ name }) => name), how: outcome.how });

    // The page after the submit gets the host check before each other step.
    current = await runCode(client, (page) => page.url(), null).catch(() => current);
    const check = await checkPage(current);
    if (!check.allowed) return { submitted, blocked: { url: current, check } };
    logger.info('page_opened', { url: current, via: 'auto_submit' });
    if (session.discovery) await discover(session, current, { wait: DISCOVER_WAIT });
  }
  return { submitted };
}
