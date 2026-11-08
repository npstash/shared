// Dom-classifier "heuristic" (REQ-039c of sdd/SRS.md): rules about the attributes and the forms of
// the page. No learning and no file.
//
//   "config": { "fields": false }
//
// Submit methods: for the visible fields of each form, the click of its first visible submit
// button, else requestSubmit() of the form. For the visible fields without a form: Enter in the
// last of them.
// Fields (only with "fields": true): login candidates only. A visible password field that is not
// "new-password", and the text or email field before it in the same form. Without a password
// field: a field with autocomplete "username" or "webauthn" (a username step). No other field.
// It gives no login links.
import type { Classification, ClassifiedField, DomClassifier, SubmitMethod } from '../../../src/plugins/dom-classifier.ts';
import type { PluginContext } from '../../../src/plugins/plugin.ts';

// The input of the page code.
type HeuristicInput = { fields: boolean };

// The page code. It must not use outer names.
function classify(document: Document, input: HeuristicInput): Classification {
  const SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color']);
  const typeOf = (el: Element): string => (el.getAttribute('type') ?? '').toLowerCase();
  const tokens = (el: Element): string[] => (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const fieldsOf = (root: ParentNode): Element[] => [...root.querySelectorAll('input, textarea, select')]
    .filter((el) => !SKIP.has(typeOf(el)) && visible(el));
  const hintOf = (el: Element): string => (typeOf(el) === 'email' || tokens(el).includes('email') ? 'email' : 'username');
  const loginFields = (list: readonly Element[]): ClassifiedField[] => {
    const passwords = list.filter((el) => typeOf(el) === 'password' && !tokens(el).includes('new-password'));
    const first = passwords[0];
    if (first) {
      const result: ClassifiedField[] = passwords.map((element) => ({ element, hint: 'password' }));
      const before = list.slice(0, list.indexOf(first)).filter((el) => el.tagName === 'INPUT' && ['', 'text', 'email', 'tel'].includes(typeOf(el))).at(-1);
      if (before) result.unshift({ element: before, hint: hintOf(before) });
      return result;
    }
    const user = list.find((el) => tokens(el).some((token) => token === 'username' || token === 'webauthn'));
    return user ? [{ element: user, hint: hintOf(user) }] : [];
  };
  const fields: ClassifiedField[] = [];
  const submits: SubmitMethod[] = [];
  for (const form of [...document.forms]) {
    const own = fieldsOf(form);
    if (!own.length) continue;
    const button = [...form.querySelectorAll('button, input[type="submit"], input[type="image"]')]
      .find((each) => visible(each) && (['submit', 'image'].includes(typeOf(each)) || (each.tagName === 'BUTTON' && !typeOf(each))));
    submits.push(button ? { kind: 'click', element: button, serves: own } : { kind: 'requestSubmit', form, serves: own });
    if (input.fields) fields.push(...loginFields(own));
  }
  const loose = fieldsOf(document).filter((el) => !('form' in el && el.form));
  const last = loose.at(-1);
  if (last) {
    submits.push({ kind: 'enter', field: last, serves: loose });
    if (input.fields) fields.push(...loginFields(loose));
  }
  return { fields, submits, logins: [] };
}

export default class HeuristicClassifier implements DomClassifier<HeuristicInput> {
  private readonly input: HeuristicInput;

  constructor(context: PluginContext) {
    const fields = context.config.fields ?? false;
    if (typeof fields !== 'boolean') throw new Error(`the instance "${context.name}": "fields" must be true or false`);
    this.input = { fields };
  }

  async pageScript(): Promise<string> {
    return classify.toString();
  }

  async pageInput(): Promise<HeuristicInput> {
    return this.input;
  }
}
