// Code that runs in each frame of the browser page: the recorder of the discovery mode. It reports
// to the binding __baxRecord of the server at once (see discover.ts). The function must not use
// outer names: the server sends its text to the page (see discover.ts).
//
// Selector of a field: autocomplete, name, an id that does not look generated, the type (password,
// email), aria-label, placeholder: the first that is unique in the frame. Else a label locator of
// Playwright: internal:label="<label>"s.
// Selector of a button: an id that does not look generated, name, the type: the first that is
// unique in the frame. Else a role locator of Playwright: internal:role=button[name="<name>"s].
// Selector of a link: a role locator of Playwright with its visible text, case-insensitive:
// internal:role=link[name="<text>"i]. Text that shows only before the login makes a login link.
// discover.ts checks each Playwright locator: it must find one element.

// A field that the user filled.
export interface FieldInfo {
  readonly kind: 'field';
  readonly tag: string;
  readonly type: string;
  readonly autocomplete: string;
  readonly name: string;
  readonly label: string;
  selector: string | undefined;
  // True if the selector is CSS: then it is unique in the frame.
  readonly css: boolean;
}

// A button that the user clicked.
export interface ButtonInfo {
  readonly kind: 'button';
  readonly tag: string;
  readonly type: string;
  readonly id: string;
  readonly text: string;
  selector: string | undefined;
  readonly css: boolean;
}

// A link to an other page that the user followed.
export interface LinkInfo {
  readonly kind: 'link';
  readonly tag: 'a';
  readonly text: string;
  readonly href: string;
  selector: string | undefined;
}

// A value of a field that the user filled; the server discards it after the match.
export interface FieldValue {
  selector: string | undefined;
  readonly value: string;
}

// One report of the recorder to the server.
export type RecorderEvent =
  | (FieldInfo & { readonly action: 'fill' })
  | (ButtonInfo & { readonly action: 'press'; readonly values: FieldValue[] })
  | (LinkInfo & { readonly action: 'link' })
  | { readonly action: 'submit'; readonly kind: 'form'; readonly button: ButtonInfo | null; readonly enter: boolean; readonly values: FieldValue[] };

// The report with the time and the mark of the form fill.
export type RecorderReport = RecorderEvent & { readonly ts: number; readonly auto: boolean };

// The functions of the page code.
export interface PageLib {
  // Report the fills, button clicks, link clicks to an other page and submits of this frame.
  installRecorder(): void;
}

declare global {
  interface Window {
    __baxRecord?: (report: RecorderReport) => void;
    __baxRecorderOn?: boolean;
  }
  interface Element {
    // The form fill of the server touched the element (see autofill.ts).
    __baxAuto?: boolean;
  }
}

