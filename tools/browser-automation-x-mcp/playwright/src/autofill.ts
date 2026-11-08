// Form fill without the agent: after a call, the server fills the fields of sites.json on the page
// and submits the form. The agent gets the page after the submit. See sdd/DESIGN.md.
// A form of sites.json applies on each page of the host where one of its fields is visible.
// Before the fill, the server clicks a visible login link ("login" in sites.json), one time for
// each lane and host, if a provider has a system for the host. After the login flow, the server
// opens again the URL where it clicked the link, but not in the discovery mode.
// The server runs the page code through browser_run_code_unsafe of upstream (see run-code.ts).
// In the discovery mode, the server fills one time and does not submit: the user submits.
import type { Locator, Page } from 'playwright-core';
import type { FillContext } from '../../src/fill/provider.ts';
import { ApprovalError, FillError } from '../../src/fill/provider.ts';
import type { FillValues } from '../../src/fill/registry.ts';
import type { HostCheck } from '../../src/hosts/host-policy.ts';
import { errorMessage } from '../../src/json.ts';
import type { Logger } from '../../src/logger.ts';
import type { FormField, FormMatch, SiteTree } from '../../src/sites.ts';
import type { LaneSession } from './session.ts';

// The note for the agent after a refused approval. It does not name the form fill (REQ-005).
export const REFUSED_NOTE: string = 'The user did not approve an action on this page.';

// Maximum time to wait for a form field after a login click or a submit (in a login flow).
export const FLOW_WAIT: number = 3000;

// Maximum time to wait for a form field on an other page, one time for each URL.
export const PEEK_WAIT: number = 3000;

// Maximum time to wait for the page after a submit (load, then network idle).
export const SUBMIT_WAIT: number = 10000;

// Maximum number of fill and submit rounds in one call, e.g. a username page, then a password page.
const FILL_ROUNDS: number = 3;

// The time between two checks for the fields.
const POLL_INTERVAL: number = 250;

// The check of the host of a page after a submit or a click: it records the page.
export type CheckPage = (url: string) => Promise<HostCheck>;

// The fill context of a page (see src/fill/provider.ts).
export type ContextOf = (url: string) => FillContext;

// The end of the form fill of one call.
export interface FillOutcome {
  // True if the server submitted a form or clicked a login link.
  readonly submitted: boolean;
  // The page after a submit that is not allowed.
  readonly blocked?: { readonly url: string; readonly check: HostCheck };
}

// The form fill after a call.
export interface FormFill {
  // Fill the fields of sites.json on the page and submit, in rounds. Errors go to the log only:
  // the agent gets the result of its call. A refused approval also adds a note to the result.
  run(lane: LaneSession, url: string, contextOf: ContextOf, checkPage: CheckPage): Promise<FillOutcome>;
}

interface ClickLoginData {
  readonly selectors: readonly string[];
  readonly submitWait: number;
}

interface FindFieldsData {
  readonly fields: readonly { readonly selector: string }[];
  readonly wait: number;
  readonly interval: number;
}

interface FillData {
  readonly fields: readonly { readonly selector: string; readonly value: string }[];
  readonly submits: readonly string[];
  readonly submitWait: number;
  readonly submit: boolean;
}

interface FillResult {
  readonly submitted: boolean;
  readonly filled?: boolean;
  readonly how?: string;
}

// A field with its value.
interface FieldValue {
  readonly name: string;
  readonly selector: string;
  readonly value: string;
}

