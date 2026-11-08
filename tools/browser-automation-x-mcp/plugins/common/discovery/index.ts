// Shared plugin code: the discovery file of the plugins dom-classifier/discovery (it reads the file)
// and page-script/discovery (it writes the file). See REQ-039a and REQ-039b of sdd/SRS.md.
//
//   {
//     "hosts": {
//       "<root domain>": {
//         "forms": [
//           { "fields": { "<css>": "<key>" },          the hint of each field: a key of a source
//             "submit": [<matcher> | "enter"] }        optional; the first that applies
//         ],
//         "login": [<matcher>],                        optional; the login links
//         "subdomains": { "<host>": { ... } }
//       }
//     }
//   }
//
// A matcher is a CSS selector, or { "css": "<selector>", "text": "<text>" }: an element of the
// selector whose visible text has the text, case-insensitive.
// The forms and the login links of a node apply to its host and to its subdomains.
import type { JsonObject } from '../../../src/json.ts';
import type { PageInfo } from '../../../src/plugins/plugin.ts';
import type { TreeNode } from '../files/index.ts';
import { chainOf, mtimeOf, readObject, writeObject } from '../files/index.ts';

// An element with a CSS selector, and optionally a part of its visible text.
export type Matcher = string | { css: string; text: string };

// One form of the discovery file. A type, not an interface: it is JSON for the page code.
export type DiscoveryForm = {
  fields: Record<string, string>;
  submit?: (Matcher | 'enter')[];
};

// The data of one node of the tree.
export type DiscoveryData = {
  forms?: DiscoveryForm[];
  login?: Matcher[];
};

export type DiscoveryNode = TreeNode<DiscoveryData>;

// The content of the discovery file.
export interface DiscoveryContent {
  hosts: Record<string, DiscoveryNode>;
}

function emptyContent(): JsonObject {
  return { hosts: {} };
}

function isMatcher(value: unknown): value is Matcher {
  if (typeof value === 'string') return Boolean(value);
  return Boolean(value) && typeof value === 'object' && typeof (value as { css?: unknown }).css === 'string'
    && typeof (value as { text?: unknown }).text === 'string';
}

// Check the content. Throw an error for an entry that is not valid.
function check(file: string, data: JsonObject): DiscoveryContent {
  const hosts = data.hosts ?? {};
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) throw new Error(`${file}: "hosts" must be an object`);
  const checkNode = (host: string, node: unknown): void => {
    const where = `${file}: the host "${host}"`;
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${where} must be an object`);
    const { forms, login, subdomains } = node as Record<string, unknown>;
    if (forms !== undefined && !Array.isArray(forms)) throw new Error(`${where}: "forms" must be an array`);
    for (const [index, form] of ((forms as unknown[]) ?? []).entries()) {
      const at = `${where}, form ${index + 1}`;
      if (!form || typeof form !== 'object' || Array.isArray(form)) throw new Error(`${at} must be an object`);
      const { fields, submit } = form as Record<string, unknown>;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error(`${at} needs "fields"`);
      if (submit !== undefined && (!Array.isArray(submit) || !submit.every((entry) => entry === 'enter' || isMatcher(entry)))) {
        throw new Error(`${at}: "submit" must be an array of matchers or "enter"`);
      }
    }
    if (login !== undefined && (!Array.isArray(login) || !login.every(isMatcher))) throw new Error(`${where}: "login" must be an array of matchers`);
    if (subdomains !== undefined) {
      if (!subdomains || typeof subdomains !== 'object' || Array.isArray(subdomains)) throw new Error(`${where}: "subdomains" must be an object`);
      for (const [sub, child] of Object.entries(subdomains)) checkNode(sub, child);
    }
  };
  for (const [host, node] of Object.entries(hosts)) checkNode(host, node);
  return data as unknown as DiscoveryContent;
}

// The forms and the login links of a page: the input of the page code of the discovery classifier.
export type PageForms = {
  forms: DiscoveryForm[];
  logins: Matcher[];
};

// The discovery file. It reads the file again when it changed.
export class DiscoveryFile {
  readonly file: string;
  private mtime: number | undefined = undefined;
  private content: DiscoveryContent = { hosts: {} };

  constructor(file: string) {
    this.file = file;
  }

  load(): DiscoveryContent {
    const mtime = mtimeOf(this.file);
    if (mtime !== undefined && mtime === this.mtime) return this.content;
    this.content = check(this.file, readObject(this.file, emptyContent));
    this.mtime = mtime;
    return this.content;
  }

  // The forms of the host first, then the forms of its parents; each node in file order. The login
  // links of the chain, without duplicates.
  forPage(page: PageInfo): PageForms {
    const chain = chainOf(this.load().hosts, page).reverse();
    const forms = chain.flatMap((node) => node.forms ?? []).filter((form) => Object.keys(form.fields).length);
    const seen = new Set<string>();
    const logins = chain.flatMap((node) => node.login ?? []).filter((matcher) => {
      const key = JSON.stringify(matcher);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { forms, logins };
  }

  // Change the file: read it again, give it to change(), and write it in one step if change()
  // gives a non-empty list. The entries that change() does not touch stay. Give the list.
  update(change: (content: DiscoveryContent) => string[]): string[] {
    const content = check(this.file, readObject(this.file, emptyContent));
    const written = change(content);
    if (written.length) writeObject(this.file, content);
    this.mtime = undefined;
    return written;
  }
}
