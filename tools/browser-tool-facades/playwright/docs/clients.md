# Use the facade in Claude Code clients

The facade is an MCP server on stdio. Each client starts it with the launcher of the tool. Give
the server the name `playwright-facade`. Then the tool names are
`mcp__playwright-facade__browser_navigate` etc. The rule
[browser-automation-facade](../../../../rules/browser-automation-facade.md) uses this name.

This repository loads the facade for each Claude Code session (VSCode, CLI, Desktop app on Linux,
WSL or macOS): the root `.mcp.json` has the server, and the root `.claude/settings.json`
approves it and blocks direct Playwright. See [Block direct Playwright](#block-direct-playwright).

Before the first use, run `install` one time (see the [tool README](../../README.md#run)):

```bash
shared/tools/browser-tool-facades/run.sh install       # Linux, macOS, WSL
shared\tools\browser-tool-facades\run.bat install      # Windows
```

In the examples, `<TOOL>` is the absolute path of the tool folder `browser-tool-facades`, e.g.
`/mnt/c/work/my_workspace/shared/tools/browser-tool-facades` (WSL)
or `C:\work\my_workspace\shared\tools\browser-tool-facades` (Windows).

If Playwright MCP is also configured, block it as [Block direct Playwright](#block-direct-playwright)
says.

## Select the launcher

| Claude Code runs in | `command` | `args` |
| --- | --- | --- |
| Linux, macOS, WSL | `<TOOL>/run.sh` | `["playwright"]` |
| Windows (native) | `cmd` | `["/c", "<TOOL>\\run.bat", "playwright"]` |
| Windows, browser in WSL | `wsl.exe` | `["<TOOL in WSL>/run.sh", "playwright"]` |

- On Windows, a client cannot start a `.bat` file directly. Use `cmd /c`.
- The first argument selects the facade: `playwright`. Add the arguments of Playwright MCP after it,
  e.g. `"--isolated"`.

## Claude Code CLI

Add the server for the user (all projects):

```bash
claude mcp add --scope user playwright-facade -- <TOOL>/run.sh playwright
claude mcp add --scope user playwright-facade -- <TOOL>/run.sh playwright --isolated    # with an argument
claude mcp list                                                       # check: "playwright-facade: ... Connected"
```

Or add it for one project only. Put this into `.mcp.json` in the project root. The team shares
this file. Claude Code asks for an approval at the first start:

```json
{
  "mcpServers": {
    "playwright-facade": {
      "type": "stdio",
      "command": "<TOOL>/run.sh",
      "args": ["playwright"]
    }
  }
}
```

For one run only:

```bash
claude --mcp-config <file.json> --allowedTools "mcp__playwright-facade__*"
```

In a session, `/mcp` shows the state of the server.

## Claude Code in VSCode

The VSCode extension uses the same configuration as the CLI: the user scope (`claude mcp add
--scope user`) and the `.mcp.json` of the workspace folder.

1. Add the server as in [Claude Code CLI](#claude-code-cli). If VSCode runs in WSL (Remote - WSL),
   run `claude mcp add` in the WSL terminal and use `run.sh`.
2. Start a new Claude Code session in VSCode. Type `/mcp` to see the state.

## Claude Code in the Claude Desktop app

The Code tab of the desktop app uses the configuration of Claude Code on the same computer:
the user scope in `~/.claude.json` and the `.mcp.json` of the project folder.

- Windows: the desktop app runs Claude Code on Windows. Use `cmd /c <TOOL>\run.bat playwright`:

  ```powershell
  claude mcp add --scope user playwright-facade -- cmd /c C:\work\my_workspace\shared\tools\browser-tool-facades\run.bat playwright
  ```

  If Claude Code is not installed on Windows, add the entry to `%USERPROFILE%\.claude.json` under
  `"mcpServers"`, with `"command": "cmd"` and `"args": ["/c", "<TOOL>\\run.bat", "playwright"]`.
- macOS: use `run.sh`.
- Start a new session in the Code tab. Type `/mcp` to see the state.

## Claude Agent SDK

Give the server in the options of `query()`. Allow its tools with `mcp__playwright-facade__*`.

Python (`claude-agent-sdk`):

```python
from claude_agent_sdk import ClaudeAgentOptions, query

options = ClaudeAgentOptions(
    mcp_servers={
        "playwright-facade": {
            "type": "stdio",
            "command": "<TOOL>/run.sh",
            "args": ["playwright", "--isolated"],
            "env": {"PLAYWRIGHT_FACADE_LOG_FILE": "<TOOL>/.local_assets/logs/my-wrapper.log"},
        }
    },
    allowed_tools=["mcp__playwright-facade__*"],
)

async for message in query(prompt="Open https://example.com and give the title.", options=options):
    print(message)
```

TypeScript (`@anthropic-ai/claude-agent-sdk`):

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Open https://example.com and give the title.",
  options: {
    mcpServers: {
      "playwright-facade": { type: "stdio", command: "<TOOL>/run.sh", args: ["playwright", "--isolated"] },
    },
    allowedTools: ["mcp__playwright-facade__*"],
  },
})) {
  console.log(message);
}
```

- Use `--isolated` if the wrapper runs more than one session at the same time. Each session then
  has its own profile in memory.
- The facade runs headless by default. `PLAYWRIGHT_MCP_HEADLESS=false` in `env` gives a window.
- An `env` entry goes to the facade and to Playwright MCP, e.g. `PLAYWRIGHT_FACADE_LOG_LEVEL`.
- On Windows, use `"command": "cmd"` and `"args": ["/c", "<TOOL>\\run.bat", "playwright", ...]`.

## Claude Cowork (Claude Desktop app)

Not verified. Cowork runs the work of Claude in a sandbox on the computer. The Claude Desktop app
can start local MCP servers from its configuration file. If Cowork can use these servers, the
facade runs on the computer, outside the sandbox. The browser then opens on the desktop.

1. In the Claude Desktop app, open Settings > Developer > Edit Config. This opens
   `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`, macOS:
   `~/Library/Application Support/Claude/`).
2. Add the server:

   ```json
   {
     "mcpServers": {
       "playwright-facade": {
         "command": "cmd",
         "args": ["/c", "C:\\work\\my_workspace\\shared\\tools\\browser-tool-facades\\run.bat", "playwright"]
       }
     }
   }
   ```

   On macOS, use `"command": "<TOOL>/run.sh"` and `"args": ["playwright"]`.
3. Quit the app fully and start it again.
4. In a Cowork task, look for the `playwright-facade` tools in the list of connectors and tools.

If Cowork does not show the tools, it cannot use local MCP servers in this version. Cowork
can open web pages with its own browser tools (Claude in Chrome) instead.

## Block direct Playwright

A rule only tells the agent what to do. Permission rules of Claude Code stop the calls. Put them
into the committed `.claude/settings.json` of the repository root:

```json
{
  "enabledMcpjsonServers": ["playwright-facade"],
  "permissions": {
    "deny": [
      "mcp__playwright",
      "mcp__plugin_playwright_playwright",
      "Bash(npx @playwright/mcp:*)",
      "Bash(npx playwright:*)"
    ]
  }
}
```

- `enabledMcpjsonServers` approves the server of `.mcp.json`. Claude Code then does not ask.
- `mcp__playwright` blocks a Playwright MCP with the name `playwright` in each scope.
- `mcp__plugin_playwright_playwright` blocks the Playwright plugin. `/mcp` shows the name of a
  plugin server; add an other name if it is different.
- The `Bash(...)` lines block a Playwright that the agent starts in the shell.
- Native Windows needs `cmd /c <TOOL>\run.bat playwright`. The root `.mcp.json` has `run.sh`. On Windows,
  add the server in the local scope: `claude mcp add --scope local playwright-facade -- cmd /c
  <TOOL>\run.bat playwright`. The local scope wins over the project scope.
- Agent SDK: give `disallowedTools: ["mcp__playwright", "mcp__plugin_playwright_playwright"]`.

## Check the setup

1. Ask: "Open https://example.com with the playwright-facade tools and give the title."
2. Read the log: `<TOOL>/.local_assets/logs/playwright-facade.log`. It must have a `client_ready`
   entry with the name of the client, and a `tool_call` entry for `browser_navigate`.

| Symptom | Cause and correction |
| --- | --- |
| The server does not start, or it fails at the first start | The install takes too long. Run `run.sh install` or `run.bat install` first. |
| `error while loading shared libraries` in the log | Linux: a library has no package. See [README.md](../README.md#linux-libraries-and-fonts). |
| `Browser is already in use` | An other session uses the persistent profile. Add `--isolated`, or close the other session. |
| No window opens | The facade runs headless by default. Set `PLAYWRIGHT_MCP_HEADLESS=false` for a window. |
