# Software Requirements Specification (SRS) — browser-tool-facades

The required behaviour of the system. The system is "the facade". "Upstream" is Playwright MCP.
"The client" is the MCP client, e.g. Claude Code. The containers are in [DESIGN.md](DESIGN.md).

**Requirement format:** Structured

---

## 1. Proxy

#### REQ-001 — Forward the tools of upstream

- **Trigger:** The client sends `tools/list` or `tools/call`.
- **Basic Flow:** The facade shall forward the request to upstream and give the answer of upstream
  to the client. The names and input schemas of the tools shall stay the same.
- **Alternative Flow:**
  - `tools/list` → the facade adds its own tools (REQ-033) after the last page, notes for
    placeholders to the descriptions of the fill tools, and notes for disabled tools (REQ-020).
  - A step of sections 3–5 stops the call → the facade gives an error result (UI-02).
- **Exception Flow:** Upstream gives an error → the facade gives the same error to the client.

#### REQ-002 — Forward roots, progress and cancellation

- **Basic Flow:**
  1. The facade shall answer `roots/list` of upstream with the roots of the client.
  2. The facade shall forward progress notifications of a call to the client.
  3. The facade shall forward the cancellation of a call to upstream.
  4. The facade shall forward `notifications/tools/list_changed` of upstream to the client.
- **Alternative Flow:** The client has no roots capability → the facade gives an empty list.

#### REQ-003 — Close the browser at shutdown

- **Pre-condition:** A tool call ran after the last `browser_close`.
- **Trigger:** The client closes the connection, or the facade gets SIGINT or SIGTERM.
- **Basic Flow:** The facade shall call `browser_close` of upstream, then stop upstream.
- **Exception Flow:** `browser_close` takes longer than CLOSE_TIMEOUT (5000 ms) → the facade logs
  the error and stops upstream.
- **Post-condition:** A persistent profile keeps its cookies and localStorage.

#### REQ-004 — Run upstream as a child process

- **Trigger:** The client starts the facade.
- **Basic Flow:** The facade shall start upstream with each command-line argument of the facade.
- **Exception Flow:** Upstream stops → the facade stops with exit code 1.

## 2. Runtime and portability

#### REQ-010 — Pinned Node.js runtime

- **Trigger:** The user runs `run.sh` or `run.bat`.
- **Basic Flow:** The launcher shall download Node.js NODE_VERSION (v24.22.1) into the tool folder
  and check its SHA-256 checksum.
- **Alternative Flow:** The runtime is in the tool folder → the launcher uses it.
- **Exception Flow:** The checksum is wrong → the launcher deletes the file and stops with an error.

#### REQ-011 — Chromium in the tool folder

- **Basic Flow:** The launcher shall install DEFAULT_BROWSER (chromium) for the pinned Playwright
  version into the tool folder.
- **Alternative Flow:** The variable `CI` is `true` → the launcher also installs the OS packages.

#### REQ-012 — Missing Linux libraries without root

- **Pre-condition:** The OS is Linux.
- **Trigger:** The launcher installed Chromium, or the Playwright version changed.
- **Basic Flow:**
  1. The launcher shall find the libraries of Chromium that the host does not have (`ldd`).
  2. It shall find the Ubuntu package of each library and download it with `apt-get download`.
  3. It shall unpack the packages into the tool folder.
  4. It shall repeat steps 1–3 a maximum of SYSLIBS_ROUNDS (10) times.
  5. The facade shall give the folder of the libraries to Chromium.
- **Alternative Flow:**
  - The host has all libraries → the launcher downloads nothing.
  - The host has no apt package lists → the launcher makes private lists in the tool folder, then
    deletes them after step 4.
- **Exception Flow:** No package is found for a library, or a round makes no progress → the
  launcher stops with the names of the libraries.

#### REQ-013 — Fonts

- **Pre-condition:** The OS is Linux, and the host has no font files.
- **Basic Flow:** The launcher shall download the fonts FONT_PACKAGES into the tool folder and make
  a fontconfig file for Chromium.

#### REQ-014 — Files only in the tool folder

- **Basic Flow:** The facade shall keep the browser profiles, output files, temp files and the
  browser registry (Linux) in the tool folder.
- **Alternative Flow:**
  - The user gives the value with an argument or a variable → the facade keeps it.
  - The tool folder cannot hold Unix sockets → the facade keeps the temp folder of the OS.

#### REQ-015 — Headless browser

