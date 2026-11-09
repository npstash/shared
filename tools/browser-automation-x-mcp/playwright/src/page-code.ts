// The page code of the server: classification, fill, submit and marks. Each function runs in the
// server process through browser_run_code_unsafe of upstream (see run-code.ts), with the page of
// the lane. A function must not use outer names: its text goes to upstream.
//
// The classification runs the page code of each dom-classifier in each frame. It keeps each
// element of the result in window.__baxRefs of its frame, by a ref "<frame>:<number>". The server
// and the plugins get only the refs (REQ-031b).
// The marks: the server sets __baxTouched on each element that the form fill or an agent call
// with a ref touches, and on its form (REQ-031e).
import type { Page } from 'playwright-core';

declare global {
  interface Window {
    // The elements of the last classification of the frame, by ref.
    __baxRefs?: Map<string, Element>;
    // The time of the last change of the DOM (see classifyPage).
    __baxChanged?: number;
  }
  interface Element {
    // The form fill or an agent call touched the element (REQ-031e).
    __baxTouched?: boolean;
  }
}

// One dom-classifier for the page code: its name, the source text of its page code and its input.
export interface ClassifierRun {
  readonly name: string;
  readonly script: string;
  readonly input: unknown;
}

export interface ClassifyData {
  readonly classifiers: readonly ClassifierRun[];
  // Maximum time to wait, in ms.
  readonly wait: number;
  // false: wait for a visible field (a login flow). true: wait until the page settles, then
  // classify one more time (J1d).
  readonly settle: boolean;
  // The time without a change of the DOM after which the page is settled, in ms.
  readonly quiet: number;
  readonly interval: number;
  // Stop at the first visible login link, without a wait for a field.
  readonly stopOnLogin: boolean;
}

// A visible field: its ref, its hint and the classifier that gave it.
export interface RefField {
  readonly ref: string;
  readonly hint: string;
  readonly classifier: string;
}

// A submit method with refs: the element to click, the field for Enter, or the form.
export interface RefSubmit {
  readonly kind: 'click' | 'enter' | 'requestSubmit';
  readonly ref: string;
  readonly serves: readonly string[];
  readonly classifier: string;
}

// The merged result of all classifiers in all frames.
export interface PageClassification {
  readonly fields: readonly RefField[];
  readonly submits: readonly RefSubmit[];
  readonly logins: readonly string[];
  // The errors of the classifiers: name and message.
  readonly errors: readonly { readonly classifier: string; readonly message: string }[];
}

export interface FillRefsData {
  readonly fields: readonly { readonly ref: string; readonly value: string }[];
  readonly submit: { readonly kind: RefSubmit['kind']; readonly ref: string } | null;
  readonly submitWait: number;
}

export interface FillRefsResult {
  readonly filled: number;
  readonly submitted: boolean;
  readonly how?: string;
}

