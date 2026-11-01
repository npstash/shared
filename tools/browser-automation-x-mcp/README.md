# browser-automation-x-mcp

Facades for the browser tools of AI agents. A facade puts tool switches, a form fill, host lists
and a log between the agent and a browser tool.

The facade is opaque to the agents. An agent sees the MCP server `browser-automation-x-mcp` and the
browser tools. No text for the agent names the facade, Playwright, the form fill or its providers.
The deny rules of the agent tools close this folder and the config folder to the agents (see
[Deny rules](#deny-rules)). Keep each link to this folder out of the files that agents read.

| Facade | Folder | Browser tool | State |
| --- | --- | --- | --- |
| Playwright facade (MCP server `browser-automation-x-mcp`) | `playwright/` | [Playwright MCP](https://github.com/microsoft/playwright-mcp) (`@playwright/mcp`) | done |
| Facade of the desktop app browser | — | The browser that Claude opens in a chat of the Claude desktop app | planned |

Documents (SDD): [PRD](sdd/PRD.md), [SRS](sdd/SRS.md), [QAS](sdd/QAS.md), [DESIGN](sdd/DESIGN.md),
[ADL](sdd/ADL.md). Open items: [DESIGN, section 11](sdd/DESIGN.md#11-open-issues).

```
MCP client (Claude Code) <-stdio-> facade <-stdio-> Playwright MCP (child process) -> Chromium
```

## Structure

```
run.sh run.bat                launcher of all facades; one runtime for all
package.json                  Node.js packages of all facades
config/                       templates of the shared config files
providers-form-fill/<name>/   form-fill providers: index.js, config.template.ini
src/                          shared code: INI files, logger, tool switches, host lists, form fields
tests/                        tests of the shared code
<facade>/                     one folder for each facade: src/, config/tools.template.ini, tests/
sdd/                          documents of the tool
```

## Run

```bash
./run.sh install                                              # make the runtime, install the browsers, then stop
./run.sh playwright --config-dir <DIR>                        # start the Playwright facade (MCP server on stdio)
./run.sh playwright --config-dir <DIR> --isolated             # each other argument goes to Playwright MCP
./run.sh test                                                 # the tests of the shared code and of each facade
run.bat install                                               # the same on Windows
```

- Do `install` one time before you add the server to a client. The first install downloads
  approximately 350 MB. A client can stop a server that does not start in time.
- `--config-dir` is necessary. A relative path is relative to the working folder. See
  [Config folder](#config-folder).
- `run.sh` and `run.bat` download a pinned Node.js into `.local_assets/runtime/`. The Node.js of
  the system stays unchanged.
- `run.sh` supports Linux and macOS (x64, arm64). `run.bat` supports Windows (x64, arm64).
- stdout is the MCP channel. The launchers write their messages to stderr.

## Client setup

Give the server the name `browser-automation-x-mcp`. The tool names are then
`mcp__browser-automation-x-mcp__browser_navigate` etc. The rule `browser-automation` uses this name.

This repository loads the server for each Claude Code session (VSCode, CLI, Desktop app): the root
`.mcp.json` has the server, and the root `.claude/settings.json` approves it. Kilo has the same
entry in `.kilo/kilo.jsonc`.

| Claude Code runs in | `command` | `args` |
| --- | --- | --- |
| Linux, macOS, WSL | `<TOOL>/run.sh` | `["playwright", "--config-dir", "<DIR>"]` |
| Windows (native) | `cmd` | `["/c", "<TOOL>\\run.bat", "playwright", "--config-dir", "<DIR>"]` |
| Windows, browser in WSL | `wsl.exe` | `["<TOOL in WSL>/run.sh", "playwright", "--config-dir", "<DIR>"]` |

`<TOOL>` is the path of this folder. A client cannot start a `.bat` file directly on Windows. Use
`cmd /c`.

- **`.mcp.json` (project):** Claude Code asks for an approval at the first start, or
  `enabledMcpjsonServers` in `.claude/settings.json` approves it.

  ```json
  {
    "mcpServers": {
      "browser-automation-x-mcp": {
        "type": "stdio",
        "command": "shared/tools/browser-automation-x-mcp/run.sh",
        "env": { "RENDER_MODE": "DEFAULT" },
        "args": ["playwright", "--config-dir", "local/configs/browser-automation-x-mcp"]
      }
    }
  }
  ```

- **CLI, user scope:** `claude mcp add --scope user browser-automation-x-mcp -- <TOOL>/run.sh playwright --config-dir <DIR>`.
  Check with `claude mcp list`. In a session, `/mcp` shows the state.
- **VSCode:** the extension uses the configuration of the CLI. If VSCode runs in WSL, run
  `claude mcp add` in the WSL terminal and use `run.sh`.
- **Native Windows:** the root `.mcp.json` has `run.sh`. Add the server in the local scope, which
  wins over the project scope: `claude mcp add --scope local browser-automation-x-mcp -- cmd /c <TOOL>\run.bat playwright --config-dir <DIR>`.
- **Desktop app (Code tab):** uses the configuration of Claude Code on the same computer.
- **Agent SDK:** give the server in `mcp_servers` / `mcpServers` of the options, and allow
  `mcp__browser-automation-x-mcp__*`. Use `--isolated` if the wrapper runs more than one session
  at the same time. An `env` entry goes to the facade and to Playwright MCP.

  ```python
  options = ClaudeAgentOptions(
      mcp_servers={"browser-automation-x-mcp": {"type": "stdio", "command": "<TOOL>/run.sh",
                   "args": ["playwright", "--config-dir", "<DIR>", "--isolated"]}},
      allowed_tools=["mcp__browser-automation-x-mcp__*"],
      disallowed_tools=["mcp__playwright", "mcp__plugin_playwright_playwright"],
  )
  ```

- **Cowork (not verified):** add the server to `claude_desktop_config.json` (Settings > Developer >
  Edit Config), quit the app and start it again. If Cowork does not show the tools, it cannot use
  local MCP servers in this version.

To block an other Playwright MCP, add these lines to `permissions.deny` of `.claude/settings.json`:
`mcp__playwright`, `mcp__plugin_playwright_playwright`, `Bash(npx @playwright/mcp:*)`,
`Bash(npx playwright:*)`.

Check the setup: ask "Open https://example.com and give the title." Then read the log: it must have
a `client_ready` entry and a `tool_call` entry for `browser_navigate`.

| Symptom | Cause and correction |
| --- | --- |
| The server does not start, or it fails at the first start | The install takes too long. Run `run.sh install` or `run.bat install` first. |
| `error while loading shared libraries` in the log | Linux: a library has no package. See [Linux: libraries and fonts](#linux-libraries-and-fonts). |
| `Browser is already in use` | An other session uses the persistent profile. Add `--isolated`, or close the other session. |
| No window opens | On WSL and without a display, the default is `HEADED_INVISIBLE`. Set `RENDER_MODE=HEADED`. |

## Deny rules

The deny rules close this folder, the config folder and `.mcp.json` to the agents. Put them into
`permissions.deny` of the root `.claude/settings.json`, and the matching settings into the config
of the other agent tools (`.kilo/kilo.jsonc`, `.continue/`).

- The output folder (`.local_assets/browser-automation-x-mcp/output/` of the working folder) stays
  open. The agents read the snapshots and the screenshots there.
- A deny rule does not stop each shell command. An agent with a shell can still read the files.
- The rules also stop an agent that must change this tool or the config. For such work, remove the
  rules for the session, then put them back.

## Config folder

`--config-dir` gives the config folder, e.g. `local/configs/browser-automation-x-mcp`. A missing
file is first a copy of its template in this folder.

| File | Content | Template |
| --- | --- | --- |
| `facade.ini` | `[fill] providers`: provider order; `[mask]`: masked providers; `[hosts] record` | `config/facade.template.ini` |
| `fields.ini` | form fields for each URL pattern | `config/fields.template.ini` |
| `host-policy.ini` | `[deny]` and `[allow]` host patterns | `config/host-policy.template.ini` |
| `playwright-tools.ini` | tool switches of the Playwright facade | `playwright/config/tools.template.ini` |
| `provider-<name>.ini` | config of one form-fill provider | `providers-form-fill/<name>/config.template.ini` |

## Form fill

The agent never fills credentials or personal data. After each call, the facade checks the page.
If `fields.ini` has a section for the URL, the facade fills the fields and submits the form. The
agent gets the page after the submit. It does not know about the fill.

```ini
[login.microsoftonline.com/*/oauth2/*]
username = input[name="loginfmt"]
password = input[name="passwd"]
; submit = button[type="submit"]
```

- **URL pattern:** `host/path`. The host part is a host pattern (see [Host lists](#host-lists)). In
  the path, `*` matches each sequence of characters, also `/`. A pattern without a path matches
  each path. Scheme, port, query and fragment have no effect.
- **Lines:** `<field name> = <CSS selector>`. The facade looks for the selector in each frame of the
  page. If more sections match, all apply. For a field name in more sections, the longer pattern
  wins.
- **Wait:** the facade waits a maximum of 10 s for a visible field. It waits only one time for each
  URL, and after each submit.
- **Values:** for each visible field, the facade asks the providers of `[fill] providers` in
  `facade.ini`, in that order. The first value goes to the field. A field without a value stays
  empty. If no field has a value, the facade does nothing.
- **Submit:** the facade clicks the `submit` selector if it is visible. Else it calls
  `requestSubmit()` of the form, else it presses Enter in the last field. Then it waits a maximum
  of 10 s for the page. A second step on the same URL, e.g. the password after the username, gets
  a fill in the same call. Maximum 3 rounds.
- **Loop guard:** the facade fills each set of visible fields of a form one time. If the same fields
  come back, e.g. after a wrong password, it does not fill them again. The log gets `fill_failed`.
  The guard is reset when a page does not match `fields.ini`.
- **Mask:** `[mask] <provider> = true` in `facade.ini` replaces the values of the provider with
  `***` in each result and in each text file of the output folder. A provider without a line is
  masked. Binary files, e.g. screenshots, stay unchanged.
- **Errors:** a provider error or a page error goes only to the log. The agent gets the page as it
  is.

| Provider | Config | Values |
| --- | --- | --- |
| vault | `provider-vault.ini`: `[vault] vault = vault-<name>`; `[systems] <host or URL prefix> = <system name>` | The secret of the vault system for the host. The field name is the secret name, e.g. `password`. |
| ini | `provider-ini.ini`: `[values] <field name> = <value>` | Values that are not secret. |
| ask | `provider-ask.ini`: `[ask] fields = phone, ...` | A dialog of the client for the listed field names. Only clients with MCP elicitation. In `claude -p`, Claude Code cancels the dialog. Do not list passwords: the MCP specification does not allow this dialog for sensitive data. |

To add a provider, see [src/fill/provider.js](src/fill/provider.js).

### Find the fields of a page (discovery)

1. Start the facade with `BROWSER_AUTOMATION_X_MCP_DISCOVER=1`, e.g. in the `env` of `.mcp.json`.
2. Open each login page in a session. On a page with more steps, do the steps: the facade records
   each step.
3. The facade writes `.local_assets/discovered-fields.ini` of this folder. Each section is the URL
   pattern of a page. Path segments that look like an ID are `*`. Each field has a comment line
   with its type, name, label and frame, and a proposed line `<field name> = <selector>`.
4. Copy the lines of the username and password fields into `fields.ini`. Check that the section
   pattern covers each URL of the login.
5. Give the vault system of the host the secrets with these field names, e.g. `username` and
   `password`. Add the host to `[systems]` of `provider-vault.ini`.
6. Remove `BROWSER_AUTOMATION_X_MCP_DISCOVER`.

An agent can do steps 2–4 in a test run. Remove the deny rules for that session. Tell the agent to
open the login pages, to read `discovered-fields.ini`, and to propose only the username and
password lines with their sections. Confirm the lines before the agent writes them into
`fields.ini`.

## Host lists

`host-policy.ini` of the config folder has two sections: `[deny]` and `[allow]`, one host pattern on
each line. Deny wins. Move a line between the sections to change the list. All facades use it.

- Patterns: `*` (each host), `*.example.com` (subdomains), `example.com` (exact), `192.168.1.*`
  (IPv4). A pattern has no scheme, port or path.
- The facade checks the URL before it opens a page, and the page after each call (clicks,
  redirects, submits). A blocked page is replaced by `about:blank`, and the call fails.
- The facade adds the host of each opened page to `[allow]`, also if a pattern covers it.
  `[hosts] record = false` in `facade.ini` stops this.
- To add an other allow provider, see [src/hosts/allow-provider.js](src/hosts/allow-provider.js).

## Tool switches

`playwright-tools.ini` has one line for each tool: `<tool> = enabled` or `<tool> = disabled`. At
start, the facade adds the missing tools with their default.

- Disabled by default: `browser_run_code_unsafe`, `browser_evaluate`, `browser_file_upload` and
  `browser_drop`. A web page can misuse them through prompt injection.
- A disabled tool stays in the tool list with a note. A call to it fails with the reason.
- The form fill uses `browser_run_code_unsafe` of Playwright MCP also when the switch disables it.
- `browser_evaluate` can read a value that stays in a field after a failed submit.

## Render mode

Some sites block a headless browser. Thus the facade never runs headless by default. `RENDER_MODE`
selects the mode:

| Value | Host with a display | WSL | Linux without a display |
| --- | --- | --- | --- |
| `DEFAULT` (not set) | `HEADED` | `HEADED_INVISIBLE` | `HEADED_INVISIBLE` |
| `HEADED` | a window | a window (WSLg) | `HEADED_INVISIBLE` |
| `HEADED_INVISIBLE` | Xvfb on Linux; else an error | Xvfb | Xvfb |
| `HEADLESS` | no window | no window | no window |

- `HEADED_INVISIBLE` runs a headed browser on Xvfb, a virtual display. Nobody sees the window.
- Only `HEADLESS` gives a headless browser. If a mode is not possible, the facade stops with an
  error.
- The facade ignores `--headless` and `PLAYWRIGHT_MCP_HEADLESS`. The render mode also applies with
  `--config`.
- `run.sh install` unpacks Xvfb into this folder on Linux. No root. The facade starts Xvfb on the
  first free display from `:99`, only on the abstract socket of Linux, and stops it at the end.
  After a SIGKILL of the facade, the kernel stops Xvfb. The next start kills a leftover Xvfb.
- To solve a challenge of a site, use `HEADED` on a host with a display. The persistent profile
  keeps the result.

## Linux: libraries and fonts

Chromium needs system libraries (e.g. `libnss3`). `run.sh` finds the missing ones with `ldd`,
downloads their Ubuntu packages with `apt-get download` and unpacks them into
`.local_assets/syslibs/<platform>/`. This needs no root. If the host has no fonts, it also gets
fonts.

- To do it again, delete `.local_assets/syslibs/`.
- If a library has no package, `run.sh` stops with its name. Add it to `EXCEPTIONS` in
  [playwright/src/setup/syslibs.js](playwright/src/setup/syslibs.js).
- In CI (`CI=true`), `run.sh` installs the OS packages with `--with-deps`. CI runners have sudo.

## Arguments and defaults

Each argument after `playwright`, except `--config-dir`, goes to Playwright MCP. For the list, run
`./run.sh playwright --config-dir <DIR> --help`.

| Value | Default of the facade | Default of Playwright MCP |
| --- | --- | --- |
| Browser (`PLAYWRIGHT_MCP_BROWSER`) | `chromium`, installed by the launcher | `chrome` |
| Render mode (`RENDER_MODE`) | `DEFAULT`: never headless | a window if the host has a display |
| Browser files (`PLAYWRIGHT_BROWSERS_PATH`) | `.local_assets/browsers/<platform>/` | cache folder of the user |
| Profile (`PLAYWRIGHT_MCP_USER_DATA_DIR`) | `.local_assets/profiles/<platform>-<browser>-<workspace hash>/` | cache folder of the user |
| Output files (`PLAYWRIGHT_MCP_OUTPUT_DIR`) | `.local_assets/browser-automation-x-mcp/output/` of the working folder | in the workspace |
| Temp files (`TMPDIR`, `TEMP`, `TMP`) | `.local_assets/tmp/` | temp folder of the OS |
| Browser registry (`XDG_CACHE_HOME`, Linux only) | `.local_assets/cache/` | `~/.cache/ms-playwright/b/` |

- An argument or an env variable of the user overrides each default.
- The facade sets no profile with `--isolated`, `--user-data-dir`, `--cdp-endpoint`, `--extension`
  or `--endpoint`. With `--config <file>` or `PLAYWRIGHT_MCP_CONFIG`, it sets no `PLAYWRIGHT_MCP_*`
  default.
- The persistent profile keeps logins. Two sessions in the same workspace cannot use it at the same
  time. For parallel sessions, use `--isolated`.
- Chromium makes a Unix socket in the temp folder. If this folder cannot hold it, the facade uses
  `.local_assets/tmp/` of the repository root, else the temp folder of the OS. It logs
  `tmp_dir_fallback`.
- On Windows and macOS, Playwright writes a registry of the open browsers into the cache folder of
  the user. The facade cannot move it.
- `--save-session` of Playwright MCP writes the code of the form fill, with the values, into the
  output folder. Do not use it.

## Logs

The log is `.local_assets/logs/browser-automation-x-mcp.log` of this folder. It has one JSON object
on each line. Above 10 MB, the facade moves the file to `.log.1` at start.

| Env variable | Default | Effect |
| --- | --- | --- |
| `BROWSER_AUTOMATION_X_MCP_LOG_FILE` | `.local_assets/logs/browser-automation-x-mcp.log` | Path of the log file. |
| `BROWSER_AUTOMATION_X_MCP_LOG_LEVEL` | `info` | `error`, `info` or `debug`. `debug` adds the text of each result. |
| `BROWSER_AUTOMATION_X_MCP_LOG_SECRETS` | unset | `1` logs the values of `text`, `value`, `values` and `password`. |

Events of the form fill: `fill_providers`, `fill_value` (field and provider, no value),
`fill_submitted`, `fill_failed`, `fill_no_value`, `fill_error`, `fields_discovered`, `scrub_file`.
Other events: `upstream_start`, `upstream_ready`, `client_ready`, `list_tools`, `tool_call`,
`tool_result`, `tool_error`, `host_blocked`, `host_recorded`, `tools_config_added`,
`upstream_stderr`, `tools_changed`, `shutdown`. Each entry has the `session` field (the process ID).

- By default, the log has no typed text and no form values: `"<redacted 8 chars>"`. The log never
  has a value that a provider gave.
- At level `debug`, the result text can contain values that are not masked.

```bash
tail -f .local_assets/logs/browser-automation-x-mcp.log | jq -c '{ts, event, tool, ms, args}'
```

## Tests

`./run.sh test` runs the tests with `node --test`. Each test uses a copy of the config in
`.local_assets/test-config/`. The committed config stays unchanged.

- [tests/policy-unit.test.js](tests/policy-unit.test.js): INI files, host patterns and lists, tool
  switches, URL patterns, the fill registry and the three providers (the vault through the test
  double in [tests/fixtures/fake-vault/](tests/fixtures/fake-vault/)).
- [playwright/tests/policy.test.js](playwright/tests/policy.test.js): tool switches, host lists,
  form fill (fill, submit, mask, loop guard, two steps), discovery.
- [playwright/tests/facade.test.js](playwright/tests/facade.test.js): the same tools as upstream,
  the texts for the client, navigation, errors, screenshots, the log and the persistent profile.
- [playwright/tests/forms.test.js](playwright/tests/forms.test.js): form tools of the agent on local
  pages.
- [playwright/tests/online.test.js](playwright/tests/online.test.js): public sites. A test is
  skipped when its site is not reachable. Set `BROWSER_AUTOMATION_X_MCP_OFFLINE=1` to skip all of
  them.
- [playwright/tests/unit.test.js](playwright/tests/unit.test.js),
  [playwright/tests/xvfb.test.js](playwright/tests/xvfb.test.js): redaction, defaults, the library
  mapping, Xvfb.

## Update Playwright MCP

1. Change the version of `@playwright/mcp` in `package.json`.
2. Run `npm install` in this folder with the Node.js of `.local_assets/runtime/` to update
   `package-lock.json`.
3. Run `./run.sh test`. The launcher installs the new Chromium.

## Add a facade

1. Make `<facade>/src/server.js` (an MCP server on stdio), `<facade>/config/tools.template.ini` and
   `<facade>/tests/`.
2. Use the shared code of [src/](src/): `ToolsConfig` with the dangerous tools of the browser tool,
   `FillRegistry` and `FieldsConfig` for the form fill, `HostPolicy` with `host-policy.ini`.
3. Add the steps for its browser to `run.sh` and `run.bat`, and a row to the table at the top.
