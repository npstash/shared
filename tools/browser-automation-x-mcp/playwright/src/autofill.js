// Form fill without the agent: after a call, the server fills the fields of sites.json on the page
// and submits the form. The agent gets the page after the submit. See sdd/DESIGN.md.
// Before the fill, the server clicks a visible login link of the page ("login" in sites.json),
// one time for each lane and host, if a provider has a system for the host.
// The server runs the page code through browser_run_code_unsafe of upstream (see run-code.js).
// In the discovery mode, the server fills one time and does not submit: the user submits.
import { ApprovalError, FillError } from '../../src/fill/provider.js';

// The note for the agent after a refused approval. It does not name the form fill (REQ-005).
export const REFUSED_NOTE = 'The user did not approve an action on this page.';
import { runCode } from './run-code.js';

// Maximum time to wait for the fields of a page that matches sites.json.
export const FILL_WAIT = 10000;

// Maximum time to wait for the page after a submit (load, then network idle).
export const SUBMIT_WAIT = 10000;

// Maximum number of fill and submit rounds in one call, e.g. a username page, then a password page.
const FILL_ROUNDS = 3;

// The time between two checks for the fields.
const POLL_INTERVAL = 250;

// Page code: click the first visible login link, then wait for the next page. Give its selector.
async function clickLogin(page, { selectors, submitWait }) {
  for (const selector of selectors) {
    const link = page.locator(selector).first();
    if (!await link.isVisible().catch(() => false)) continue;
    const before = page.url();
    await link.click({ timeout: 5000 });
    await page.waitForURL((url) => url.href !== before, { timeout: submitWait }).catch(() => {});
    await page.waitForLoadState('load', { timeout: submitWait }).catch(() => {});
    return selector;
  }
  return null;
}

// Page code: wait up to data.wait ms for a visible field. Give the selectors of the visible fields.
async function findFields(page, { fields, wait, interval }) {
  const deadline = Date.now() + wait;
  for (;;) {
    const found = [];
    for (const field of fields) {
      for (const frame of page.frames()) {
        if (await frame.locator(field.selector).first().isVisible().catch(() => false)) {
          found.push(field.selector);
          break;
        }
      }
    }
    if (found.length || Date.now() >= deadline) return found;
    await page.waitForTimeout(interval);
  }
}

// Page code: fill the visible fields, submit, and wait for the page.
// Submit: the first entry of data.submits that applies: a visible element, or "enter" (Enter in the
// last field). Else requestSubmit() of the form of the last field, else Enter in the last field.
// data.submit false: fill only. The touched elements get __baxAuto for the recorder.
async function fillAndSubmit(page, { fields, submits, submitWait, submit }) {
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
  if (!submit) return { submitted: false, filled: true };
  let how;
  let button;
  for (const selector of submits) {
    if (selector === 'enter') {
      how = 'enter';
      break;
    }
    button = await visible(selector);
    if (button) {
      how = selector;
      break;
    }
  }
  if (button) {
    await markAuto(button);
    await button.click({ noWaitAfter: true });
  } else if (how === 'enter') {
    await last.press('Enter', { noWaitAfter: true });
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

// After a call: fill the fields of sites.json on the page and submit, in rounds.
// checkPage(url): the host check and record of a page; it gives { allowed, reason }.
// Give { submitted, blocked }: blocked is { url, check } when a page after a submit is not allowed.
// Errors go to the log only: the agent gets the result of its call. A refused approval also adds a
// note to the result.
export async function autofill(session, url, ctx, checkPage) {
  const { client, fields, fill, logger, fillState, discovery } = session;
  let submitted = false;
  let current = url;
  for (let round = 0; round < FILL_ROUNDS; round++) {
    const match = fields.match(current);
    if (!match) {
      fillState.attempts.clear();
      fillState.waitedUrl = undefined;
      break;
    }

    // The login link: one click for each lane and host. It does not count as a round.
    const host = ctx(current).host;
    if (match.logins.length && !fillState.loginClicked.has(host) && fill.canLogIn(ctx(current))) {
      let clicked;
      try {
        clicked = await runCode(client, clickLogin, { selectors: match.logins, submitWait: SUBMIT_WAIT });
      } catch (error) {
        logger.error('fill_error', { url: current, step: 'login', message: error.message });
      }
      if (clicked) {
        fillState.loginClicked.add(host);
        logger.info('login_clicked', { url: current, selector: clicked });
        current = await runCode(client, (page) => page.url(), null).catch(() => current);
        const check = await checkPage(current);
        if (!check.allowed) return { submitted, blocked: { url: current, check } };
        logger.info('page_opened', { url: current, via: 'auto_login' });
        submitted = true;
        round--;
        continue;
      }
    }
    if (!match.fields.length) break;

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
      // In the discovery mode, the server fills one time and the user submits: no failed fill.
      if (!fillState.failed.has(attempt) && !discovery) logger.info('fill_failed', { url: current, form: match.key, fields: found });
      fillState.failed.add(attempt);
      break;
    }
    fillState.attempts.add(attempt);

    const values = [];
    try {
      const visibleFields = match.fields.filter(({ selector }) => found.includes(selector));
      const resolved = await fill.resolveAll([...new Set(visibleFields.map(({ name }) => name))], ctx(current), { discovery });
      for (const field of visibleFields) {
        if (resolved.has(field.name)) values.push({ name: field.name, selector: field.selector, value: resolved.get(field.name) });
      }
    } catch (error) {
      if (!(error instanceof FillError)) throw error;
      logger.error('fill_error', { url: current, step: 'value', message: error.message });
      if (error instanceof ApprovalError) session.notes?.push(REFUSED_NOTE);
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
        submit: !discovery,
      });
    } catch (error) {
      logger.error('fill_error', { url: current, step: 'submit', message: fill.clean(error.message) });
      break;
    }
    if (outcome?.filled) logger.info('fill_filled', { url: current, form: match.key, fields: values.map(({ name }) => name), reason: 'discovery mode: no submit' });
    if (!outcome?.submitted) break;
    submitted = true;
    logger.info('fill_submitted', { url: current, form: match.key, fields: values.map(({ name }) => name), how: outcome.how });

    // The page after the submit gets the host check before each other step.
    current = await runCode(client, (page) => page.url(), null).catch(() => current);
    const check = await checkPage(current);
    if (!check.allowed) return { submitted, blocked: { url: current, check } };
    logger.info('page_opened', { url: current, via: 'auto_submit' });
  }
  return { submitted };
}