// Page code: run the classifiers in each frame. Without a visible field: in a login flow, run them
// again until a field is visible, a maximum of data.wait ms; else wait until the page settles (no
// change of the DOM for data.quiet ms, a maximum of data.wait ms), and run them one more time.
// A field that two classifiers give belongs to the first one.
export async function classifyPage(page: Page, data: ClassifyData): Promise<PageClassification> {
  // The expression for one frame: it runs the classifiers and keeps the elements by ref.
  const expression = (frame: number): string => `(() => {
    const refs = new Map();
    window.__baxRefs = refs;
    const refOf = (el) => {
      for (const [ref, each] of refs) if (each === el) return ref;
      const ref = ${JSON.stringify(`${frame}:`)} + refs.size;
      refs.set(ref, el);
      return ref;
    };
    const visible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const fields = [], submits = [], logins = [], errors = [];
    const taken = new Set();
    const fns = [${data.classifiers.map(({ script }) => `(${script})`).join(',\n')}];
    const runs = ${JSON.stringify(data.classifiers.map(({ name, input }) => ({ name, input })))};
    for (const [index, run] of runs.entries()) {
      run.fn = fns[index];
      let result;
      try {
        result = run.fn(document, run.input);
      } catch (error) {
        errors.push({ classifier: run.name, message: String(error && error.message || error) });
        continue;
      }
      for (const field of result.fields || []) {
        if (!visible(field.element) || taken.has(field.element)) continue;
        taken.add(field.element);
        fields.push({ ref: refOf(field.element), hint: String(field.hint), classifier: run.name });
      }
      for (const method of result.submits || []) {
        const target = method.kind === 'click' ? method.element : method.kind === 'enter' ? method.field : method.form;
        if (!target || (method.kind !== 'requestSubmit' && !visible(target))) continue;
        submits.push({ kind: method.kind, ref: refOf(target), serves: (method.serves || []).map(refOf), classifier: run.name });
      }
      for (const el of result.logins || []) if (visible(el)) logins.push(refOf(el));
    }
    return { fields, submits, logins, errors };
  })()`;
  const classifyAll = async (): Promise<PageClassification> => {
    const merged: { fields: RefField[]; submits: RefSubmit[]; logins: string[]; errors: { classifier: string; message: string }[] } = { fields: [], submits: [], logins: [], errors: [] };
    for (const [index, frame] of page.frames().entries()) {
      const part = await frame.evaluate(expression(index)).catch(() => undefined) as PageClassification | undefined;
      if (!part) continue;
      merged.fields.push(...part.fields);
      merged.submits.push(...part.submits);
      merged.logins.push(...part.logins);
      merged.errors.push(...part.errors);
    }
    return merged;
  };
  const done = (result: PageClassification): boolean => result.fields.length > 0 || (data.stopOnLogin && result.logins.length > 0);
  const deadline = Date.now() + data.wait;
  let result = await classifyAll();
  if (done(result) || data.wait <= 0) return result;
  if (!data.settle) {
    while (!done(result) && Date.now() < deadline) {
      await page.waitForTimeout(data.interval);
      result = await classifyAll();
    }
    return result;
  }
  // The time of the last change of the DOM in each frame, from a MutationObserver.
  const watch = `(() => {
    if (!window.__baxChanged) {
      window.__baxChanged = Date.now();
      new MutationObserver(() => { window.__baxChanged = Date.now(); })
        .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    return window.__baxChanged;
  })()`;
  for (;;) {
    let changed = 0;
    for (const frame of page.frames()) changed = Math.max(changed, Number(await frame.evaluate(watch).catch(() => 0)));
    if (Date.now() - changed >= data.quiet || Date.now() >= deadline) break;
    await page.waitForTimeout(data.interval);
  }
  return classifyAll();
}

export interface SettleData {
  // Maximum time to wait, in ms.
  readonly wait: number;
  // The time without a change of the DOM after which the page is settled, in ms.
  readonly quiet: number;
  readonly interval: number;
}

// Page code: wait until the page has text and has no change of the DOM for data.quiet ms, a maximum
// of data.wait ms. A page that loads itself again restarts the wait. Give true if the page settled.
export async function settlePage(page: Page, data: SettleData): Promise<boolean> {
  const watch = `(() => {
    if (!window.__baxChanged) {
      window.__baxChanged = Date.now();
      new MutationObserver(() => { window.__baxChanged = Date.now(); })
        .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    return { changed: window.__baxChanged, text: document.body ? document.body.innerText.trim().length : 0 };
  })()`;
  const deadline = Date.now() + data.wait;
  while (Date.now() < deadline) {
    let changed = 0;
    let text = 0;
    let readable = true;
    for (const frame of page.frames()) {
      const state = await frame.evaluate(watch).catch(() => undefined) as { changed: number; text: number } | undefined;
      if (state) {
        changed = Math.max(changed, state.changed);
        text += state.text;
      } else if (frame === page.mainFrame()) {
        readable = false;
      }
    }
    if (readable && text > 0 && Date.now() - changed >= data.quiet) return true;
    await page.waitForTimeout(data.interval);
  }
  return false;
}

