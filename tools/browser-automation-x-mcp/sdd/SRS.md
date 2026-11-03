# Software Requirements Specification (SRS) — browser-automation-x-mcp

The required behaviour of the system. The system is "the server". "Upstream" is Playwright MCP.
"The client" is the MCP client, e.g. Claude Code. The containers are in [DESIGN.md](DESIGN.md).

**Requirement format:** Structured

---

## 1. Proxy

#### REQ-001 — Forward the tools of upstream

- **Trigger:** The client sends `tools/list` or `tools/call`.
- **Basic Flow:** The server shall forward the request to upstream and give the answer of upstream
  to the client. The names and input schemas of the tools shall stay the same.
- **Alternative Flow:**
  - `tools/list` → the server adds notes for disabled tools (REQ-020) and changes the texts
    (REQ-005). It adds no tools.
  - A step of sections 3–5 stops the call → the server gives an error result (UI-02).
- **Exception Flow:** Upstream gives an error → the server gives the same error to the client.

#### REQ-002 — Forward roots, progress and cancellation

- **Basic Flow:**
  1. The server shall answer `roots/list` of upstream with the roots of the client.
  2. The server shall forward progress notifications of a call to the client.
  3. The server shall forward the cancellation of a call to upstream.
  4. The server shall forward `notifications/tools/list_changed` of upstream to the client.
- **Alternative Flow:** The client has no roots capability → the server gives an empty list.

#### REQ-003 — Close the browser at shutdown

- **Pre-condition:** A tool call ran after the last `browser_close`.
- **Trigger:** The client closes the connection, or the server gets SIGINT or SIGTERM.
- **Basic Flow:** The server shall call `browser_close` of upstream, then stop upstream.
- **Exception Flow:** `browser_close` takes longer than CLOSE_TIMEOUT (5000 ms) → the server logs
  the error and stops upstream.
- **Post-condition:** A persistent profile keeps its cookies and localStorage.

#### REQ-005 — Texts for the client

- **Basic Flow:** The texts for the client shall not name upstream, Playwright, the form fill
  or its providers.
  1. The server name shall be SERVER_NAME (browser-automation-x-mcp).
  2. The instructions shall be: "Use the tools of this server for each browser automation task
     when they are available. This is mandatory."
  3. The server shall remove the name Playwright from the tool descriptions and schemas.
  4. The server shall remove the section `### Ran Playwright code` from each result.
  5. Error results shall not name upstream or a config file (UI-02).

#### REQ-004 — Run upstream as a child process

- **Trigger:** The client starts the server.
- **Basic Flow:** The server shall start upstream with each command-line argument of the server,
  except `--config-dir`, `--browser` and `--headless`.
- **Exception Flow:** Upstream stops → the server stops with exit code 1.

## 2. Runtime and portability

#### REQ-010 — Pinned Node.js runtime

- **Trigger:** The user runs `run.sh` or `run.bat`.
- **Basic Flow:** The launcher shall download Node.js NODE_VERSION (v24.22.1) into the tool folder
  and check its SHA-256 checksum.
- **Alternative Flow:** The runtime is in the tool folder → the launcher uses it.
- **Exception Flow:** The checksum is wrong → the launcher deletes the file and stops with an error.

#### REQ-011 — Only Chromium, in the tool folder

- **Basic Flow:**
  1. The launcher shall install BROWSER (chromium) for the pinned Playwright version into the
     tool folder.
  2. The server shall always start BROWSER (chromium). It shall give
     `PLAYWRIGHT_MCP_BROWSER=chromium` to upstream, also with `--config`.
- **Alternative Flow:**
  - The variable `CI` is `true` → the launcher also installs the OS packages.
  - `--browser` or `PLAYWRIGHT_MCP_BROWSER` is given → the server ignores it, without an error.
    It removes `--browser` and logs `ignored`.

#### REQ-012 — Missing Linux libraries without root

