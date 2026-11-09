// Form fill without the agent (REQ-030, REQ-030a, REQ-038 of sdd/SRS.md): after a call, the server
// runs the dom-classifiers on the page, gets the keys of the fields from the match-strategies and
// the values from the key-value-sources, fills the fields and runs the submit method. The agent
// gets the page after the submit. The server has no code that finds fields: the plugins do this.
// Before the fill, the server clicks a visible login link of a dom-classifier, one time for each
// lane and host, if a key-value-source has keys for the page. After the login flow, the server
// opens again the URL where it clicked the link.
// The page code runs through browser_run_code_unsafe of upstream (see page-code.ts, run-code.ts).
import type { Page } from 'playwright-core';
import type { HostCheck } from '../../src/hosts/host-policy.ts';
import type { JsonValue } from '../../src/json.ts';
import { errorMessage } from '../../src/json.ts';
import type { Logger } from '../../src/logger.ts';
import type { Dialog } from '../../src/plugins/approval-plugin.ts';
import type { DomClassifier } from '../../src/plugins/dom-classifier.ts';
import type { Named, ValueService } from '../../src/plugins/host.ts';
import { ApprovalError, FillError } from '../../src/plugins/host.ts';
import type { FieldMatch, MatchStrategy } from '../../src/plugins/match-strategy.ts';
import { pageInfo } from '../../src/plugins/page-info.ts';
import type { PageInfo } from '../../src/plugins/plugin.ts';
import type { ClassifierRun, PageClassification, RefField, RefSubmit } from './page-code.ts';
import { classifyPage, clickRef, currentUrl, fillRefs } from './page-code.ts';
import type { LaneSession } from './session.ts';

// The note for the agent after a refused approval. It does not name the form fill (REQ-005).
export const REFUSED_NOTE: string = 'The user did not approve an action on this page.';

// Maximum time to wait for a form field after a login click or a submit (in a login flow).
export const FLOW_WAIT: number = 3000;

// Maximum time to wait until an other page settles, one time for each URL.
export const PEEK_WAIT: number = 3000;

// A page is settled after this time without a change of the DOM.
export const SETTLE_QUIET: number = 300;

// Maximum time to wait for the page after a submit (load, then network idle).
export const SUBMIT_WAIT: number = 10000;

// Maximum number of fill and submit rounds in one call, e.g. a username page, then a password page.
const FILL_ROUNDS: number = 3;

// The time between two checks for the fields or for the changes of the DOM.
export const POLL_INTERVAL: number = 100;

// The check of the host of a page after a submit or a click: it records the page.
export type CheckPage = (url: string) => Promise<HostCheck>;

// The client of a fill: its name and its dialog.
export interface FillClient {
  readonly name: string | undefined;
  readonly dialog: Dialog | undefined;
}

// The end of the form fill of one call.
export interface FillOutcome {
  // True if the server submitted a form or clicked a login link.
  readonly submitted: boolean;
  // The page after a submit that is not allowed.
  readonly blocked?: { readonly url: string; readonly check: HostCheck };
}

// The form fill after a call.
export interface FormFill {
  // Fill and submit the classified fields of the page, in rounds. Errors go to the log only: the
  // agent gets the result of its call. A refused approval also adds a note to the result.
  run(lane: LaneSession, url: string, client: FillClient, checkPage: CheckPage): Promise<FillOutcome>;
}

// A field with its key.
interface KeyedField {
  readonly ref: string;
  readonly key: string;
}

// The fields and the submit method of one fill (REQ-030 step 3).
interface FillPlan {
  readonly fields: readonly KeyedField[];
  readonly submit: RefSubmit | undefined;
}

export interface AutoFillOptions {
  readonly classifiers: readonly Named<DomClassifier<JsonValue>>[];
  readonly strategies: readonly Named<MatchStrategy>[];
  readonly values: ValueService;
  readonly logger: Logger;
}

