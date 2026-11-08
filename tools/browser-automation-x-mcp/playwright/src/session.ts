// The state of one lane for the call steps, the form fill and the discovery.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { PageCode } from './run-code.ts';

// The loop guard and the login clicks of the form fill in one lane.
export interface FillState {
  // The fills of the forms since the page left the forms: "<form key>\n<selectors>".
  readonly attempts: Set<string>;
  // The fills that came again: logged one time.
  readonly failed: Set<string>;
  // The URL where the form fill waited for the fields last.
  waitedUrl: string | undefined;
  // The hosts where the server clicked a login link.
  readonly loginClicked: Set<string>;
}

// The time of one call of the agent.
export interface AgentCall {
  readonly start: number;
  end?: number;
}

export interface LaneSessionOptions {
  readonly lane: string;
  readonly client: Client;
  readonly notes: string[];
  readonly pageCode: PageCode;
}

// The maximum number of agent calls that a lane keeps.
const AGENT_CALLS_KEPT: number = 20;

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
  // The time of the recent agent calls: the recorder gives their events to the agent.
  readonly agentCalls: AgentCall[] = [];

  constructor({ lane, client, notes, pageCode }: LaneSessionOptions) {
    this.lane = lane;
    this.client = client;
    this.notes = notes;
    this.pageCode = pageCode;
  }

  // Record the start of an agent call. Give the record: the caller sets its end.
  startAgentCall(start: number): AgentCall {
    const call: AgentCall = { start };
    this.agentCalls.push(call);
    if (this.agentCalls.length > AGENT_CALLS_KEPT) this.agentCalls.shift();
    return call;
  }
}