- **Pre-condition:** The OS is Linux.
- **Trigger:** The launcher installed Chromium, or the Playwright version changed.
- **Basic Flow:**
  1. The launcher shall find the libraries of Chromium that the host does not have (`ldd`).
  2. It shall find the Ubuntu package of each library and download it with `apt-get download`.
  3. It shall unpack the packages into the tool folder.
  4. It shall repeat steps 1–3 a maximum of SYSLIBS_ROUNDS (10) times.
  5. The server shall give the folder of the libraries to Chromium.
- **Alternative Flow:**
  - The host has all libraries → the launcher downloads nothing.
  - The host has no apt package lists → the launcher makes private lists in the tool folder, then
    deletes them after step 4.
- **Exception Flow:** No package is found for a library, or a round makes no progress → the
  launcher stops with the names of the libraries.

#### REQ-017 — Xvfb without root

- **Pre-condition:** The OS is Linux.
- **Trigger:** The launcher installed Chromium, the Playwright version changed, or SYSLIBS_SET
  (xvfb1) changed.
- **Basic Flow:**
  1. The launcher shall download XVFB_PACKAGES and unpack them into the tool folder.
  2. It shall set the path of `xkbcomp` in the Xvfb binary to `./bin`.
  3. It shall add the missing libraries of Xvfb and `xkbcomp` in the rounds of REQ-012.
- **Exception Flow:** The Xvfb binary does not have the path `/usr/bin` exactly one time → the
  launcher stops with an error.

#### REQ-013 — Fonts

- **Pre-condition:** The OS is Linux, and the host has no font files.
- **Basic Flow:** The launcher shall download the fonts FONT_PACKAGES into the tool folder and make
  a fontconfig file for Chromium.

#### REQ-014 — Files only in the tool folder

- **Basic Flow:** The server shall keep the browser profiles, temp files and the browser registry
  (Linux) in the tool folder. It shall keep the output files (snapshots, screenshots) in
  OUTPUT_DIR of the working folder: the agent reads them.
- **Alternative Flow:**
  - The user gives the value with an argument or a variable → the server keeps it.
  - The tool folder cannot hold Unix sockets → the server keeps the temp folder of the OS.

#### REQ-015 — Render mode of the browser

- **Basic Flow:** The server shall select the render mode with `RENDER_MODE`:
  RENDER_MODE (DEFAULT).
  | Value | Host with a display | WSL | Linux without a display |
  | --- | --- | --- | --- |
  | `DEFAULT` | `HEADED` | `HEADED_INVISIBLE` | `HEADED_INVISIBLE` |
  | `HEADED` | a window | a window (WSLg) | `HEADED_INVISIBLE` |
  | `HEADED_INVISIBLE` | Xvfb (REQ-018); not Linux: error | Xvfb | Xvfb |
  | `HEADLESS` | no window | no window | no window |
- **Alternative Flow:**
  - `--headless` or `PLAYWRIGHT_MCP_HEADLESS` is given → the server ignores it, without an error.
    It removes `--headless` and sets `PLAYWRIGHT_MCP_HEADLESS` for upstream.
  - The user gives `--config` → the render mode also applies. The variable overrides the file.
  - The user gives `--cdp-endpoint`, `--extension` or `--endpoint` → the render mode has no
    effect.
- **Exception Flow:**
  - The value is not known → the server stops with an error.
  - The mode needs Xvfb, and the OS is not Linux → the server stops with an error. The server
    never selects `HEADLESS` in place of an other mode.
- **Note:** WSL: `WSL_DISTRO_NAME` is set, or `/proc/version` contains `microsoft`. No display: Linux,
  and `DISPLAY` and `WAYLAND_DISPLAY` are not set.

#### REQ-018 — Xvfb display

