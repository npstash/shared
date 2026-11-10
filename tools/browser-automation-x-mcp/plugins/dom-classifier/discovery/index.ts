// Dom-classifier "discovery" (REQ-039b of sdd/SRS.md): the forms and the login links that the
// discovery file has for the page. The page-script "discovery" writes the file.
//
//   "config": { "file": "<discovery file in the config folder>" }
//
// Each visible field of a form is a field; its hint is the key of the file. The first "submit"
// entry of a form that applies is the submit method of its visible fields: a matcher whose element
// is visible (a click), or "enter" (Enter in the last field). Each visible element of a "login"
// matcher is a login link. The plugin reads the file again when it changes.
import type { Classification, ClassifiedField, DomClassifier, SubmitMethod } from '../../../src/plugins/dom-classifier.ts';
import type { PageInfo, PluginContext } from '../../../src/plugins/plugin.ts';
import type { PageForms } from '../../common/discovery/index.ts';
import { DiscoveryFile } from '../../common/discovery/index.ts';
import { pluginFile } from '../../common/files/index.ts';

// The page code. It must not use outer names.
function classify(document: Document, input: PageForms): Classification {
  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const normal = (text: string | null | undefined): string => (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const textOf = (el: Element): string => {
    const value = el instanceof HTMLInputElement || el instanceof HTMLButtonElement ? el.value : '';
    return normal(el.getAttribute('aria-label') || (el instanceof HTMLElement ? el.innerText : '') || value);
  };
  const all = (css: string): Element[] => {
    try {
      return [...document.querySelectorAll(css)];
    } catch {
      return [];
    }
  };
  const find = (matcher: string | { css: string; text: string }): Element | undefined => {
    if (typeof matcher === 'string') return all(matcher).find(visible);
    const text = normal(matcher.text);
    return all(matcher.css).find((el) => visible(el) && textOf(el).includes(text));
  };
  const fields: ClassifiedField[] = [];
  const submits: SubmitMethod[] = [];
  const used = new Set<Element>();
  for (const form of input.forms) {
    const found: Element[] = [];
    for (const [css, key] of Object.entries(form.fields)) {
      const element = all(css).find(visible);
      if (!element || used.has(element)) continue;
      used.add(element);
      found.push(element);
      fields.push({ element, hint: key });
    }
    const last = found.at(-1);
    if (!last) continue;
    for (const entry of form.submit ?? []) {
      if (entry === 'enter') {
        submits.push({ kind: 'enter', field: last, serves: found });
        break;
      }
      const button = find(entry);
      if (button) {
        submits.push({ kind: 'click', element: button, serves: found });
        break;
      }
    }
  }
  const logins = input.logins.map(find).filter((el): el is Element => el !== undefined);
  return { fields, submits, logins };
}

export default class DiscoveryClassifier implements DomClassifier<PageForms> {
  private readonly file: DiscoveryFile;

  constructor(context: PluginContext) {
    this.file = new DiscoveryFile(pluginFile(context, 'file'));
  }

  async pageScript(): Promise<string> {
    return classify.toString();
  }

  async pageInput(page: PageInfo): Promise<PageForms | undefined> {
    const forms = this.file.forPage(page);
    return forms.forms.length || forms.logins.length ? forms : undefined;
  }
}
