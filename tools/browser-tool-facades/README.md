# browser-tool-facades

Facades for the browser tools of AI agents. A facade puts tool switches, placeholders for user
data, host lists and a log between the agent and a browser tool.

| Facade | Folder | Browser tool | State |
| --- | --- | --- | --- |
| Playwright facade (MCP server `playwright-facade`) | [playwright/](playwright/README.md) | [Playwright MCP](https://github.com/microsoft/playwright-mcp) (`@playwright/mcp`) | done |
| Facade of the desktop app browser | — | The browser that Claude opens in a chat of the Claude desktop app | planned |

Documents (SDD): [PRD](sdd/PRD.md), [SRS](sdd/SRS.md), [QAS](sdd/QAS.md), [DESIGN](sdd/DESIGN.md),
[ADL](sdd/ADL.md). Open items: [DESIGN, section 11](sdd/DESIGN.md#11-open-issues).

## Structure

```
run.sh run.bat                launcher of all facades; one runtime for all
package.json                  Node.js packages of all facades
config/                       shared config: facade.ini, hosts.ini
providers-form-fill/<name>/   form-fill providers: index.js, config.ini
src/                          shared code: INI files, logger, tool switches, host lists, placeholders
tests/                        tests of the shared code
<facade>/                     one folder for each facade: src/server.js, config/, tests/, README.md
sdd/                          documents of the tool
```

- Shared by all facades: the form-fill providers, `config/facade.ini` (provider order, host
  recording) and `config/hosts.ini` (one host list for all browsers).
- Each facade has its own tool switches (`<facade>/config/tools.ini`), because each browser tool
  has its own tools.

## Run

```bash
./run.sh install                  # make the runtime and install the browsers, then stop
./run.sh playwright               # start the Playwright facade (an MCP server on stdio)
./run.sh playwright --isolated    # each argument after the facade name goes to the facade
./run.sh test                     # the tests of the shared code and of each facade
run.bat install                   # the same on Windows
```

- Do `install` one time before you add a facade to a client. The first install downloads
  approximately 350 MB. A client can stop a server that does not start in time.
- `run.sh` and `run.bat` download a pinned Node.js into `.local_assets/runtime/`. The Node.js of
  the system stays unchanged.
- `run.sh` supports Linux and macOS (x64, arm64). `run.bat` supports Windows (x64, arm64).
- stdout is the MCP channel. The launchers write their messages to stderr.

For the setup in each Claude Code client (VSCode, CLI, Desktop app, Agent SDK, Cowork), see
[playwright/docs/clients.md](playwright/docs/clients.md).

## Placeholders

The agent writes a placeholder in place of a value, e.g. `{{email}}`. The facade asks the
providers of `[fill] providers` in [config/facade.ini](config/facade.ini), in that order. The first
value goes to the browser. Each result shows the placeholder again, not the value. The tool
`fill_values_list` gives the placeholders of the current page.

| Provider | Config | Values |
| --- | --- | --- |
| vault | [providers-form-fill/vault/config.ini](providers-form-fill/vault/config.ini) | Secrets of the vault system whose `url` has the host of the page. The placeholder is the secret name, e.g. `{{password}}`. |
| ini | [providers-form-fill/ini/config.ini](providers-form-fill/ini/config.ini) | Values that are not secret: `[all]` for each host, `[<host pattern>]` for some hosts. |
| ask | [providers-form-fill/ask/config.ini](providers-form-fill/ask/config.ini) | A dialog of the client for the listed fields. Only clients with MCP elicitation. In `claude -p`, Claude Code cancels the dialog. |

If no provider has a value, the call fails. Nothing goes to the browser. To add a provider, see
[src/fill/provider.js](src/fill/provider.js).

## Host lists

[config/hosts.ini](config/hosts.ini) has two sections: `[deny]` and `[allow]`, one host pattern
on each line. Deny wins. Move a line between the sections to change the list. All facades use it.

- Patterns: `*` (each host), `*.example.com` (subdomains), `example.com` (exact), `192.168.1.*`
  (IPv4). A pattern has no scheme, port or path.
- A facade checks the URL before it opens a page, and the page after each call (clicks,
  redirects). A blocked page is replaced by `about:blank`, and the call fails with the reason.
- The facade adds the host of each opened page to `[allow]`, also if a pattern covers it.
  `[hosts] record = false` in [config/facade.ini](config/facade.ini) stops this, e.g. for a
  shared list that a clone must not change.
- To add an other allow provider, see [src/hosts/allow-provider.js](src/hosts/allow-provider.js).

## Tests

`./run.sh test` runs the tests with `node --test`: [tests/](tests/) for the shared code and
`<facade>/tests/` for each facade. Each test uses a copy of the config in
`.local_assets/test-config/`. The committed config stays unchanged.

- [tests/policy-unit.test.js](tests/policy-unit.test.js): INI files, host patterns and lists, tool
  switches, placeholders, the three providers (the vault through the test double in
  [tests/fixtures/fake-vault/](tests/fixtures/fake-vault/)).
- Tests of the Playwright facade: see [playwright/README.md](playwright/README.md#tests).

## Add a facade

1. Make `<facade>/src/server.js` (an MCP server on stdio), `<facade>/config/tools.ini`,
   `<facade>/tests/` and `<facade>/README.md`.
2. Use the shared code of [src/](src/): `ToolsConfig` with the dangerous tools of the browser tool,
   `FillRegistry` with the arguments that hold placeholders, `HostPolicy` with `config/hosts.ini`.
3. Add the steps for its browser to `run.sh` and `run.bat`, and a row to the table at the top.