// Page code: fill the fields by ref, then run the submit method, and wait for the page.
// data.submit null: fill only. The touched elements get the mark __baxTouched.
export async function fillRefs(page: Page, data: FillRefsData): Promise<FillRefsResult> {
  const elementOf = async (ref: string): Promise<import('playwright-core').ElementHandle<Element> | null> => {
    const frame = page.frames()[Number(ref.split(':')[0])];
    if (!frame) return null;
    const handle = await frame.evaluateHandle((r) => window.__baxRefs?.get(r) ?? null, ref).catch(() => null);
    return handle?.asElement() ?? null;
  };
  const mark = (handle: import('playwright-core').ElementHandle<Element>): Promise<void> => handle.evaluate((el) => {
    el.__baxTouched = true;
    const form = 'form' in el && el.form instanceof HTMLFormElement ? el.form : undefined;
    if (form) form.__baxTouched = true;
  }).catch(() => {});
  let filled = 0;
  for (const field of data.fields) {
    const handle = await elementOf(field.ref);
    if (!handle) continue;
    await mark(handle);
    await handle.fill(field.value);
    filled++;
  }
  if (!filled || !data.submit) return { filled, submitted: false };
  const target = await elementOf(data.submit.ref);
  if (!target) return { filled, submitted: false };
  await mark(target);
  if (data.submit.kind === 'click') await target.click({ noWaitAfter: true });
  else if (data.submit.kind === 'enter') await target.press('Enter', { noWaitAfter: true });
  else await target.evaluate((form) => { if (form instanceof HTMLFormElement) form.requestSubmit(); });
  await page.waitForTimeout(500);
  await page.waitForLoadState('load', { timeout: data.submitWait }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: data.submitWait }).catch(() => {});
  return { filled, submitted: true, how: data.submit.kind };
}

// Page code: click a login link by ref, then wait for the next page. Give true if it clicked.
export async function clickRef(page: Page, { ref, submitWait }: { ref: string; submitWait: number }): Promise<boolean> {
  const frame = page.frames()[Number(ref.split(':')[0])];
  const handle = frame ? (await frame.evaluateHandle((r) => window.__baxRefs?.get(r) ?? null, ref).catch(() => null))?.asElement() : null;
  if (!handle) return false;
  await handle.evaluate((el) => { el.__baxTouched = true; }).catch(() => {});
  const before = page.url();
  await handle.click({ timeout: 5000 });
  await page.waitForURL((url) => url.href !== before, { timeout: submitWait }).catch(() => {});
  await page.waitForLoadState('load', { timeout: submitWait }).catch(() => {});
  return true;
}

// Page code: mark the elements of an agent call before upstream runs it (REQ-031e). A target is a
// ref of the snapshot (e.g. "e12", "f1e3") or a selector, as upstream resolves it. focused: mark
// the focused element, e.g. for browser_press_key.
export async function markTargets(page: Page, { targets, focused }: { targets: readonly string[]; focused: boolean }): Promise<void> {
  const setMark = (el: Element): void => {
    el.__baxTouched = true;
    const form = 'form' in el && el.form instanceof HTMLFormElement ? el.form : undefined;
    if (form) form.__baxTouched = true;
  };
  for (const target of targets) {
    const locator = /^(f\d+)?e\d+$/.test(target) ? page.locator(`aria-ref=${target}`) : page.locator(target);
    await locator.first().evaluate(setMark, undefined, { timeout: 1000 }).catch(() => {});
  }
  if (focused) {
    await page.evaluate(() => {
      const el = document.activeElement;
      if (el && el !== document.body) {
        el.__baxTouched = true;
        const form = 'form' in el && el.form instanceof HTMLFormElement ? el.form : undefined;
        if (form) form.__baxTouched = true;
      }
    }).catch(() => {});
  }
}

// Page code: the URL of the current page.
export function currentUrl(page: Page): string {
  return page.url();
}
