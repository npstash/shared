# Playwright facade

The facade of [Playwright MCP](https://github.com/microsoft/playwright-mcp) (`@playwright/mcp`),
in the tool [browser-tool-facades](../README.md). MCP server name: `playwright-facade`.

```
MCP client (Claude Code) <-stdio-> facade <-stdio-> Playwright MCP (child process) -> Chromium
```

- It gives the tools of Playwright MCP (`browser_navigate`, `browser_fill_form`...).
- [Tool switches](#tool-switches) disable dangerous tools.
- Placeholders in `browser_type`, `browser_fill_form` and `browser_select_option`, and the host
  lists: see the [tool README](../README.md#placeholders).
- It writes a log of each call. See [Logs](#logs).
- It needs no root and no OS installs. The runtime, Chromium, the missing Linux libraries, the
  profiles and the output files stay in the tool folder.
- At shutdown, it closes the browser. Then a persistent profile keeps its cookies and localStorage.

Start: `../run.sh playwright [args]` (see [Run](../README.md#run)). Client setup:
[docs/clients.md](docs/clients.md).

## Linux: libraries and fonts

Chromium needs system libraries (e.g. `libnss3`). `run.sh` finds the missing ones with `ldd`,
downloads their Ubuntu packages with `apt-get download` and unpacks them into
`.local_assets/syslibs/<platform>/` of the tool. This needs no root. If the host has no fonts, it
also gets fonts. See [SRS REQ-012, REQ-013](../sdd/SRS.md#2-runtime-and-portability).

- To do it again, delete `.local_assets/syslibs/`.
- If a library has no package, `run.sh` stops with its name. Add it to `EXCEPTIONS` in
  [src/setup/syslibs.js](src/setup/syslibs.js).
- In CI (`CI=true`), `run.sh` installs the OS packages with `--with-deps`. CI runners have sudo.

## Arguments and defaults

Each argument after `playwright` goes to Playwright MCP. For the list, run
`../run.sh playwright --help`. Examples: `--isolated`, `--browser firefox`,
`--user-data-dir <path>`, `--caps vision,pdf`.

The facade sets these defaults. An argument or an env variable of the user overrides each of them.

| Value | Default of the facade | Default of Playwright MCP |
| --- | --- | --- |
| Browser (`PLAYWRIGHT_MCP_BROWSER`) | `chromium`, installed by the launcher | `chrome` (Google Chrome of the system) |
| Headless (`PLAYWRIGHT_MCP_HEADLESS`) | `true`: no window. Set `false` for a window. | a window if the host has a display (also WSLg) |
| Browser files (`PLAYWRIGHT_BROWSERS_PATH`) | `.local_assets/browsers/<platform>/` | cache folder of the user |
| Profile (`PLAYWRIGHT_MCP_USER_DATA_DIR`) | `.local_assets/profiles/<platform>-<browser>-<workspace hash>/` | cache folder of the user |
| Output files (`PLAYWRIGHT_MCP_OUTPUT_DIR`) | `.local_assets/output/` | in the workspace |
| Temp files (`TMPDIR`, `TEMP`, `TMP`) | `.local_assets/tmp/` | temp folder of the OS |
| Browser registry (`XDG_CACHE_HOME`, Linux only) | `.local_assets/cache/` | `~/.cache/ms-playwright/b/` |

The paths are in the tool folder.

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

[config/tools.ini](config/tools.ini) has one line for each tool of this facade: `<tool> = enabled`
or `<tool> = disabled`. At start, the facade adds the missing tools with their default.

- Disabled by default: `browser_run_code_unsafe`, `browser_evaluate`, `browser_file_upload` and
  `browser_drop`. A web page can misuse them through prompt injection.
- A disabled tool stays in the tool list with a note. A call to it fails with the reason.
- The switches act on the facade. Playwright MCP stays unchanged.

## Logs

The log is in `.local_assets/logs/playwright-facade.log` of the tool (gitignored). It has one JSON
object on each line. Above 10 MB, the facade moves the file to `playwright-facade.log.1` at start.

| Env variable | Default | Effect |
| --- | --- | --- |
| `PLAYWRIGHT_FACADE_LOG_FILE` | `.local_assets/logs/playwright-facade.log` | Path of the log file. |
| `PLAYWRIGHT_FACADE_LOG_LEVEL` | `info` | `error`, `info` or `debug`. `debug` adds the text of each result. |
| `PLAYWRIGHT_FACADE_LOG_SECRETS` | unset | `1` logs the values of `text`, `value`, `values` and `password`. |

Events: `upstream_start`, `upstream_ready`, `client_ready`, `list_tools`, `tool_call`,
`tool_result`, `tool_error`, `fill_value`, `host_blocked`, `host_recorded`, `tools_config_added`,
`upstream_stderr`, `tools_changed`, `shutdown`. Each entry has the `session` field (the process
ID). Use it to separate parallel sessions.

- By default, the log has no typed text and no form values: `"<redacted 8 chars>"`. A value with
  only placeholders stays, e.g. `"{{email}}"`. The log never has a value that a provider gave.
- At level `debug`, the result text can contain secrets: a snapshot shows the values of the fields.

```bash
tail -f ../.local_assets/logs/playwright-facade.log | jq -c '{ts, event, tool, ms, args}'
```

## Tests

- [tests/forms.test.js](tests/forms.test.js): form filling on local pages. It uses `browser_type`,
  `browser_fill_form` (textbox, checkbox, radio, combobox, slider), `browser_select_option`,
  `browser_press_key`, key events, required fields and fields that the page shows after a click.
- [tests/facade.test.js](tests/facade.test.js): the same tools as upstream, navigation, errors,
  screenshots, the log, the redaction and the persistent profile.
- [tests/online.test.js](tests/online.test.js): example.com, the order form of httpbin.org and the
  search of Wikipedia. A test is skipped when its site is not reachable. Set
  `PLAYWRIGHT_FACADE_OFFLINE=1` to skip all of them.
- [tests/policy.test.js](tests/policy.test.js): tool switches, host lists and placeholders with
  the three providers.
- [tests/unit.test.js](tests/unit.test.js): redaction, defaults, the library mapping.

## Update Playwright MCP

1. Change the version of `@playwright/mcp` in `../package.json`.
2. Run `npm install` in the tool folder with the Node.js of `.local_assets/runtime/` to update
   `package-lock.json`.
3. Run `../run.sh test`. The launcher installs the new Chromium.
