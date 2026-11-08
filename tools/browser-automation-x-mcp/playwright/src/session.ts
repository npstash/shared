// The state of one lane for the call steps and the form fill.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { PageCode } from './run-code.ts';

// The loop guard and the login clicks of the form fill in one lane.
export interface FillState {
  // The fills since the page left the classified fields: "<host>\n<keys>" (REQ-038).
  readonly attempts: Set<string>;
  // The fills that came again: logged one time.
  readonly failed: Set<string>;
  // The URL where the form fill waited for the fields last.
  waitedUrl: string | undefined;
  // The hosts where the server clicked a login link.
  readonly loginClicked: Set<string>;
}

export interface LaneSessionOptions {
  readonly lane: string;
  readonly client: Client;
  readonly notes: string[];
  readonly pageCode: PageCode;
}

export class LaneSession {
  readonly lane: string;
  // The upstream connection of the lane.
  readonly client: Client;
  // The notes for the next result of the lane, e.g. a refused approval.
  readonly notes: string[];
  readonly pageCode: PageCode;
  // The URL of the current page.
  pageUrl: string | undefined = undefined;
  readonly fillState: FillState = { attempts: new Set(), failed: new Set(), waitedUrl: undefined, loginClicked: new Set() };

  constructor({ lane, client, notes, pageCode }: LaneSessionOptions) {
    this.lane = lane;
    this.client = client;
    this.notes = notes;
    this.pageCode = pageCode;
  }
}
