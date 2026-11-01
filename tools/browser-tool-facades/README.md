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
config/                       templates: facade.template.ini, host-policy.template.ini
providers-form-fill/<name>/   form-fill providers: index.js, config.template.ini
src/                          shared code: INI files, logger, tool switches, host lists, placeholders
tests/                        tests of the shared code
<facade>/                     one folder for each facade: src/server.js, config/tools.template.ini, tests/, README.md
sdd/                          documents of the tool
```

## Config folder

The config files are not in this folder. Give the config folder with `--config-dir DIR`, e.g.
`local/configs/browser-facade` of the repository (rule repo-structure). The argument is
necessary. A relative path is relative to the working folder of the client.

| File in the config folder | Template | Contents |
| --- | --- | --- |
| `facade.ini` | [config/facade.template.ini](config/facade.template.ini) | Provider order, host recording. All facades. |
| `host-policy.ini` | [config/host-policy.template.ini](config/host-policy.template.ini) | The host list. All facades. See "Host lists". |
| `<facade>-tools.ini` | `<facade>/config/tools.template.ini` | Tool switches of one facade, e.g. `playwright-tools.ini`. |
| `provider-<name>.ini` | `providers-form-fill/<name>/config.template.ini` | Config of one form-fill provider. |

- When a file is missing, the facade copies its template. Later template changes do not change
  an existing file.
- The facade writes `host-policy.ini` and `<facade>-tools.ini`. Commit the changes.

## Run

```bash
./run.sh install                  # make the runtime and install the browsers, then stop
./run.sh playwright --config-dir local/configs/browser-facade              # start the Playwright facade (an MCP server on stdio)
./run.sh playwright --config-dir local/configs/browser-facade --isolated   # each other argument goes to the facade
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
providers of `[fill] providers` in `facade.ini`, in that order. The first
value goes to the browser. Each result shows the placeholder again, not the value. The tool
`fill_values_list` gives the placeholders of the current page.

| Provider | Config | Values |
| --- | --- | --- |
| vault | `provider-vault.ini` ([template](providers-form-fill/vault/config.template.ini)) | Secrets of a vault system. See "Vault provider". The placeholder is the secret name, e.g. `{{password}}`. |
| ini | `provider-ini.ini` ([template](providers-form-fill/ini/config.template.ini)) | Values that are not secret: `[all]` for each host, `[<host pattern>]` for some hosts. |
| ask | `provider-ask.ini` ([template](providers-form-fill/ask/config.template.ini)) | A dialog of the client for the listed fields. Only clients with MCP elicitation. In `claude -p`, Claude Code cancels the dialog. |

If no provider has a value, the call fails. Nothing goes to the browser. To add a provider, see
[src/fill/provider.js](src/fill/provider.js).

### Vault provider

```ini
[vault]
vault = vault-main

[systems]
allegro.pl = Allegro - Jan
https://allegro.pl/login = Allegro login - Jan
```

- `vault` is the folder name of the vault. It has no default.
- Each line of `[systems]` gives a host or a URL prefix, and the exact name of a vault system.
  The provider does not search the vault. It uses only these systems.
- A host also matches its subdomains. If more lines match a page, the longest URL prefix of the
  page URL wins. An equal match is an error.
- The provider runs `get-system` and `get-secret` of the
  [vault tool](../auth/README.md) beside this tool.

## Host lists

`host-policy.ini` in the config folder has two sections: `[deny]` and `[allow]`, one host pattern
on each line. Deny wins. Move a line between the sections to change the list. All facades use it.

- Patterns: `*` (each host), `*.example.com` (subdomains), `example.com` (exact), `192.168.1.*`
  (IPv4). A pattern has no scheme, port or path.
- A facade checks the URL before it opens a page, and the page after each call (clicks,
  redirects). A blocked page is replaced by `about:blank`, and the call fails with the reason.
- The facade adds the host of each opened page to `[allow]`, also if a pattern covers it.
  `[hosts] record = false` in `facade.ini` stops this, e.g. for a shared list that a clone must
  not change.
- To add an other allow provider, see [src/hosts/allow-provider.js](src/hosts/allow-provider.js).

## Tests

`./run.sh test` runs the tests with `node --test`: [tests/](tests/) for the shared code and
`<facade>/tests/` for each facade. Each test uses its own config folder in
`.local_assets/test-config/`. The config of the repository stays unchanged.

- [tests/policy-unit.test.js](tests/policy-unit.test.js): INI files, host patterns and lists, tool
  switches, placeholders, the three providers (the vault through the test double in
  [tests/fixtures/fake-vault/](tests/fixtures/fake-vault/)).
- Tests of the Playwright facade: see [playwright/README.md](playwright/README.md#tests).

## Add a facade

1. Make `<facade>/src/server.js` (an MCP server on stdio) with `--config-dir`, `<facade>/config/tools.template.ini`,
   `<facade>/tests/` and `<facade>/README.md`.
2. Use the shared code of [src/](src/): `ToolsConfig` with the dangerous tools of the browser tool,
   `FillRegistry` with the arguments that hold placeholders, `HostPolicy` with `host-policy.ini`.
3. Add the steps for its browser to `run.sh` and `run.bat`, and a row to the table at the top.
