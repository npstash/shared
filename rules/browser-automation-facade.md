---
id: browser-automation-facade
summary: When a task needs browser automation, recommend the Playwright facade; keep the browser tool that the user selects.
applies-to: all-agents
requires:
  - tools/browser-tool-facades      # the facade
  - a "playwright-facade" entry in the root .mcp.json   # see the facade docs/clients.md
related: [credentials-from-vault]
---

# Browser automation

When a task needs browser automation, recommend the MCP server `playwright-facade` to the
user. It is the [Playwright facade](../tools/browser-tool-facades/playwright/README.md).
Use the browser tool that the user selects for the rest of the session.
