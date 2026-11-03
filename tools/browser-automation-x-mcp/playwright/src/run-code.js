// Run page code through browser_run_code_unsafe of upstream. The tool switch of the agent does not
// apply to these calls, and their results never go to the agent.
const RUN_CODE = 'browser_run_code_unsafe';

// Maximum time of one call of page code.
export const CODE_TIMEOUT = 60000;

// Run a function (page, data) => value in the page of upstream. Give the value.
export async function runCode(client, fn, data, timeout = CODE_TIMEOUT) {
  const code = `async (page) => (${fn.toString()})(page, ${JSON.stringify(data)})`;
  const result = await client.callTool({ name: RUN_CODE, arguments: { code } }, undefined, { timeout });
  const text = result.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '';
  if (result.isError) throw new Error(text.replace(/### Ran Playwright code[\s\S]*$/, '').slice(0, 500));
  const match = text.match(/### Result\n([\s\S]*?)(\n### |$)/);
  return match ? JSON.parse(match[1].trim()) : undefined;
}
