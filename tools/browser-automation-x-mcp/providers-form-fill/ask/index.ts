// Ask provider (value): asks the user for a value through MCP elicitation (a dialog of the client).
// It works only if the client can show such a dialog, and only for the names in "fields" of its
// entry in server.json.
// The answer is kept for the session (host + field name), never written to a file.
import type { FillContext, ProviderKind, ProviderOptions } from '../../src/fill/provider.ts';
import { FillError, FillProvider } from '../../src/fill/provider.ts';

export default class AskProvider extends FillProvider {
  readonly fields: readonly string[];
  // The answers of the session: host + field name → value.
  private readonly answers: Map<string, string>;

  constructor(options: ProviderOptions) {
    super(options);
    const fields = this.settings.fields;
    this.fields = (Array.isArray(fields) ? fields : []).map((name) => String(name).toLowerCase());
    this.answers = new Map();
  }

  get kind(): ProviderKind {
    return 'value';
  }

  async resolve(field: string, ctx: FillContext): Promise<string | undefined> {
    const name = String(field).toLowerCase();
    if (!ctx.elicit || !this.fields.includes(name)) return undefined;
    const key = `${ctx.host ?? ''}\n${name}`;
    if (this.answers.has(key)) return this.answers.get(key);

    const where = ctx.host ? `on ${ctx.host}` : 'on this page';
    const result = await ctx.elicit(
      `The browser fills the field "${name}" ${where}. Give the value. The agent does not see it.`,
      {
        type: 'object',
        properties: { value: { type: 'string', title: name, description: `Value of ${name} ${where}` } },
        required: ['value'],
      },
    );
    if (result.action !== 'accept' || typeof result.content?.value !== 'string') {
      throw new FillError(`the user did not give ${name} (${result.action}).`);
    }
    this.answers.set(key, result.content.value);
    return result.content.value;
  }
}