- **Pre-condition:** The render mode is `HEADED_INVISIBLE` (REQ-015).
- **Basic Flow:**
  1. The server shall start Xvfb on the first free display from XVFB_FIRST_DISPLAY (99), with
     XVFB_SCREEN (1920x1080x24).
  2. Xvfb shall listen only on the abstract socket of Linux.
  3. The server shall give the display to upstream and `PLAYWRIGHT_MCP_HEADLESS=false`.
  4. The server shall record the PID and start time of itself and of Xvfb in XVFB_DIR.
  5. The server shall stop Xvfb and delete the record when it stops.
  6. The kernel shall stop Xvfb when the server process stops (parent-death signal of `setpriv`).
  7. At each start, the server shall kill each Xvfb of the tool folder whose server does not run,
     and delete its record. It shall not reuse an Xvfb.
- **Alternative Flow:**
  - A display has a socket or a lock file, or Xvfb does not start on it → the server tries the
    next display, a maximum of XVFB_DISPLAY_TRIES (20) displays.
  - `setpriv` is not installed → the server starts Xvfb without the parent-death signal, and
    logs it. Step 7 stops a leftover Xvfb.
- **Exception Flow:**
  - Xvfb is not installed → the server stops with an error that gives `run.sh install`.
  - Xvfb is not ready in XVFB_START_TIMEOUT (10000 ms) → the server tries the next display.

#### REQ-016 — No bubbles of the browser

- **Trigger:** The browser starts with a persistent profile.
- **Basic Flow:** Before the start, the server shall write settings into `Default/Preferences` of
  the profile. The settings stop the password manager, its leak check, the translate bar, the
  "restore pages" bubble, autofill prompts and permission prompts. Other settings stay.
- **Alternative Flow:**
  - `--isolated` → the server writes no settings.
  - The file is missing or damaged → the server writes a file with only these settings.
- **Post-condition:** No bubble of the browser covers the page.

## 3. Tool switches

#### REQ-019 — Config folder

