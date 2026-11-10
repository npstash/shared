# Product Requirements Document — browser-automation-x-mcp

Change the stable core of this document only through a pull request. The user stories are in the
table of section 7. They have no GitHub Issues yet.

## 1. Goal and context

- **Problem:** AI agents use Playwright MCP for browser automation. Playwright MCP needs system
  libraries on Linux, and it has no control of tools, form values or hosts. The agent can type
  personal data and credentials into the transcript. A web page can misuse dangerous tools through
  prompt injection.
- **Why now:** Agents in Claude Code (VSCode, CLI, Desktop app) and in wrappers with the Claude
  Agent SDK must fill forms on real sites, also on Ubuntu servers without root.
- **Vision:** A browser automation tool for agents. It gives the browser tools, keeps user data
  and credentials away from the agent, and controls tools and hosts. It runs on each computer
  without OS installs. The implementation uses Playwright MCP and Chromium only.
- **Opacity:** The agent does not know that Playwright or a form fill exists. It sees the server
  `browser-automation-x-mcp` and the browser tools. The server fills and submits the forms of the
  configured pages itself.

## 2. Target group

- **Main users:** AI agents in Claude Code (VSCode extension, CLI, Desktop app) and in wrappers
  with the Claude Agent SDK. The person who configures the server.
- **Personas / segments:** A developer on WSL or Linux. A wrapper that runs on Ubuntu Server or
  on GitHub runners.
- **Key needs:** The same tools as Playwright MCP. No root and no OS installs. Form values from
  a vault, a file or the user, never from the agent. Control of dangerous tools and of hosts.
  A log of each call.

## 3. Success criteria (metrics)

| Metric | Current state | Target |
| :-: | :-: | :-: |
| Hosts where `run.sh test` passes without root | WSL Ubuntu 24.04 | Also Ubuntu 22.04/24.04 Server and minimal images (QAS-001) |
| Resolved form values in results or log | 0 in the tests | 0 (QAS-002) |
| Calls of disabled tools that reach Playwright MCP | 0 in the tests | 0 (QAS-004) |

## 4. Scope

### In scope

- A stdio MCP server that forwards the tools of Playwright MCP.
- A launcher for Linux and macOS with a pinned Node.js, Chromium and missing Linux
  libraries, all in the tool folder.
- Tool switches in a committed config file.
- An automatic fill and submit of the fields that plugins find on a page, with values from
  plugins: vault, a JSON object. An approval of a fill by the user (dialog or approval service). A
  discovery recorder (a plugin) that writes the fields that the user fills into its file, with the
  keys of the values. New methods to find fields are new plugins.
- Texts for the agent that do not name Playwright or the form fill.
- A deny-list and an allow-list of hosts in one file of the config folder, with the record of opened hosts.
- A JSON Lines log of each call.
- Setup instructions for Claude Code in VSCode, the CLI, the Desktop app, the Agent SDK and Cowork.

### Out of scope (non-goals)

- An other browser tool or browser than Playwright MCP and Chromium.
- An HTTP transport for more clients at the same time.
- A network key-value-source and a pop-up for hosts that are not allowed (open items).
- Installs of OS packages.

## 5. Functional requirements

See [SRS.md](SRS.md).

## 6. Non-functional requirements

- **Portability:** [QAS-001](QAS.md#qas-001--portable-start-on-ubuntu)
- **Security:** [QAS-002](QAS.md#qas-002--no-filled-value-reaches-the-client), [QAS-003](QAS.md#qas-003--a-denied-host-does-not-stay-open), [QAS-004](QAS.md#qas-004--a-disabled-tool-does-not-run)
- **Performance:** [QAS-005](QAS.md#qas-005--overhead-of-the-server)
- **Scalability:** not applicable (one client for each process).
- **Availability:** not applicable (the client starts the server).

## 7. User stories (living layer — GitHub Issues)

| # | Story | Requirements | Milestone | Status | Link |
| :-: | :-: | :-: | :-: | :-: | :-: |
| 1 | As an agent, I use the browser tools of the server. | REQ-001–REQ-004 | v1 | done | MISSING: issue |
| 2 | As a user, I run the server on Ubuntu without root and without OS installs. | REQ-010–REQ-015 | v2 | done | MISSING: issue |
| 3 | As a user, I disable dangerous tools, and the agent sees why a call fails. | REQ-020, REQ-021 | v2 | done | MISSING: issue |
| 4 | As a user, I give form values from the vault, a file or a dialog; the server fills and submits the forms of configured pages, and the agent does not know it. | REQ-005, REQ-030–REQ-039 | v3 | done | MISSING: issue |
| 5 | As a user, I block hosts and keep a list of the opened hosts. | REQ-040–REQ-043 | v2 | done | MISSING: issue |
| 6 | As a user, I read a log of each call without secrets. | REQ-050, REQ-051 | v1 | done | MISSING: issue |
| 7 | As a user, I run a headed browser on a server without a display, and sites that block a headless browser accept it. | REQ-015, REQ-017, REQ-018 | v2 | done | MISSING: issue |
| 8 | As a user, I fill a form one time with the discovery recorder on; it writes the fields with the keys of my values, and later runs fill the form without a manual config. | REQ-031, REQ-039, REQ-039a, REQ-039b | v4 | done | MISSING: issue |
| 9 | As a user, I approve a fill with values of the vault before the server fills the form. | REQ-036a–REQ-036c | v4 | done | MISSING: issue |