// Page code: click the first visible login link, then wait for the next page. Give its selector.
async function clickLogin(page: Page, { selectors, submitWait }: ClickLoginData): Promise<string | null> {
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
async function findFields(page: Page, { fields, wait, interval }: FindFieldsData): Promise<string[]> {
  const deadline = Date.now() + wait;
  for (;;) {
    const found: string[] = [];
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
async function fillAndSubmit(page: Page, { fields, submits, submitWait, submit }: FillData): Promise<FillResult> {
  const visible = async (selector: string): Promise<Locator | undefined> => {
    for (const frame of page.frames()) {
      const locator = frame.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    return undefined;
  };
  const markAuto = (locator: Locator): Promise<void> => locator.evaluate((el) => {
    el.__baxAuto = true;
    const form = 'form' in el && el.form instanceof HTMLFormElement ? el.form : undefined;
    if (form) form.__baxAuto = true;
  }).catch(() => {});
  let last: Locator | undefined;
  for (const field of fields) {
    const locator = await visible(field.selector);
    if (!locator) continue;
    await markAuto(locator);
    await locator.fill(field.value);
    last = locator;
  }
  if (!last) return { submitted: false };
  if (!submit) return { submitted: false, filled: true };
  let how: string | undefined;
  let button: Locator | undefined;
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
  } else if (await last.evaluate((el) => {
    const form = 'form' in el && el.form instanceof HTMLFormElement ? el.form : undefined;
    if (!form) return false;
    form.requestSubmit();
    return true;
  })) {
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

// The URL of the current page of upstream.
function currentUrl(page: Page): string {
  return page.url();
}

export interface AutoFillOptions {
  readonly sites: SiteTree;
  readonly fill: FillValues;
  readonly logger: Logger;
  // The discovery mode: fill one time, without a submit.
  readonly discovery: boolean;
}

export class AutoFill implements FormFill {
  private readonly sites: SiteTree;
  private readonly fill: FillValues;
  private readonly logger: Logger;
  private readonly discovery: boolean;

  constructor({ sites, fill, logger, discovery }: AutoFillOptions) {
    this.sites = sites;
    this.fill = fill;
    this.logger = logger;
    this.discovery = discovery;
  }

  async run(lane: LaneSession, url: string, contextOf: ContextOf, checkPage: CheckPage): Promise<FillOutcome> {
    const { fill, logger, discovery } = this;
    const { fillState, pageCode } = lane;
    let submitted = false;
    let current = url;
    // The URL where the server clicked the login link.
    let loginFrom: string | undefined;
    const pageUrl = (): Promise<string> => pageCode.run(currentUrl, null).catch(() => current);
    for (let round = 0; round < FILL_ROUNDS; round++) {
      const match = this.sites.match(current);
      if (!match) {
        fillState.attempts.clear();
        fillState.waitedUrl = undefined;
        break;
      }

      // The login link: one click for each lane and host. It does not count as a round.
      const host = contextOf(current).host ?? '';
      if (match.logins.length && !fillState.loginClicked.has(host) && fill.canLogIn(contextOf(current))) {
        let clicked: string | null = null;
        try {
          clicked = await pageCode.run(clickLogin, { selectors: match.logins, submitWait: SUBMIT_WAIT });
        } catch (error) {
          logger.error('fill_error', { url: current, step: 'login', message: errorMessage(error) });
        }
        if (clicked) {
          fillState.loginClicked.add(host);
          logger.info('login_clicked', { url: current, selector: clicked });
          loginFrom = current;
          current = await pageUrl();
          const check = await checkPage(current);
          if (!check.allowed) return { submitted, blocked: { url: current, check } };
          logger.info('page_opened', { url: current, via: 'auto_login' });
          submitted = true;
          round--;
          continue;
        }
      }
      const selectors = [...new Set(match.forms.flatMap((form) => form.fields.map(({ selector }) => selector)))];
      if (!selectors.length) break;

      // In a login flow (after a login click or a submit), wait FLOW_WAIT. Else wait PEEK_WAIT once
      // for each URL.
      const wait = submitted ? FLOW_WAIT : fillState.waitedUrl !== current ? PEEK_WAIT : 0;
      fillState.waitedUrl = current;
      let found: string[];
      try {
        found = await pageCode.run(findFields, { fields: selectors.map((selector) => ({ selector })), wait, interval: POLL_INTERVAL });
      } catch (error) {
        logger.error('fill_error', { url: current, step: 'find', message: errorMessage(error) });
        break;
      }
      if (!found?.length) {
        // The page left the forms: a later page can get a fill again.
        fillState.attempts.clear();
        if (submitted) logger.info('fill_no_field', { url: current, waited: wait, selectors });
        break;
      }

      // The form with the most visible fields; on a tie, the first one.
      const form = match.forms.reduce<{ form: FormMatch | undefined; count: number }>((best, candidate) => {
        const count = candidate.fields.filter(({ selector }) => found.includes(selector)).length;
        return count > best.count ? { form: candidate, count } : best;
      }, { form: undefined, count: 0 }).form;
      if (!form) break;
      const visibleFields: readonly FormField[] = form.fields.filter(({ selector }) => found.includes(selector));
      const shown = visibleFields.map(({ selector }) => selector);

      // The loop guard: each form and field set gets one fill until the page leaves the forms.
      const attempt = `${form.key}\n${[...shown].sort().join(',')}`;
      if (fillState.attempts.has(attempt)) {
        // In the discovery mode, the server fills one time and the user submits: no failed fill.
        if (!fillState.failed.has(attempt) && !discovery) logger.info('fill_failed', { url: current, form: form.key, fields: shown });
        fillState.failed.add(attempt);
        break;
      }
      fillState.attempts.add(attempt);

      const values: FieldValue[] = [];
      try {
        const resolved = await fill.resolveAll([...new Set(visibleFields.map(({ name }) => name))], contextOf(current), { discovery });
        for (const field of visibleFields) {
          const value = resolved.get(field.name);
          if (value !== undefined) values.push({ name: field.name, selector: field.selector, value });
        }
      } catch (error) {
        if (!(error instanceof FillError)) throw error;
        logger.error('fill_error', { url: current, step: 'value', message: error.message });
        if (error instanceof ApprovalError) lane.notes.push(REFUSED_NOTE);
        break;
      }
      if (!values.length) {
        logger.info('fill_no_value', { url: current, form: form.key, fields: shown });
        break;
      }
      let outcome: FillResult;
      try {
        outcome = await pageCode.run(fillAndSubmit, {
          fields: values.map(({ selector, value }) => ({ selector, value })),
          submits: form.submits,
          submitWait: SUBMIT_WAIT,
          submit: !discovery,
        });
      } catch (error) {
        logger.error('fill_error', { url: current, step: 'submit', message: fill.clean(errorMessage(error)) });
        break;
      }
      if (outcome?.filled) logger.info('fill_filled', { url: current, form: form.key, fields: values.map(({ name }) => name), reason: 'discovery mode: no submit' });
      if (!outcome?.submitted) break;
      submitted = true;
      logger.info('fill_submitted', { url: current, form: form.key, fields: values.map(({ name }) => name), how: outcome.how });

      // The page after the submit gets the host check before each other step.
      current = await pageUrl();
      const check = await checkPage(current);
      if (!check.allowed) return { submitted, blocked: { url: current, check } };
      logger.info('page_opened', { url: current, via: 'auto_submit' });
    }

    // After the login flow, open again the URL of the login click, also after a failed login. Not in
    // the discovery mode: the user submits.
    if (loginFrom && !discovery && current !== loginFrom) {
      try {
        await pageCode.run(async (page: Page, { target, wait }: { target: string; wait: number }): Promise<void> => {
          await page.goto(target, { timeout: wait });
        }, { target: loginFrom, wait: SUBMIT_WAIT });
      } catch (error) {
        logger.error('fill_error', { url: current, step: 'return', message: errorMessage(error) });
      }
      current = await pageUrl();
      const check = await checkPage(current);
      if (!check.allowed) return { submitted, blocked: { url: current, check } };
      logger.info('page_opened', { url: current, via: 'login_return' });
    }
    return { submitted };
  }
}
