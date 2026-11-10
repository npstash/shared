// Approval plugin "approve-dialog" (REQ-036a of sdd/SRS.md): asks the user to approve a fill in a
// dialog of the client (MCP elicitation). Without a dialog, it refuses. The dialog shows the host,
// the keys and the client, never a value or the URL (UI-03 of sdd/SRS.md).
//
//   "approval": { "plugin": "approve-dialog", "config": {} }
import type { ApprovalPlugin, ApprovalRequest, Dialog } from '../../../src/plugins/approval-plugin.ts';
import { APPROVAL_TIMEOUT } from '../../../src/plugins/approval-plugin.ts';
import type { PluginContext, PluginLogger } from '../../../src/plugins/plugin.ts';

export default class ApproveDialog implements ApprovalPlugin {
  private readonly logger: PluginLogger;

  constructor(context: PluginContext) {
    this.logger = context.logger;
  }

  async approve({ host, keys, client }: ApprovalRequest, dialog: Dialog | undefined): Promise<boolean> {
    if (!dialog) {
      this.logger.info('approval_refused', { reason: 'the client cannot show dialogs' });
      return false;
    }
    const where = host ? `on ${host}` : 'on this page';
    const who = client ? ` for ${client}` : '';
    try {
      const answer = await dialog.ask(
        `The browser fills ${keys.join(', ')} ${where}${who}. Approve the fill? The agent does not see the values.`,
        {
          type: 'object',
          properties: { approve: { type: 'boolean', title: 'Approve', description: `Fill ${keys.join(', ')} ${where}` } },
          required: ['approve'],
        },
        APPROVAL_TIMEOUT,
      );
      return answer.action === 'accept' && answer.content.approve === true;
    } catch (error) {
      this.logger.info('approval_refused', { reason: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
}