// The submit method that serves the most fields with a key; on a tie, the first one. The fields of
// the fill are the fields that it serves; without a method, all fields with a key (REQ-030).
export function planFill(fields: readonly KeyedField[], submits: readonly RefSubmit[]): FillPlan {
  let best: { submit: RefSubmit; count: number } | undefined;
  for (const submit of submits) {
    const count = fields.filter(({ ref }) => submit.serves.includes(ref)).length;
    if (count > (best?.count ?? 0)) best = { submit, count };
  }
  if (!best) return { fields, submit: undefined };
  const served = best.submit.serves;
  return { fields: fields.filter(({ ref }) => served.includes(ref)), submit: best.submit };
}

export class AutoFill implements FormFill {
  private readonly classifiers: readonly Named<DomClassifier<JsonValue>>[];
  private readonly strategies: readonly Named<MatchStrategy>[];
  private readonly values: ValueService;
  private readonly logger: Logger;
  // The page code of each classifier, made at the first use.
  private scripts: Promise<string[]> | undefined = undefined;

  constructor({ classifiers, strategies, values, logger }: AutoFillOptions) {
    this.classifiers = classifiers;
    this.strategies = strategies;
    this.values = values;
    this.logger = logger;
  }

  // The classifiers that run on the page, with their page code and input.
  private async runsFor(page: PageInfo): Promise<ClassifierRun[]> {
    this.scripts ??= Promise.all(this.classifiers.map(({ plugin }) => plugin.pageScript()));
    const scripts = await this.scripts;
    const runs: ClassifierRun[] = [];
    for (const [index, { name, plugin }] of this.classifiers.entries()) {
      try {
        const input = await plugin.pageInput(page);
        if (input !== undefined) runs.push({ name, script: scripts[index] ?? '', input });
      } catch (error) {
        this.logger.error('classifier_error', { plugin: name, url: page.url, message: errorMessage(error) });
      }
    }
    return runs;
  }

  // The keys of the fields: each match-strategy gets only the fields without a key (REQ-031c).
  private async keysOf(fields: readonly RefField[], page: PageInfo): Promise<KeyedField[]> {
    const keys = await this.values.keys(page);
    if (!keys.length) return [];
    const found = new Map<string, string>();
    for (const { name, plugin } of this.strategies) {
      const open = fields.filter(({ ref }) => !found.has(ref)).map(({ ref, hint }) => ({ ref, hint }));
      if (!open.length) break;
      let matches: readonly FieldMatch[] = [];
      try {
        matches = await plugin.match(open, keys, page);
      } catch (error) {
        this.logger.error('match_error', { plugin: name, url: page.url, message: errorMessage(error) });
      }
      for (const { ref, key } of matches) {
        if (!found.has(ref) && open.some((field) => field.ref === ref) && keys.includes(key)) found.set(ref, key);
      }
    }
    return fields.filter(({ ref }) => found.has(ref)).map(({ ref }) => ({ ref, key: found.get(ref) ?? '' }));
  }