- **Basic Flow:** The facade shall start the browser without a window: HEADLESS (true).
- **Alternative Flow:**
  - The user sets `PLAYWRIGHT_MCP_HEADLESS=false` → the browser opens a window.
  - The user gives `--config` → the config file of upstream decides.

## 3. Tool switches

#### REQ-020 — Tool list in the config

- **Trigger:** The facade starts.
- **Basic Flow:** The facade shall add a line `<tool> = enabled|disabled` to `playwright/config/tools.ini` for
  each tool that the file does not list. The default is `disabled` for the tools in
  DANGEROUS_TOOLS and `enabled` for the others.
- **Alternative Flow:**
  - A value is not `enabled` or `disabled` → the facade treats the tool as disabled and logs it.
  - The user changes the file → the facade uses the new values at the next call.
- **Post-condition:** `tools.ini` lists each tool of the facade, sorted.

#### REQ-021 — Call of a disabled tool

- **Trigger:** The client calls a disabled tool.
- **Basic Flow:** The facade shall not forward the call. It shall give an error result with the
  reason and the line that enables the tool (UI-02).
- **Alternative Flow:** `tools/list` → the facade lists the tool. Its description starts with
  `DISABLED by the facade:` and the reason.

## 4. Form values

#### REQ-030 — Placeholders

- **Trigger:** The client calls `browser_type`, `browser_fill_form` or `browser_select_option`
  with a placeholder `{{<name>}}` in `text`, `fields[].value` or `values[]`.
- **Basic Flow:** The facade shall replace each placeholder with the value of a provider
  (REQ-031), then forward the call.
- **Alternative Flow:** The placeholder is a part of a longer value → the facade replaces only it.
- **Exception Flow:** No provider has a value, or a provider fails → the facade forwards nothing.
  It gives an error result with the placeholder, the host and the providers that it asked.

#### REQ-031 — Provider order

- **Basic Flow:** The facade shall ask the providers in the order of `[fill] providers` in
  `config/facade.ini`. The first provider that has a value gives it.
- **Alternative Flow:** A provider has no value → the facade asks the next provider.

#### REQ-032 — Scrub of filled values

- **Basic Flow:** The facade shall replace each value that it filled in with its placeholder in
  each later result, for the time of the session.
- **Post-condition:** The client and the log never get a filled value (QAS-002).

#### REQ-033 — List of placeholders

- **Trigger:** The client calls `fill_values_list`.
- **Basic Flow:** The facade shall give the placeholder names that each provider can fill on the
  current page. It shall give no values.

#### REQ-034 — Vault provider

- **Basic Flow:**
  1. The provider shall select the vault system whose `url` has the host of the page, or a parent
     domain of it.
  2. It shall give the secret whose name is the placeholder name, through the vault tool.
- **Alternative Flow:**
  - More systems match → the system whose `url` is the longest prefix of the page URL wins.
  - `providers-form-fill/vault/config.ini` gives `vault_home` or `subvault` → the provider uses that vault.
  - No system matches, or the system has no such secret → the provider has no value.
- **Exception Flow:**
  - Two systems match equally → error with the system names.
  - The vault tool fails → error with its message.

#### REQ-035 — INI provider

- **Basic Flow:** The provider shall give the value of the key from `providers-form-fill/ini/config.ini`.
  The most specific section wins: a section with the exact host, then a section with a longer
  host pattern, then `[all]`.

#### REQ-036 — Ask provider

- **Pre-condition:** The client declared the elicitation capability. The placeholder is in
  `[ask] fields` of `providers-form-fill/ask/config.ini`.
- **Basic Flow:** The provider shall show a dialog to the user (UI-01) and give the answer.
- **Alternative Flow:** The user gave the value for this host and placeholder before in the
  session → the provider gives it without a dialog.
- **Exception Flow:**
  - The user declines or cancels → error; the call stops.
  - No answer in ASK_TIMEOUT (300000 ms) → error; the call stops.

## 5. Host lists

#### REQ-040 — Check before a page opens

- **Trigger:** The client calls `browser_navigate`, or `browser_tabs` with `action = new` and a URL.
- **Basic Flow:** The facade shall check the host of the URL: first `[deny]`, then the allow
  provider (default: `[allow]` of `config/hosts.ini`).
- **Alternative Flow:** The URL has no host (e.g. `about:blank`) → the facade allows it.
- **Exception Flow:** The host is blocked → the facade forwards nothing. It gives an error result
  with the host and the pattern or the list (UI-02).