export function pageLib(): PageLib {
  const SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color']);
  const BUTTONS = 'button, input[type="submit"], input[type="image"], input[type="button"], [role="button"]';
  const typeOf = (el: Element): string => (el.getAttribute('type') ?? '').toLowerCase();
  const clean = (text: string | null | undefined): string => (text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const unique = (selector: string): boolean => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };
  const generated = (id: string): boolean => /\d{3,}|:|^[a-f0-9]{8,}$/i.test(id);
  const isField = (el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => el instanceof Element && el.matches('input, textarea, select') && !SKIP.has(typeOf(el));

  function fieldInfo(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): FieldInfo {
    const tag = el.tagName.toLowerCase();
    const type = typeOf(el);
    const autocomplete = (el.getAttribute('autocomplete') ?? '').trim();
    const ariaLabel = (el.getAttribute('aria-label') ?? '').trim();
    const placeholder = (el.getAttribute('placeholder') ?? '').trim();
    const label = clean(el.labels?.[0]?.innerText);
    const candidates: string[] = [];
    if (autocomplete && !['on', 'off'].includes(autocomplete.toLowerCase())) candidates.push(`${tag}[autocomplete=${JSON.stringify(autocomplete)}]`);
    if (el.name) candidates.push(`${tag}[name=${JSON.stringify(el.name)}]`);
    if (el.id && !generated(el.id)) candidates.push(`#${CSS.escape(el.id)}`);
    if (type === 'password' || type === 'email') candidates.push(`input[type="${type}"]`);
    if (ariaLabel) candidates.push(`${tag}[aria-label=${JSON.stringify(ariaLabel)}]`);
    if (placeholder) candidates.push(`${tag}[placeholder=${JSON.stringify(placeholder)}]`);
    const css = candidates.find(unique);
    const selector = css ?? (label ? `internal:label=${JSON.stringify(label)}s` : undefined);
    return { kind: 'field', tag, type, autocomplete, name: el.name ?? '', label, selector, css: Boolean(css) };
  }

  function buttonInfo(el: HTMLElement): ButtonInfo {
    const tag = el.tagName.toLowerCase();
    const type = typeOf(el);
    const value = el instanceof HTMLInputElement || el instanceof HTMLButtonElement ? el.value : undefined;
    const text = clean(el.getAttribute('aria-label') || el.innerText || value);
    const name = el.getAttribute('name');
    const candidates: string[] = [];
    if (el.id && !generated(el.id)) candidates.push(`#${CSS.escape(el.id)}`);
    if (name) candidates.push(`${tag}[name=${JSON.stringify(name)}]`);
    if (type) candidates.push(`${tag}[type=${JSON.stringify(type)}]`);
    else if (tag === 'button') candidates.push('button');
    const css = candidates.find(unique);
    const selector = css ?? (text ? `internal:role=button[name=${JSON.stringify(text)}s]` : undefined);
    return { kind: 'button', tag, type, id: el.id ?? '', text, selector, css: Boolean(css) };
  }

  function linkInfo(el: HTMLAnchorElement): LinkInfo {
    const text = clean(el.getAttribute('aria-label') || el.innerText);
    const selector = text ? `internal:role=link[name=${JSON.stringify(text)}i]` : undefined;
    return { kind: 'link', tag: 'a', text, href: el.href, selector };
  }

  // The first visible submit button of a form, or undefined.
  function submitButton(form: HTMLFormElement): ButtonInfo | undefined {
    const el = [...form.querySelectorAll<HTMLElement>('button, input[type="submit"], input[type="image"]')]
      .find((each) => visible(each) && (['submit', 'image'].includes(typeOf(each)) || (each.tagName === 'BUTTON' && !typeOf(each))));
    return el ? buttonInfo(el) : undefined;
  }

  // Report the fills, button clicks, link clicks to an other page and submits of this frame to the
  // binding __baxRecord.
  // A fill is reported one time for each field until the next submit, without its value. A button
  // click and a submit give the values of the fields that were filled since the last submit, and
  // not by the form fill (REQ-039 of sdd/SRS.md). The server discards the values.
  // An element that the form fill of the server touched has __baxAuto.
  function installRecorder(): void {
    const record = window.__baxRecord;
    if (window.__baxRecorderOn || typeof record !== 'function') return;
    window.__baxRecorderOn = true;
    const filled = new Set<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
    const autoOf = (el: Element): boolean => {
      const form = 'form' in el && el.form instanceof HTMLFormElement ? el.form : undefined;
      return Boolean(el.__baxAuto || form?.__baxAuto);
    };
    const send = (event: RecorderEvent, el: Element): void => {
      try {
        record({ ...event, ts: Date.now(), auto: autoOf(el) });
      } catch {
        // The page closed.
      }
    };
    const values = (form?: HTMLFormElement): FieldValue[] => [...filled]
      .filter((el) => el.isConnected && !autoOf(el) && (!form || el.form === form))
      .map((el) => ({ selector: fieldInfo(el).selector, value: String(el.value ?? '') }))
      .filter((item) => item.selector);
    const onFill = (e: Event): void => {
      const el = e.target;
      if (!isField(el) || filled.has(el)) return;
      filled.add(el);
      send({ action: 'fill', ...fieldInfo(el) }, el);
    };
    document.addEventListener('input', onFill, true);
    document.addEventListener('change', onFill, true);
    document.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const el = target?.closest<HTMLElement>(BUTTONS);
      if (el) {
        send({ action: 'press', ...buttonInfo(el), values: values() }, el);
        return;
      }
      const link = target?.closest<HTMLAnchorElement>('a[href]');
      if (link && /^https?:/.test(link.href) && link.href.split('#')[0] !== location.href.split('#')[0]) {
        send({ action: 'link', ...linkInfo(link) }, link);
      }
    }, true);
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      const submitter = e instanceof SubmitEvent && e.submitter instanceof HTMLElement ? e.submitter : null;
      const button = submitter ? buttonInfo(submitter) : submitButton(form);
      send({ action: 'submit', kind: 'form', button: button ?? null, enter: !submitter, values: values(form) }, form);
      for (const el of [...filled]) if (el.form === form || !el.isConnected) filled.delete(el);
    }, true);
  }

  return { installRecorder };
}
