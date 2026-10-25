# Product Requirements Document — claude-tool_playwright-facade

Change the stable core of this document only through a pull request. The user stories are in the
table of section 7. They have no GitHub Issues yet.

## 1. Goal and context

- **Problem:** AI agents use Playwright MCP for browser automation. Playwright MCP needs system
  libraries on Linux, and it has no control of tools, form values or hosts. The agent can type
  personal data and credentials into the transcript. A web page can misuse dangerous tools through
  prompt injection.
- **Why now:** Agents in Claude Code (VSCode, CLI, Desktop app) and in wrappers with the Claude
  Agent SDK must fill forms on real sites, also on Ubuntu servers without root.
- **Vision:** One MCP server that gives the tools of Playwright MCP on each computer, without OS
  installs, and that keeps user data and credentials away from the agent.

## 2. Target group

- **Main users:** AI agents in Claude Code (VSCode extension, CLI, Desktop app) and in wrappers
  with the Claude Agent SDK. The person who configures the facade.
- **Personas / segments:** A developer on Windows or WSL. A wrapper that runs on Ubuntu Server or
  on GitHub runners.
- **Key needs:** The same tools as Playwright MCP. No root and no OS installs. Form values from
  a vault, a file or the user, never from the agent. Control of dangerous tools and of hosts.
  A log of each call.

## 3. Success criteria (metrics)

| Metric | Current state | Target |
| :-: | :-: | :-: |
| Hosts where `run.sh test` passes without root | WSL Ubuntu 24.04, Windows 11 | Also Ubuntu 22.04/24.04 Server and minimal images (QAS-001) |
| Resolved form values in results or log | 0 in the tests | 0 (QAS-002) |
| Calls of disabled tools that reach Playwright MCP | 0 in the tests | 0 (QAS-004) |

## 4. Scope

### In scope

- A stdio MCP server that forwards the tools of Playwright MCP.
- Launchers for Linux, macOS and Windows with a pinned Node.js, Chromium and missing Linux
  libraries, all in the tool folder.
- Tool switches in a committed config file.
- Placeholders in form values, filled by providers: vault, INI file, the user (dialog).
- A deny-list and an allow-list of hosts in one committed file, with the record of opened hosts.
- A JSON Lines log of each call.
- Setup instructions for Claude Code in VSCode, the CLI, the Desktop app, the Agent SDK and Cowork.

### Out of scope (non-goals)

- Composite tools that combine Playwright tools (open item, DESIGN section 11).
- An HTTP transport for more clients at the same time.
- A network fill provider and a pop-up allow provider (open items).
- Installs of OS packages.

## 5. Functional requirements

See [SRS.md](SRS.md).

## 6. Non-functional requirements

- **Portability:** [QAS-001](QAS.md#qas-001--portable-start-on-ubuntu)
- **Security:** [QAS-002](QAS.md#qas-002--no-filled-value-reaches-the-client), [QAS-003](QAS.md#qas-003--a-denied-host-does-not-stay-open), [QAS-004](QAS.md#qas-004--a-disabled-tool-does-not-run)
- **Performance:** [QAS-005](QAS.md#qas-005--overhead-of-the-facade)
- **Scalability:** not applicable (one client for each process).
- **Availability:** not applicable (the client starts the facade).

## 7. User stories (living layer — GitHub Issues)

| # | Story | Requirements | Milestone | Status | Link |
| :-: | :-: | :-: | :-: | :-: | :-: |
| 1 | As an agent, I use the tools of Playwright MCP through the facade. | REQ-001–REQ-004 | v1 | done | MISSING: issue |
| 2 | As a user, I run the facade on Ubuntu without root and without OS installs. | REQ-010–REQ-014 | v2 | done | MISSING: issue |
| 3 | As a user, I disable dangerous tools, and the agent sees why a call fails. | REQ-020, REQ-021 | v2 | done | MISSING: issue |
| 4 | As a user, I give form values from the vault, a file or a dialog; the agent writes only placeholders. | REQ-030–REQ-036 | v2 | done | MISSING: issue |
| 5 | As a user, I block hosts and keep a list of the opened hosts. | REQ-040–REQ-042 | v2 | done | MISSING: issue |
| 6 | As a user, I read a log of each call without secrets. | REQ-050, REQ-051 | v1 | done | MISSING: issue |