- **Trigger:** The server starts.
- **Basic Flow:** The server shall read its config files from the folder that `--config-dir DIR`
  gives. A relative path is relative to the working folder. The server shall not give the
  argument to upstream. The files are in [DESIGN.md](DESIGN.md#data-model).
- **Alternative Flow:** A config file is missing → the server shall copy its template from the
  tool folder.
- **Exception Flow:** `--config-dir` is missing → the server does not start. It writes the error
  to stderr.

#### REQ-020 — Tool list in the config

- **Trigger:** The server starts.
- **Basic Flow:** The server shall add a line `<tool> = enabled|disabled` to `tools.ini` for
  each tool that the file does not list. The default is `disabled` for the tools in
  DANGEROUS_TOOLS and `enabled` for the others.
- **Alternative Flow:**
  - A value is not `enabled` or `disabled` → the server treats the tool as disabled and logs it.
  - The user changes the file → the server uses the new values at the next call.
- **Post-condition:** `tools.ini` lists each tool of the server, sorted.

#### REQ-021 — Call of a disabled tool

- **Trigger:** The client calls a disabled tool.
- **Basic Flow:** The server shall not forward the call. It shall give an error result with the
  reason (UI-02).
- **Alternative Flow:** `tools/list` → the server lists the tool. Its description starts with
  `DISABLED: this tool is turned off in the configuration.` and the reason.

## 4. Form fill

The agent does not fill credentials or personal data. The server fills the fields of
`fields.ini` and submits the form. The agent gets the page after the submit.

#### REQ-030 — Fill after a call

- **Trigger:** A result of upstream shows a page URL, and the URL matches a section of
  `fields.ini` (REQ-037).
- **Basic Flow:**
  1. The server shall wait a maximum of FILL_WAIT (10000 ms) for a visible field of the section,
     in each frame of the page.
  2. It shall get the value of each visible field from the providers (REQ-031).
  3. It shall fill the fields that have a value, and submit the form (REQ-038).
  4. It shall repeat steps 1–3 on the new page, a maximum of FILL_ROUNDS (3) rounds.
  5. It shall give the client a snapshot of the page after the last submit, in place of the
     result of upstream.
- **Alternative Flow:**
  - The server waited for this URL before, and the page did not change by a submit → it does not
    wait. It checks the fields one time.
  - No field is visible, or no provider has a value → the server does nothing. The client gets the
    result of upstream.
- **Exception Flow:** A provider or the page code fails → the server logs the error and does
  nothing. The client gets the result of upstream. The error is not visible to the client.

#### REQ-031 — Provider order

- **Basic Flow:** The server shall ask the providers in the order of `[fill] providers` in
  `server.ini`. The first provider that has a value gives it.
- **Alternative Flow:** A provider has no value → the server asks the next provider.

#### REQ-032 — Mask of filled values

- **Pre-condition:** The provider of the value is masked: `[mask] <provider>` in `server.ini` is
  not `false`.
- **Basic Flow:** The server shall replace the value with MASK (`***`) in each later result, for
  the time of the session.
- **Alternative Flow:** Upstream writes a text file in a call → the server shall replace the values
  in it too. These are the files that the result links, and the files of the output folder that
  changed in the call. Binary files, e.g. screenshots, stay unchanged.
- **Post-condition:** The client, the log and the text files of upstream never get a masked value
  (QAS-002).

#### REQ-033 — Removed

The tool `fill_values_list` is removed. The client has no tool for the form fill.

#### REQ-034 — Vault provider

- **Basic Flow:**
  1. The provider shall select the line of `[systems]` in `provider-vault.ini` whose host is the
     host of the page, or a parent domain of it. The line gives the exact name of a vault system.
  2. It shall give the secret whose name is the field name, through the vault tool, from the
     vault that `[vault] vault` gives.
  3. It shall not search the vault for systems.
- **Alternative Flow:**
  - More lines match → the line whose URL prefix is the longest prefix of the page URL wins.
  - No line matches, or the system has no such secret → the provider has no value.
- **Exception Flow:**
  - Two lines match equally → error with the keys of the lines.
  - `[vault] vault` is empty → error.
  - The vault tool fails → error with its message.

#### REQ-035 — INI provider

- **Basic Flow:** The provider shall give the value of the field name from `[values]` of
  `provider-ini.ini`.

#### REQ-036 — Ask provider

- **Pre-condition:** The client declared the elicitation capability. The field name is in
  `[ask] fields` of `provider-ask.ini`.
- **Basic Flow:** The provider shall show a dialog to the user (UI-01) and give the answer.
- **Alternative Flow:** The user gave the value for this host and field name before in the
  session → the provider gives it without a dialog.
- **Exception Flow:**
  - The user declines or cancels → error; the server does not fill the form.
  - No answer in ASK_TIMEOUT (300000 ms) → error; the server does not fill the form.

#### REQ-037 — Fields of a page

- **Basic Flow:** The server shall read `fields.ini` of the config folder. Each section is a URL
  pattern. Each line is `<field name> = <CSS selector>`. The line `submit = <CSS selector>` is
  optional.
  1. A URL pattern is `host/path`. The host part is a host pattern (REQ-040).
  2. In the path, `*` matches each sequence of characters, also `/`.
  3. A pattern without a path matches each path. Scheme, port, query and fragment have no effect.
- **Alternative Flow:** More sections match → all apply. For a field name in more sections, the
  longer pattern wins.

#### REQ-038 — Submit and loop guard

- **Basic Flow:**
  1. The server shall click the element of `submit` if it is visible. Else it shall call
     `requestSubmit()` of the form of the last filled field. Else it shall press Enter in it.
  2. It shall wait a maximum of SUBMIT_WAIT (10000 ms) for the load of the page, then for the
     end of the network requests.
  3. It shall fill each set of visible fields of a form one time only.
- **Alternative Flow:** The same fields of the same form are visible again, e.g. after a wrong
  password → the server does not fill them. It logs `fill_failed`.
- **Post-condition:** The guard is reset when a page does not match `fields.ini`.

#### REQ-039 — Discovery mode

- **Pre-condition:** DISCOVER is `1`.
- **Trigger:** A result of upstream shows a page URL.
- **Basic Flow:**
  1. The server shall find the visible input fields of each frame of the page.
  2. For each field, it shall make a selector that is unique in its frame: `autocomplete`, then
     `name`, then an `id` that does not look generated, then the type.
  3. It shall propose a field name: `username`, `password`, `email`, `otp`, else the `name`.
  4. It shall write the fields into DISCOVERED_FILE, in the format of `fields.ini`. The section is
     the URL pattern of the page. A path segment that looks like an ID becomes `*`.
- **Alternative Flow:** The file has a section for the pattern → the server replaces it.
- **Note:** An ID segment has only digits, is a UUID, or has more than 16 characters of hex or
  base64url with a digit and a letter.

## 5. Host lists

#### REQ-040 — Check before a page opens

- **Trigger:** The client calls `browser_navigate`, or `browser_tabs` with `action = new` and a URL.
- **Basic Flow:** The server shall check the host of the URL: first `[deny]`, then the allow
  provider (default: `[allow]` of `host-policy.ini`).
- **Alternative Flow:** The URL has no host (e.g. `about:blank`) → the server allows it.
- **Exception Flow:** The host is blocked → the server forwards nothing. It gives an error result
  with the URL and the list (UI-02).

#### REQ-041 — Check after each call

- **Trigger:** A result of upstream shows a page URL.
- **Basic Flow:** The server shall check the host of the page as REQ-040 says.
- **Exception Flow:** The host is blocked → the server opens `about:blank`. It gives an error
  result with the closed URL and the reason.

#### REQ-042 — Record the opened hosts

- **Pre-condition:** `[hosts] record` in `server.ini` is not `false`.
- **Trigger:** A page of an allowed host opened.
- **Basic Flow:** The default allow provider shall add the exact host to `[allow]`, also if a
  pattern covers it. It shall keep each section of `host-policy.ini` sorted and unique, and keep the
  comment lines at the top.
- **Alternative Flow:** The host is in `[deny]` → the provider does not add it.

#### REQ-043 — Host list in the config folder

- **Trigger:** The server reads the host list, and `host-policy.ini` is missing in the config folder.
- **Basic Flow:** The server shall copy `config/host-policy.template.ini` to it (REQ-019).
- **Alternative Flow:** The template is missing → the server shall write `[deny]` empty and `[allow] *`.

## 6. Logging

#### REQ-050 — Log of each call

- **Basic Flow:** The server shall write one JSON line for each event to LOG_FILE: start, client,
  tool call, result (duration, error flag, size of the content), filled field, submit, failed fill,
  discovered fields, blocked host, upstream stderr, shutdown.
- **Alternative Flow:**
  - The file is larger than LOG_MAX_SIZE (10 MiB) at start → the server renames it to `.1`.
  - LOG_LEVEL is `debug` → the server also writes the result text, a maximum of
    DEBUG_TEXT_MAX (20000) characters.

#### REQ-051 — No secrets in the log

- **Basic Flow:** The server shall replace the values of the arguments `text`, `value`, `values`
  and `password` with their length.
- **Alternative Flow:** LOG_SECRETS is `1` → the server logs the values of the arguments.
- **Post-condition:** The log never has a value of a provider.

---

## User interface

### UI-01 — Dialog of the ask provider

- **Purpose:** The user gives a value that the agent must not know, e.g. a phone number.
- **Shows:** The field name and the host of the page. The note that the agent does not see the
  value.
- **Actions:** Enter the value and accept → the server fills it (REQ-036). Decline or cancel → the
  server does not fill the form.
- **Feedback:** The agent gets the page after the submit, with MASK in place of the value.
- **Realization:** An MCP elicitation form of the client, e.g. a dialog of Claude Code.

### UI-02 — Error results to the agent

- **Purpose:** The agent knows why a call did not run.
- **Shows:** `### Error` and one sentence: what did not run, and why (disabled tool, blocked host).
  Examples: "The tool <name> did not run: this tool is turned off in the configuration.",
  "Navigation blocked: <url> is not allowed. The host <host> is on the deny list."
- **Actions:** None.
- **Feedback:** The text does not name upstream or a config file (REQ-005).
- **Realization:** A tool result with `isError: true`.

---

## Default values

| Name | Default | Unit | Configuration key | Meaning |
| --- | --- | --- | --- | --- |
| CLOSE_TIMEOUT | 5000 | ms | — | Maximum time of `browser_close` at shutdown |
| ASK_TIMEOUT | 300000 | ms | — | Maximum time of a dialog of the ask provider |
| TOOL_TIMEOUT | 600000 | ms | — | Maximum time of one call without progress |
| NODE_VERSION | v24.22.1 | — | `NODE_VERSION` in `run.sh` / `run.bat` | Pinned Node.js runtime |
| RENDER_MODE | DEFAULT | — | `RENDER_MODE` | `DEFAULT`, `HEADED`, `HEADED_INVISIBLE` or `HEADLESS` (REQ-015) |
| BROWSER | chromium | — | — | The only browser of upstream |
| SYSLIBS_ROUNDS | 10 | rounds | — | Maximum download rounds of the missing libraries |
| SYSLIBS_SET | xvfb1 | — | `SYSLIBS_SET` in `run.sh` | Version of the package set of the launcher |
| XVFB_PACKAGES | xvfb, xserver-common, x11-xkb-utils, xkb-data | — | — | Packages of Xvfb |
| XVFB_SCREEN | 1920x1080x24 | width x height x depth | — | Screen of Xvfb |
| XVFB_FIRST_DISPLAY | 99 | — | — | First display number of Xvfb |
| XVFB_DISPLAY_TRIES | 20 | displays | — | Maximum displays that the server tries |
| XVFB_DIR | `.local_assets/xvfb/` | — | — | Records of the running Xvfb processes |
| XVFB_START_TIMEOUT | 10000 | ms | — | Maximum time until Xvfb is ready |
| FONT_PACKAGES | fonts-liberation, fonts-dejavu-core, fonts-noto-color-emoji | — | — | Fonts for a host without fonts |
| DANGEROUS_TOOLS | browser_run_code_unsafe, browser_evaluate, browser_file_upload, browser_drop | — | — | Tools that are disabled by default |
| LOG_FILE | `.local_assets/logs/browser-automation-x-mcp.log` | — | `BROWSER_AUTOMATION_X_MCP_LOG_FILE` | Log file |
| LOG_LEVEL | info | — | `BROWSER_AUTOMATION_X_MCP_LOG_LEVEL` | `error`, `info` or `debug` |
| LOG_SECRETS | unset | — | `BROWSER_AUTOMATION_X_MCP_LOG_SECRETS` | `1` logs the values of the secret arguments |
| SERVER_NAME | browser-automation-x-mcp | — | — | Server name for the client |
| OUTPUT_DIR | `.local_assets/browser-automation-x-mcp/output/` of the working folder | — | `--output-dir`, `PLAYWRIGHT_MCP_OUTPUT_DIR` | Output files of upstream |
| FILL_WAIT | 10000 | ms | — | Maximum wait for the fields of a page |
| SUBMIT_WAIT | 10000 | ms | — | Maximum wait for the load and for the network after a submit |
| FILL_ROUNDS | 3 | rounds | — | Maximum fill and submit rounds in one call |
| MASK | `***` | — | — | Replacement of a masked value |
| DISCOVER | unset | — | `BROWSER_AUTOMATION_X_MCP_DISCOVER` | `1` turns on the discovery mode |
| DISCOVERED_FILE | `.local_assets/discovered-fields.ini` | — | — | Fields that the discovery mode found |
| LOG_MAX_SIZE | 10 | MiB | — | Size of the log file that causes a rotation |
| DEBUG_TEXT_MAX | 20000 | characters | — | Result text in a debug entry |
