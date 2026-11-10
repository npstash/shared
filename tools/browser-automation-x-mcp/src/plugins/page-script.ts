// The API of a page-script plugin (REQ-031d of sdd/SRS.md): page code in each frame of each lane,
// and Node code beside it. The server gives the page code a channel to the Node code. The Node
// code never gets a value of a field: the server replaces each value with its keys.
import type { JsonValue } from '../json.ts';
import type { PageInfo, Plugin } from './plugin.ts';

// A value that the page code sends for the keys.
export interface ValueToIdentify {
  // Chosen by the page code, e.g. the selector of the field.
  readonly id: string;
  // The server discards it after the key lookup.
  readonly value: string;
}

// The keys of one value, in the order of the key-value-sources. Empty: no source has the value.
export interface IdentifiedValue {
  readonly id: string;
  readonly keys: readonly string[];
}

// The API of the server in the page. M: the data of a message; each plugin defines it.
export interface PageApi<M extends JsonValue> {
  // Send a message to the Node code of the plugin.
  send(data: M, values: readonly ValueToIdentify[]): void;
  // True if the form fill or an agent call with a ref touched the element (REQ-031e).
  touchedByServer(element: Element): boolean;
}

// The page code: it runs in each frame at the start of the page. It must not use outer names.
export type PageScriptFunction<M extends JsonValue> = (api: PageApi<M>) => void;

// A message as the Node code gets it.
export interface PageMessage<M extends JsonValue> {
  readonly lane: string;
  readonly data: M;
  readonly identified: readonly IdentifiedValue[];
}

export interface PageScriptPlugin<M extends JsonValue> extends Plugin {
  // The source text of the page code; it evaluates to a PageScriptFunction<M>.
  pageScript(): Promise<string>;
  onMessage(message: PageMessage<M>, page: PageInfo): Promise<void>;
  laneClosed(lane: string): Promise<void>;
}
