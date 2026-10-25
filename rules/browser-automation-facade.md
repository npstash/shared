---
id: browser-automation-facade
summary: Browser automation only through the Playwright facade MCP server; placeholders for user data.
applies-to: all-agents
requires:
  - tools/claude-tool_playwright-facade      # the facade
  - a "playwright-facade" entry in the root .mcp.json   # see the facade docs/clients.md
  - deny entries in the root .claude/settings.json      # Claude Code: blocks direct Playwright
related: [credentials-from-vault]
---

# Browser automation through the facade

Use only the tools of the MCP server `playwright-facade` for browser automation. It is the
[Playwright facade](../tools/claude-tool_playwright-facade/README.md).

- Do not use Playwright MCP directly, the Playwright plugin, or a browser tool of an other server.
- Do not start Playwright, a browser or `npx playwright` from the shell.
- Do not type personal data or credentials. Write a placeholder, e.g. `{{email}}` or
  `{{password}}`. Call `fill_values_list` to get the placeholders of the page.
- If a call fails because of a disabled tool, a blocked host or a missing value, tell the user
  the reason. Do not look for an other way.
- If the tools of `playwright-facade` are missing, stop and tell the user. Use no fallback.
