// The page code of the page-script "discovery": it records the fills, button clicks, link clicks
// and submits of each frame, and sends them to the Node code (index.ts). It must not use outer
// names: the server sends its text to the page.
//
// Selector of a field: autocomplete, name, an id that does not look generated, the type (password,
// email), aria-label, placeholder: the first CSS selector that is unique in the frame. Else the
// field has no selector.
// Matcher of a button: an id that does not look generated, name, the type: the first CSS selector
// that is unique in the frame. Else { css, text } with its visible text.
// Matcher of a link: { css: "a", text } with its visible text. Text that shows only before the
// login makes a login link.
import type { PageApi } from '../../../src/plugins/page-script.ts';
import type { Matcher } from '../../common/discovery/index.ts';

// A field that the user filled.
export type FieldInfo = {
  tag: string;
  type: string;
  autocomplete: string;
  name: string;
  selector: string | null;
};

// A button that the user clicked.
export type ButtonInfo = {
  text: string;
  matcher: Matcher | null;
};

// A link to an other page that the user followed.
export type LinkInfo = {
  text: string;
  href: string;
  matcher: Matcher | null;
};

// One message of the page code. ts: the time of the event in the browser. touched: the form fill
// or an agent call touched the element (REQ-031e). The values of the fields go as values of the
// message, with the selector of the field as id.
export type RecorderMessage =
  | { action: 'fill'; ts: number; touched: boolean; field: FieldInfo }
  | { action: 'press'; ts: number; touched: boolean; button: ButtonInfo; fields: FieldInfo[] }
  | { action: 'submit'; ts: number; touched: boolean; button: ButtonInfo | null; enter: boolean; fields: FieldInfo[] }
  | { action: 'link'; ts: number; touched: boolean; link: LinkInfo }
  | { action: 'leave'; ts: number; touched: boolean };

export function recorder(api: PageApi<RecorderMessage>): void {
  const SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color']);
  const BUTTONS = 'button, input[type="submit"], input[type="image"], input[type="button"], [role="button"]';
  type FieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
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
  const isField = (el: EventTarget | null): el is FieldElement => el instanceof Element && el.matches('input, textarea, select') && !SKIP.has(typeOf(el));
  const touched = (el: Element): boolean => {
    const form = 'form' in el && el.form instanceof HTMLFormElement ? el.form : undefined;
    return api.touchedByServer(el) || Boolean(form && api.touchedByServer(form));
  };

  function fieldInfo(el: FieldElement): FieldInfo {
    const tag = el.tagName.toLowerCase();
    const type = typeOf(el);
    const autocomplete = (el.getAttribute('autocomplete') ?? '').trim();
    const ariaLabel = (el.getAttribute('aria-label') ?? '').trim();
    const placeholder = (el.getAttribute('placeholder') ?? '').trim();
    const candidates: string[] = [];
    if (autocomplete && !['on', 'off'].includes(autocomplete.toLowerCase())) candidates.push(`${tag}[autocomplete=${JSON.stringify(autocomplete)}]`);
    if (el.name) candidates.push(`${tag}[name=${JSON.stringify(el.name)}]`);
    if (el.id && !generated(el.id)) candidates.push(`#${CSS.escape(el.id)}`);
    if (type === 'password' || type === 'email') candidates.push(`input[type="${type}"]`);
    if (ariaLabel) candidates.push(`${tag}[aria-label=${JSON.stringify(ariaLabel)}]`);
    if (placeholder) candidates.push(`${tag}[placeholder=${JSON.stringify(placeholder)}]`);
    return { tag, type, autocomplete, name: el.name ?? '', selector: candidates.find(unique) ?? null };
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
    const matcher = css ?? (text ? { css: type ? `${tag}[type=${JSON.stringify(type)}]` : tag, text } : null);
    return { text, matcher };
  }

  function linkInfo(el: HTMLAnchorElement): LinkInfo {
    const text = clean(el.getAttribute('aria-label') || el.innerText);
    return { text, href: el.href, matcher: text ? { css: 'a', text } : null };
  }

  // The first visible submit button of a form, or undefined.
  function submitButton(form: HTMLFormElement): ButtonInfo | undefined {
    const el = [...form.querySelectorAll<HTMLElement>('button, input[type="submit"], input[type="image"]')]
      .find((each) => visible(each) && (['submit', 'image'].includes(typeOf(each)) || (each.tagName === 'BUTTON' && !typeOf(each))));
    return el ? buttonInfo(el) : undefined;
  }

  // The fields that were filled since the last submit: each fill is sent one time.
  const filled = new Set<FieldElement>();
  const userFields = (form?: HTMLFormElement): FieldElement[] => [...filled]
    .filter((el) => el.isConnected && !touched(el) && (!form || el.form === form));
  const values = (fields: readonly FieldElement[]): { id: string; value: string }[] => fields
    .map((el) => ({ id: fieldInfo(el).selector ?? '', value: String(el.value ?? '') }))
    .filter((item) => item.id);
  const send = (message: RecorderMessage, fields: readonly FieldElement[] = []): void => {
    try {
      api.send(message, values(fields));
    } catch {
      // The page closed.
    }
  };

  const onFill = (e: Event): void => {
    const el = e.target;
    if (!isField(el) || filled.has(el)) return;
    filled.add(el);
    send({ action: 'fill', ts: Date.now(), touched: touched(el), field: fieldInfo(el) });
  };
  document.addEventListener('input', onFill, true);
  document.addEventListener('change', onFill, true);
  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const el = target?.closest<HTMLElement>(BUTTONS);
    if (el) {
      const fields = userFields();
      send({ action: 'press', ts: Date.now(), touched: touched(el), button: buttonInfo(el), fields: fields.map(fieldInfo) }, fields);
      return;
    }
    const link = target?.closest<HTMLAnchorElement>('a[href]');
    if (link && /^https?:/.test(link.href) && link.href.split('#')[0] !== location.href.split('#')[0]) {
      send({ action: 'link', ts: Date.now(), touched: touched(link), link: linkInfo(link) });
    }
  }, true);
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = e instanceof SubmitEvent && e.submitter instanceof HTMLElement ? e.submitter : null;
    const button = submitter ? buttonInfo(submitter) : submitButton(form);
    const fields = userFields(form);
    send({ action: 'submit', ts: Date.now(), touched: touched(form), button: button ?? null, enter: !submitter, fields: fields.map(fieldInfo) }, fields);
    for (const el of [...filled]) if (el.form === form || !el.isConnected) filled.delete(el);
  }, true);
  window.addEventListener('pagehide', () => send({ action: 'leave', ts: Date.now(), touched: false }));
}
