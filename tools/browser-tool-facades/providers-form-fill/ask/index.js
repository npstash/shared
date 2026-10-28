// Ask provider: asks the user for a value through MCP elicitation (a dialog of the client).
// It works only if the client can show such a dialog, and only for the fields in its config.
// The answer is kept for the session (host + placeholder), never written to a file.
import { listValue, sectionValues } from '../../src/ini.js';
import { FillError, FillProvider } from '../../src/fill/provider.js';

export default class AskProvider extends FillProvider {
  constructor(options) {
    super(options);
    this.fields = listValue(sectionValues(this.config, 'ask').fields).map((name) => name.toLowerCase());
    this.answers = new Map();
  }

  async list(ctx) {
    return ctx.elicit ? this.fields : [];
  }

  async resolve(name, ctx) {
    if (!ctx.elicit || !this.fields.includes(name)) return undefined;
    const key = `${ctx.host ?? ''}\n${name}`;
    if (this.answers.has(key)) return this.answers.get(key);

    const where = ctx.host ? `on ${ctx.host}` : 'on this page';
    const field = ctx.field ? ` into the field "${ctx.field}"` : '';
    const result = await ctx.elicit(
      `The browser agent wants to type your ${name}${field} ${where}. The agent does not see the value.`,
      {
        type: 'object',
        properties: { value: { type: 'string', title: name, description: `Value of ${name} ${where}` } },
        required: ['value'],
      },
    );
    if (result.action !== 'accept' || typeof result.content?.value !== 'string') {
      throw new FillError(`the user did not give {{${name}}} (${result.action}).`);
    }
    this.answers.set(key, result.content.value);
    return result.content.value;
  }
}
