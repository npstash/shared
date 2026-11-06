// Approval dialog provider (approval): asks the user to approve a fill through MCP elicitation (a
// dialog of the client), then gives the values of its key-value provider (the entry in server.json
// that has this provider as "approval"). Without a dialog, it refuses. The dialog shows the host, the keys and the client,
// never a value or the URL (UI-03 of sdd/SRS.md).
import { APPROVAL_TIMEOUT, ApprovalProvider } from '../../src/fill/provider.js';

export default class ApproveDialogProvider extends ApprovalProvider {
  async approve({ host, keys, client }, ctx) {
    if (!ctx.elicit) {
      this.logger?.info('approval_refused', { provider: this.name, reason: 'the client cannot show dialogs' });
      return false;
    }
    const where = host ? `on ${host}` : 'on this page';
    const who = client ? ` for ${client}` : '';
    let result;
    try {
      result = await ctx.elicit(
        `The browser fills ${keys.join(', ')} ${where}${who}. Approve the fill? The agent does not see the values.`,
        {
          type: 'object',
          properties: { approve: { type: 'boolean', title: 'Approve', description: `Fill ${keys.join(', ')} ${where}` } },
          required: ['approve'],
        },
        APPROVAL_TIMEOUT,
      );
    } catch (error) {
      this.logger?.info('approval_refused', { provider: this.name, reason: error.message });
      return false;
    }
    return result?.action === 'accept' && result.content?.approve === true;
  }
}