#### REQ-041 — Check after each call

- **Trigger:** A result of upstream shows a page URL.
- **Basic Flow:** The facade shall check the host of the page as REQ-040 says.
- **Exception Flow:** The host is blocked → the facade opens `about:blank`. It gives an error
  result with the closed URL and the reason.

#### REQ-042 — Record the opened hosts

- **Pre-condition:** `[hosts] record` in `config/facade.ini` is not `false`.
- **Trigger:** A page of an allowed host opened.
- **Basic Flow:** The default allow provider shall add the exact host to `[allow]`, also if a
  pattern covers it. It shall keep each section of `hosts.ini` sorted and unique, and keep the
  comment lines at the top.
- **Alternative Flow:** The host is in `[deny]` → the provider does not add it.

## 6. Logging

#### REQ-050 — Log of each call

- **Basic Flow:** The facade shall write one JSON line for each event to LOG_FILE: start, client,
  tool call, result (duration, error flag, size of the content), filled placeholder, blocked host,
  upstream stderr, shutdown.
- **Alternative Flow:**
  - The file is larger than LOG_MAX_SIZE (10 MiB) at start → the facade renames it to `.1`.
  - LOG_LEVEL is `debug` → the facade also writes the result text, a maximum of
    DEBUG_TEXT_MAX (20000) characters.

#### REQ-051 — No secrets in the log

- **Basic Flow:** The facade shall replace the values of the arguments `text`, `value`, `values`
  and `password` with their length.
- **Alternative Flow:**
  - The value has only placeholders → the facade logs it.
  - LOG_SECRETS is `1` → the facade logs the values.

---

## User interface

### UI-01 — Dialog of the ask provider

- **Purpose:** The user gives a value that the agent must not know, e.g. a phone number.
- **Shows:** The placeholder, the field name and the host of the page. The note that the agent does
  not see the value.
- **Actions:** Enter the value and accept → the facade types it (REQ-036). Decline or cancel → the
  call stops.
- **Feedback:** The agent gets the result of the call, with the placeholder in place of the value.
- **Realization:** An MCP elicitation form of the client, e.g. a dialog of Claude Code.

### UI-02 — Error results to the agent

- **Purpose:** The agent knows why the facade did not run a call.
- **Shows:** `### Error` and one sentence: what the facade did not do, and why (disabled tool,
  blocked host, missing placeholder value).
- **Actions:** None.
- **Feedback:** The text gives the config file and the line to change, if any.
- **Realization:** A tool result with `isError: true`.

---

## Default values

| Name | Default | Unit | Configuration key | Meaning |
| --- | --- | --- | --- | --- |
| CLOSE_TIMEOUT | 5000 | ms | — | Maximum time of `browser_close` at shutdown |
| ASK_TIMEOUT | 300000 | ms | — | Maximum time of a dialog of the ask provider |
| TOOL_TIMEOUT | 600000 | ms | — | Maximum time of one call without progress |
| NODE_VERSION | v24.22.1 | — | `NODE_VERSION` in `run.sh` / `run.bat` | Pinned Node.js runtime |
| HEADLESS | true | — | `PLAYWRIGHT_MCP_HEADLESS` | `true`: the browser has no window |
| DEFAULT_BROWSER | chromium | — | `--browser`, `PLAYWRIGHT_MCP_BROWSER` | Browser of upstream |
| SYSLIBS_ROUNDS | 10 | rounds | — | Maximum download rounds of the missing libraries |
| FONT_PACKAGES | fonts-liberation, fonts-dejavu-core, fonts-noto-color-emoji | — | — | Fonts for a host without fonts |
| DANGEROUS_TOOLS | browser_run_code_unsafe, browser_evaluate, browser_file_upload, browser_drop | — | — | Tools that are disabled by default |
| LOG_FILE | `.local_assets/logs/playwright-facade.log` | — | `PLAYWRIGHT_FACADE_LOG_FILE` | Log file |
| LOG_LEVEL | info | — | `PLAYWRIGHT_FACADE_LOG_LEVEL` | `error`, `info` or `debug` |
| LOG_SECRETS | unset | — | `PLAYWRIGHT_FACADE_LOG_SECRETS` | `1` logs the values of the secret arguments |
| LOG_MAX_SIZE | 10 | MiB | — | Size of the log file that causes a rotation |
| DEBUG_TEXT_MAX | 20000 | characters | — | Result text in a debug entry |
