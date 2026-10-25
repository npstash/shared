# claude-tool_playwright-facade

An MCP server for browser automation. It is a facade for
[Playwright MCP](https://github.com/microsoft/playwright-mcp) (`@playwright/mcp`):

```
MCP client (Claude Code) <-stdio-> facade <-stdio-> Playwright MCP (child process) -> browser
```

- The facade gives the tools of Playwright MCP (`browser_navigate`, `browser_fill_form`...).
- [Tool switches](#tool-switches) disable dangerous tools.
- [Placeholders](#placeholders) such as `{{password}}` keep user data and credentials away from the
  agent. Providers give the values: the vault, an INI file or a dialog for the user.
- [Host lists](#host-lists) block hosts and record the opened hosts.
- It writes a log of each call. See [Logs](#logs).
- It needs no root and no OS installs. It keeps the runtime, the browser, the missing Linux
  libraries, the profiles and the output files in the tool folder.
- At shutdown, it closes the browser. Then a persistent profile keeps its cookies and localStorage.

Documents (SDD): [PRD](sdd/PRD.md), [SRS](sdd/SRS.md), [QAS](sdd/QAS.md), [DESIGN](sdd/DESIGN.md),
[ADL](sdd/ADL.md). Open items: [DESIGN, section 11](sdd/DESIGN.md#11-open-issues).

For the setup in each Claude Code client (VSCode, CLI, Desktop app, Agent SDK, Cowork), see
[docs/clients.md](docs/clients.md).

## Run

```bash
./run.sh install          # make the runtime, install Chromium, then stop
./run.sh                  # start the MCP server on stdio
./run.sh --headless       # each argument goes to Playwright MCP
./run.sh test             # run the tests
run.bat install           # the same on Windows
```

- Do `install` one time before you add the server to a client. The first install downloads
  approximately 350 MB. A client can stop a server that does not start in time.
- `run.sh` and `run.bat` download a pinned Node.js into `.local_assets/runtime/`. Playwright needs
  Node.js 20 or later. The Node.js of the system stays unchanged.
- `run.sh` supports Linux and macOS (x64, arm64). `run.bat` supports Windows (x64, arm64).
- stdout is the MCP channel. The launchers write their messages to stderr.

### Linux: libraries and fonts

Chromium needs system libraries (e.g. `libnss3`). `run.sh` finds the missing ones with `ldd`,
downloads their Ubuntu packages with `apt-get download` and unpacks them into
`.local_assets/syslibs/<platform>/`. This needs no root. If the host has no fonts, it also gets
fonts. See [SRS REQ-012, REQ-013](sdd/SRS.md#2-runtime-and-portability).

- To do it again, delete `.local_assets/syslibs/`.
- If a library has no package, `run.sh` stops with its name. Add it to `EXCEPTIONS` in
  [src/setup/syslibs.js](src/setup/syslibs.js).
- In CI (`CI=true`), `run.sh` installs the OS packages with `--with-deps`. CI runners have sudo.

## Arguments and defaults

Each argument goes to Playwright MCP. For the list, run `./run.sh --help`. Examples:
`--headless`, `--isolated`, `--browser firefox`, `--user-data-dir <path>`, `--caps vision,pdf`.

The facade sets these defaults. An argument or an env variable of the user overrides each of them.

| Value | Default of the facade | Default of Playwright MCP |
| --- | --- | --- |
| Browser (`PLAYWRIGHT_MCP_BROWSER`) | `chromium`, installed by the launcher | `chrome` (Google Chrome of the system) |
| Browser files (`PLAYWRIGHT_BROWSERS_PATH`) | `.local_assets/browsers/<platform>/` | cache folder of the user |
| Profile (`PLAYWRIGHT_MCP_USER_DATA_DIR`) | `.local_assets/profiles/<platform>-<browser>-<workspace hash>/` | cache folder of the user |
| Output files (`PLAYWRIGHT_MCP_OUTPUT_DIR`) | `.local_assets/output/` | in the workspace |
| Temp files (`TMPDIR`, `TEMP`, `TMP`) | `.local_assets/tmp/` | temp folder of the OS |
| Browser registry (`XDG_CACHE_HOME`, Linux only) | `.local_assets/cache/` | `~/.cache/ms-playwright/b/` |

- The facade sets no profile with `--isolated`, `--user-data-dir`, `--cdp-endpoint`, `--extension`
  or `--endpoint`.
- With `--config <file>` or `PLAYWRIGHT_MCP_CONFIG`, the facade sets no `PLAYWRIGHT_MCP_*` default.
- The persistent profile keeps logins. Two sessions in the same workspace cannot use it at the same
  time. For parallel sessions, use `--isolated`.
- Chromium makes a Unix socket in the temp folder. Some file systems cannot hold one, e.g. a Windows
  drive in WSL (`/mnt/c`). Then the facade keeps the temp folder of the OS and logs `tmp_dir_fallback`.
- Playwright writes a registry of the open browsers (small JSON files) into the cache folder of the
  user. On Windows (`%LOCALAPPDATA%\ms-playwright\b\`) and macOS
  (`~/Library/Caches/ms-playwright/b/`), the facade cannot move it.

## Tool switches

[config/tools.ini](config/tools.ini) has one line for each tool: `<tool> = enabled` or
`<tool> = disabled`. At start, the facade adds the missing tools with their default.

- Disabled by default: `browser_run_code_unsafe`, `browser_evaluate`, `browser_file_upload` and
  `browser_drop`. A web page can misuse them through prompt injection.
- A disabled tool stays in the tool list with a note. A call to it fails with the reason.
- The switches act on the facade. Playwright MCP stays unchanged.

## Placeholders

The agent writes a placeholder in place of a value, e.g. `{{email}}` in `browser_fill_form`.
The facade asks the providers of `[fill] providers` in [config/facade.ini](config/facade.ini),
in that order. The first value goes to the browser. Each result shows the placeholder again, not
the value. The tool `fill_values_list` gives the placeholders of the current page.

| Provider | Config | Values |
| --- | --- | --- |
| vault | [providers/vault/config.ini](providers/vault/config.ini) | Secrets of the vault system whose `url` has the host of the page. The placeholder is the secret name, e.g. `{{password}}`. |
| ini | [providers/ini/config.ini](providers/ini/config.ini) | Values that are not secret: `[all]` for each host, `[<host pattern>]` for some hosts. |
| ask | [providers/ask/config.ini](providers/ask/config.ini) | A dialog of the client for the listed fields. Only clients with MCP elicitation. In `claude -p`, Claude Code cancels the dialog. |

If no provider has a value, the call fails. Nothing goes to the browser. To add a provider, see
[src/fill/provider.js](src/fill/provider.js).

## Host lists

[config/hosts.ini](config/hosts.ini) has two sections: `[deny]` and `[allow]`, one host pattern
on each line. Deny wins. Move a line between the sections to change the list.

- Patterns: `*` (each host), `*.example.com` (subdomains), `example.com` (exact), `192.168.1.*`
  (IPv4). A pattern has no scheme, port or path.
- The facade checks the URL before `browser_navigate`, and the page after each call (clicks,
  redirects). A blocked page is replaced by `about:blank`, and the call fails with the reason.
- The facade adds the host of each opened page to `[allow]`, also if a pattern covers it.
  `[hosts] record = false` in [config/facade.ini](config/facade.ini) stops this, e.g. for a
  shared list that a clone must not change.
- To add an other allow provider, see [src/hosts/allow-provider.js](src/hosts/allow-provider.js).

## Logs

The log is in `.local_assets/logs/playwright-facade.log` (gitignored). It has one JSON object on
each line. Above 10 MB, the facade moves the file to `playwright-facade.log.1` at start.

| Env variable | Default | Effect |
| --- | --- | --- |
| `PLAYWRIGHT_FACADE_LOG_FILE` | `.local_assets/logs/playwright-facade.log` | Path of the log file. |
| `PLAYWRIGHT_FACADE_LOG_LEVEL` | `info` | `error`, `info` or `debug`. `debug` adds the text of each result. |
| `PLAYWRIGHT_FACADE_LOG_SECRETS` | unset | `1` logs the values of `text`, `value`, `values` and `password`. |

Events: `upstream_start`, `upstream_ready`, `client_ready`, `list_tools`, `tool_call`,
`tool_result`, `tool_error`, `fill_value`, `host_blocked`, `host_recorded`, `tools_config_added`,
`upstream_stderr`, `tools_changed`, `shutdown`. Each entry has the
`session` field (the process ID). Use it to separate parallel sessions.

- By default, the log has no typed text and no form values: `"<redacted 8 chars>"`. A value with
  only placeholders stays, e.g. `"{{email}}"`. The log never has a value that a provider gave.
- At level `debug`, the result text can contain secrets: a snapshot shows the values of the fields.

Example:

```bash
tail -f .local_assets/logs/playwright-facade.log | jq -c '{ts, event, tool, ms, args}'
```

## Tests

`./run.sh test` runs the tests with `node --test`. Each test uses a copy of the config in
`.local_assets/test-config/`. The committed config stays unchanged.

- [tests/forms.test.js](tests/forms.test.js): form filling on local pages. It uses `browser_type`,
  `browser_fill_form` (textbox, checkbox, radio, combobox, slider), `browser_select_option`,
  `browser_press_key`, key events, required fields and fields that the page shows after a click.
- [tests/facade.test.js](tests/facade.test.js): the same tools as upstream, navigation, errors,
  screenshots, the log, the redaction and the persistent profile.
- [tests/online.test.js](tests/online.test.js): example.com, the order form of httpbin.org and the
  search of Wikipedia. A test is skipped when its site is not reachable. Set
  `PLAYWRIGHT_FACADE_OFFLINE=1` to skip all of them.
- [tests/policy.test.js](tests/policy.test.js): tool switches, host lists and placeholders with
  the three providers (the vault through a test double in `tests/fixtures/fake-vault/`).
- [tests/unit.test.js](tests/unit.test.js), [tests/policy-unit.test.js](tests/policy-unit.test.js):
  redaction, defaults, INI files, host patterns, providers, the library mapping.

## Update Playwright MCP

1. Change the version of `@playwright/mcp` in `package.json`.
2. Run `npm install` with the Node.js of `.local_assets/runtime/` to update `package-lock.json`.
3. Run `./run.sh test`. The launcher installs the new Chromium.
