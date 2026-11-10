// The API of a dom-classifier (REQ-031b of sdd/SRS.md). It runs as page code against the live DOM
// of each frame. A field of its result is a fill candidate: the classifier decides what to fill
// and what each field is. No element leaves the page: the server gives refs to the other plugins.
import type { JsonValue } from '../json.ts';
import type { PageInfo, Plugin } from './plugin.ts';

// A field to fill.
export interface ClassifiedField {
  readonly element: Element;
  // A short text, e.g. "password"; an open list; not a key.
  readonly hint: string;
}

// A way to submit the fields that it serves.
export type SubmitMethod =
  | { readonly kind: 'click'; readonly element: Element; readonly serves: readonly Element[] }
  | { readonly kind: 'enter'; readonly field: Element; readonly serves: readonly Element[] }
  | { readonly kind: 'requestSubmit'; readonly form: HTMLFormElement; readonly serves: readonly Element[] };

// The result of a classifier in one frame.
export interface Classification {
  readonly fields: readonly ClassifiedField[];
  readonly submits: readonly SubmitMethod[];
  readonly logins: readonly Element[];
}

// The page code: it runs in a frame of the page. It must not use outer names.
// I: the input of the page code; each plugin defines it. The server passes it through unread.
export type ClassifyFunction<I extends JsonValue> = (document: Document, input: I) => Classification;

export interface DomClassifier<I extends JsonValue> extends Plugin {
  // The source text of the page code; it evaluates to a ClassifyFunction<I>.
  pageScript(): Promise<string>;
  // The input of the page code on this page, or undefined: the classifier does not run on this page.
  pageInput(page: PageInfo): Promise<I | undefined>;
}
