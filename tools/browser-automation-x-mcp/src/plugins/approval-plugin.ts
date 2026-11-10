// The API of an approval plugin (REQ-036c of sdd/SRS.md). It is attached to one key-value-source
// instance ("approval" of its entry) and approves the fill of the keys of that instance.
import type { ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';
import type { Plugin } from './plugin.ts';

// Maximum time of one approval, in ms (APPROVAL_TIMEOUT of sdd/SRS.md).
export const APPROVAL_TIMEOUT: number = 15000;

// The request of one approval. It has no value and no URL.
export interface ApprovalRequest {
  readonly host: string | undefined;
  readonly keys: readonly string[];
  // The client name of MCP initialize.
  readonly client: string | undefined;
}

// The form of a dialog of the client (MCP elicitation).
export type DialogForm = ElicitRequestFormParams['requestedSchema'];

// The answer of the user.
export type DialogAnswer =
  | { readonly action: 'accept'; readonly content: Readonly<Record<string, string | number | boolean | string[]>> }
  | { readonly action: 'decline' | 'cancel' };

// A dialog of the client.
export interface Dialog {
  ask(message: string, form: DialogForm, timeout: number): Promise<DialogAnswer>;
}

export interface ApprovalPlugin extends Plugin {
  // True if the fill of the keys is approved. dialog: undefined if the client cannot show one.
  approve(request: ApprovalRequest, dialog: Dialog | undefined): Promise<boolean>;
}