  async run(lane: LaneSession, url: string, client: FillClient, checkPage: CheckPage): Promise<FillOutcome> {
    const { logger, values } = this;
    const { fillState, pageCode } = lane;
    let submitted = false;
    let current = url;
    // The URL where the server clicked the login link.
    let loginFrom: string | undefined;
    const pageUrl = (): Promise<string> => pageCode.run(currentUrl, null).catch(() => current);
    for (let round = 0; round < FILL_ROUNDS; round++) {
      const page = pageInfo(current);
      const runs = page.host ? await this.runsFor(page) : [];
      if (!runs.length) {
        fillState.attempts.clear();
        fillState.waitedUrl = undefined;
        break;
      }

      // In a login flow (after a login click or a submit), wait FLOW_WAIT for a field. Else wait
      // until the page settles, a maximum of PEEK_WAIT, one time for each URL (J1d). A possible
      // login click does not wait for a field.
      const host = page.host ?? '';
      const canClick = !fillState.loginClicked.has(host) && (await values.keys(page)).length > 0;
      const wait = submitted ? FLOW_WAIT : fillState.waitedUrl !== current ? PEEK_WAIT : 0;
      fillState.waitedUrl = current;
      let found: PageClassification;
      try {
        found = await pageCode.run(classifyPage, { classifiers: runs, wait, settle: !submitted, quiet: SETTLE_QUIET, interval: POLL_INTERVAL, stopOnLogin: canClick });
      } catch (error) {
        logger.error('fill_error', { url: current, step: 'classify', message: errorMessage(error) });
        break;
      }
      for (const { classifier, message } of found.errors) logger.error('classifier_error', { plugin: classifier, url: current, message });

      // The login link: one click for each lane and host. It does not count as a round.
      const login = found.logins[0];
      if (canClick && login) {
        let clicked = false;
        try {
          clicked = await pageCode.run(clickRef, { ref: login, submitWait: SUBMIT_WAIT });
        } catch (error) {
          logger.error('fill_error', { url: current, step: 'login', message: errorMessage(error) });
        }
        if (clicked) {
          fillState.loginClicked.add(host);
          logger.info('login_clicked', { url: current });
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
      if (!found.fields.length) {
        // The page left the forms: a later page can get a fill again.
        fillState.attempts.clear();
        if (submitted) logger.info('fill_no_field', { url: current, waited: wait });
        break;
      }

      const keyed = await this.keysOf(found.fields, page);
      if (!keyed.length) {
        logger.info('fill_no_value', { url: current, fields: found.fields.map(({ hint }) => hint) });
        break;
      }
      const plan = planFill(keyed, found.submits);
      const keys = [...new Set(plan.fields.map(({ key }) => key))];

      // The loop guard: each fill (host and keys) one time, until the page leaves the forms (G2).
      const attempt = `${host}\n${[...keys].map((key) => key.toLowerCase()).sort().join(',')}`;
      if (fillState.attempts.has(attempt)) {
        if (!fillState.failed.has(attempt)) logger.info('fill_failed', { url: current, keys });
        fillState.failed.add(attempt);
        break;
      }
      fillState.attempts.add(attempt);

      let given: Map<string, string>;
      try {
        given = await values.values(keys, { page, client: client.name, dialog: client.dialog });
      } catch (error) {
        if (!(error instanceof FillError)) throw error;
        logger.error('fill_error', { url: current, step: 'value', message: error.message });
        if (error instanceof ApprovalError) lane.notes.push(REFUSED_NOTE);
        break;
      }
      const fields = plan.fields.flatMap(({ ref, key }) => {
        const value = given.get(key);
        return value === undefined ? [] : [{ ref, value, key }];
      });
      if (!fields.length) {
        logger.info('fill_no_value', { url: current, keys });
        break;
      }
      let outcome;
      try {
        outcome = await pageCode.run(fillRefs, {
          fields: fields.map(({ ref, value }) => ({ ref, value })),
          submit: plan.submit ? { kind: plan.submit.kind, ref: plan.submit.ref } : null,
          submitWait: SUBMIT_WAIT,
        });
      } catch (error) {
        logger.error('fill_error', { url: current, step: 'submit', message: values.clean(errorMessage(error)) });
        break;
      }
      const filled = fields.map(({ key }) => key);
      if (!outcome.submitted) {
        if (outcome.filled) logger.info('fill_filled', { url: current, fields: filled, reason: 'no submit method' });
        break;
      }
      submitted = true;
      logger.info('fill_submitted', { url: current, fields: filled, how: outcome.how, classifier: plan.submit?.classifier });

      // The page after the submit gets the host check before each other step.
      current = await pageUrl();
      const check = await checkPage(current);
      if (!check.allowed) return { submitted, blocked: { url: current, check } };
      logger.info('page_opened', { url: current, via: 'auto_submit' });
    }

    // After the login flow, open again the URL of the login click, also after a failed login.
    if (loginFrom && current !== loginFrom) {
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
