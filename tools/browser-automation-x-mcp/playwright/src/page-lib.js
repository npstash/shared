// Code that runs in each frame of the browser page. Discovery and the recorder use the same code, so
// that both give the same selector for the same element. The function must not use outer names:
// the server sends its text to the page (see discover.js).
//
// Selector of a field: autocomplete, name, an id that does not look generated, the type (password,
// email), aria-label, placeholder: the first that is unique in the frame. Else a label locator of
// Playwright: internal:label="<label>"s.
// Selector of a button: an id that does not look generated, name, the type: the first that is
// unique in the frame. Else a role locator of Playwright: internal:role=button[name="<name>"s].
// discover.js checks each Playwright locator: it must find one element.
export function pageLib() {
  const SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color']);
  const BUTTONS = 'button, input[type="submit"], input[type="image"], input[type="button"], [role="button"]';
  const typeOf = (el) => (el.getAttribute('type') ?? '').toLowerCase();
  const clean = (text) => (text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
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
  const isField = (el) => Boolean(el?.matches?.('input, textarea, select')) && !SKIP.has(typeOf(el));

  function fieldInfo(el) {
    const tag = el.tagName.toLowerCase();
    const type = typeOf(el);
    const autocomplete = (el.getAttribute('autocomplete') ?? '').trim();
    const ariaLabel = (el.getAttribute('aria-label') ?? '').trim();
    const placeholder = (el.getAttribute('placeholder') ?? '').trim();
    const label = clean(el.labels?.[0]?.innerText);
    const candidates = [];
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

  function buttonInfo(el) {
    const tag = el.tagName.toLowerCase();
    const type = typeOf(el);
    const text = clean(el.getAttribute('aria-label') || el.innerText || el.value);
    const candidates = [];
    if (el.id && !generated(el.id)) candidates.push(`#${CSS.escape(el.id)}`);
    if (el.name) candidates.push(`${tag}[name=${JSON.stringify(el.name)}]`);
    if (type) candidates.push(`${tag}[type=${JSON.stringify(type)}]`);
    else if (tag === 'button') candidates.push('button');
    const css = candidates.find(unique);
    const selector = css ?? (text ? `internal:role=button[name=${JSON.stringify(text)}s]` : undefined);
    return { kind: 'button', tag, type, id: el.id ?? '', text, selector, css: Boolean(css) };
  }

  // A button that can submit a form: a submit button, an image input, a button without a type in a
  // form, or an other button near a visible field (its parent, up to 4 levels, holds the field).
  function submitLike(el) {
    const tag = el.tagName.toLowerCase();
    const type = typeOf(el);
    if (type === 'submit' || type === 'image' || (tag === 'button' && !type && el.form)) return true;
    let parent = el.parentElement;
    for (let level = 0; parent && level < 4; level++, parent = parent.parentElement) {
      if ([...parent.querySelectorAll('input, textarea, select')].some((field) => isField(field) && visible(field))) return true;
    }
    return false;
  }

  // The visible fields, then the visible buttons that can submit, of this frame.
  function discover() {
    const fields = [...document.querySelectorAll('input, textarea, select')].filter((el) => isField(el) && visible(el)).map(fieldInfo);
    const buttons = [...document.querySelectorAll(BUTTONS)].filter((el) => visible(el) && submitLike(el)).map(buttonInfo);
    return [...fields, ...buttons];
  }

  // Report the fills, button clicks and submits of this frame to the binding __baxRecord. No values.
  // An element that the form fill of the server touched has __baxAuto.
  function installRecorder() {
    if (window.__baxRecorderOn || typeof window.__baxRecord !== 'function') return;
    window.__baxRecorderOn = true;
    const reported = new WeakSet();
    const send = (event, el) => {
      try {
        window.__baxRecord({ ...event, ts: Date.now(), auto: Boolean(el.__baxAuto || el.form?.__baxAuto) });
      } catch {
        // The page closed.
      }
    };
    const onFill = (e) => {
      const el = e.target;
      if (!isField(el) || reported.has(el)) return;
      reported.add(el);
      send({ action: 'fill', ...fieldInfo(el) }, el);
    };
    document.addEventListener('input', onFill, true);
    document.addEventListener('change', onFill, true);
    document.addEventListener('click', (e) => {
      const el = e.target?.closest?.(BUTTONS);
      if (el) send({ action: 'press', ...buttonInfo(el) }, el);
    }, true);
    document.addEventListener('submit', (e) => {
      // A submit with a button is a click of the button. Report only a submit without a button (Enter).
      if (!e.submitter) send({ action: 'submit', kind: 'form' }, e.target);
    }, true);
  }

  return { discover, installRecorder };
}
