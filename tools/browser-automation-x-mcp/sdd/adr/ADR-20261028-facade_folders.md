# ADR-20261028-facade_folders — One folder for each facade, shared providers and config

- ADL entry: `20261028-02` in [ADL.md](../ADL.md)
- Name: Nestor
- Commit: 14e8c70de325
- Status: Accepted

## Context

The tool started as one facade: the Playwright facade (`claude-tool_playwright-facade`). Some
sites block the automated browser of Playwright, but open in the browser that Claude uses in a
chat of the Claude desktop app. A facade for that browser tool is planned
([ADL 20261028-01](../ADL.md)). The tool was renamed to `browser-tool-facades`.

A facade adds tool switches, placeholders for form values, host lists and a log to a browser
tool. Most of this does not depend on the browser tool:

- the form-fill providers (vault, INI file, dialog) and their configs;
- the provider order and the recording flag (`facade.ini`);
- the host list (`hosts.ini`): a host that is denied for one browser must be denied for all;
- the code for INI files, logging, host policy, placeholders and tool switches;
- the launcher and the runtime (Node.js, npm packages).

Other parts depend on the browser tool: the tool names (`tools.ini`), the dangerous tools, the
arguments that hold placeholders, the connection to the browser tool, and its browser setup
(for Playwright: Chromium and the missing Linux libraries).

## Options and evaluation

| Option | Evaluation |
| --- | --- |
| a) One tool folder for each facade (e.g. a second tool beside this one) | Simple folders, but the providers, the host list and the core code are copied or shared across tools. Two host lists can disagree. |
| b) One tool, one folder for each facade, shared parts at the tool root | One host list and one set of providers for all facades. One runtime and one launcher. The shared code needs parameters for the parts that depend on the browser tool. |
| c) One MCP server with a backend for each browser tool | One process and one tool list for all browser tools. The tools of the desktop app browser run inside the client; a separate process probably cannot call them. Tool names of two browser tools can collide. |

## Decision

Option b.

- Each facade has its own folder, e.g. `playwright/`, with `src/server.js`, `config/tools.ini`,
  `tests/`, `docs/` and `README.md`.
- All facades share `providers-form-fill/` (renamed from `providers/`), `config/facade.ini`,
  `config/hosts.ini`, the code in `src/`, the launcher and the runtime
  ([ADL 20261028-03](../ADL.md)).
- The shared code takes the parts that depend on the browser tool as parameters: the dangerous
  tools (`ToolsConfig`) and the fill arguments (`FillRegistry`).
- The first argument of `run.sh` / `run.bat` selects the facade, e.g. `run.sh playwright`
  ([ADL 20261028-04](../ADL.md)).

## Consequences

- A new facade adds a folder, its steps in the launcher and a row in the README. It uses the
  shared providers, host list and code without a copy.
- The MCP clients start a facade with its name: `.mcp.json` has `"args": ["playwright"]`.
- The tool has one SDD for all facades. DESIGN shows the shared parts and each facade.
- The test runner runs `tests/` and `<facade>/tests/`. CI finds one test folder for the tool.
- The env variables of the shared config are `BROWSER_FACADES_CONFIG_DIR` and
  `BROWSER_FACADES_PROVIDERS_CONFIG_DIR`. `PLAYWRIGHT_FACADE_CONFIG_DIR` is the folder of the
  `tools.ini` of the Playwright facade.
- A change in the shared code affects each facade. The tests of each facade must pass.
- If the second facade cannot run as an MCP server on stdio, it uses only a part of the shared
  code. The structure does not need a change for this.

## Related ADL items

- `20261028-01` Hold facades for more browser tools in this tool
- `20261028-03` Share config, launcher, runtime and core code; keep tools.ini, dangerous
  tools and fill arguments in each facade
- `20261028-04` Select the facade with the first argument of run.sh / run.bat
- `20261025-10` Give each fill provider its own folder and its own committed config file

## Related Design items

- [DESIGN](../DESIGN.md) section 1 (overview), section 4 (containers), section 5.1 (components),
  section 8 (data model)

## Related Quality Attributes

- [QAS-002](../QAS.md#qas-002--no-filled-value-reaches-the-client),
  [QAS-003](../QAS.md#qas-003--a-denied-host-does-not-stay-open),
  [QAS-004](../QAS.md#qas-004--a-disabled-tool-does-not-run): each facade must meet them with
  the shared code.

## Related Requirements

SRS requirement IDs: REQ-010, REQ-020, REQ-021, REQ-030, REQ-031, REQ-034, REQ-035, REQ-036,
REQ-040, REQ-041, REQ-042
