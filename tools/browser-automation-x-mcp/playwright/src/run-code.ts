// Run page code through browser_run_code_unsafe of upstream. The tool switch of the agent does not
// apply to these calls, and their results never go to the agent.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Page } from 'playwright-core';

const RUN_CODE = 'browser_run_code_unsafe';

// Maximum time of one call of page code.
export const CODE_TIMEOUT: number = 60000;

// A function that runs in the page of upstream. It must not use outer names: its text goes to
// upstream. data is JSON.
export type PageFunction<D, R> = (page: Page, data: D) => Promise<R> | R;

// Runs page code in the page of a lane.
export interface PageCode {
  // Run the function in the current page of upstream. Give its value.
  run<D, R>(fn: PageFunction<D, R>, data: D, timeout?: number): Promise<R>;
}

// Page code through the upstream connection of one lane.
export class UpstreamPageCode implements PageCode {
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  async run<D, R>(fn: PageFunction<D, R>, data: D, timeout: number = CODE_TIMEOUT): Promise<R> {
    const code = `async (page) => (${fn.toString()})(page, ${JSON.stringify(data)})`;
    const result = await this.client.callTool({ name: RUN_CODE, arguments: { code } }, undefined, { timeout }) as CallToolResult;
    const text = result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '';
    if (result.isError) throw new Error(text.replace(/### Ran Playwright code[\s\S]*$/, '').slice(0, 500));
    const match = text.match(/### Result\n([\s\S]*?)(\n### |$)/);
    return (match?.[1] ? JSON.parse(match[1].trim()) : undefined) as R;
  }
}
