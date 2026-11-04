# Software Requirements Specification (SRS) — browser-automation-x-mcp

The required behaviour of the system. The system is "the server". "Upstream" is Playwright MCP.
"The client" is the MCP client, e.g. Claude Code. "A lane" is one browser context for one agent
(section 7). The containers are in [DESIGN.md](DESIGN.md).

**Requirement format:** Structured

---

## 1. Proxy

#### REQ-001 — Forward the tools of upstream

- **Trigger:** The client sends `tools/list` or `tools/call`.
- **Basic Flow:** The server shall forward the request to the upstream connection of the lane of
  the call (REQ-061), and give the answer of upstream to the client. The names of the tools shall
  stay the same.
- **Alternative Flow:**
  - `tools/list` → the server adds the lane tools (REQ-060) and the parameter `lane` to each
    upstream tool (REQ-061). It adds notes for disabled tools (REQ-020) and changes the texts
    (REQ-005).
  - A step of sections 3–5 stops the call → the server gives an error result (UI-02).
- **Exception Flow:** Upstream gives an error → the server gives the same error to the client.

#### REQ-002 — Forward roots, progress and cancellation

- **Basic Flow:**
  1. The server shall answer `roots/list` of each upstream connection with the roots of the client.
  2. The server shall forward progress notifications of a call to the client.
  3. The server shall forward the cancellation of a call to upstream.
  4. The server shall forward `notifications/tools/list_changed` of upstream to the client.
- **Alternative Flow:** The client has no roots capability → the server gives an empty list.

#### REQ-003 — Close the lanes at shutdown

- **Trigger:** The client closes the connection, or the server gets SIGINT or SIGTERM.
- **Basic Flow:** The server shall close each open lane as REQ-063 says, then stop the browser.
- **Post-condition:** The storage-state file has the logins of each lane (REQ-064).

#### REQ-005 — Texts for the client

- **Basic Flow:** The texts for the client shall not name upstream, Playwright, the form fill
  or its providers.
  1. The server name shall be SERVER_NAME (browser-automation-x-mcp).
  2. The instructions shall start with: "Use the tools of this server for each browser automation
     task when they are available. This is mandatory." Then they shall tell the agent to open a
     lane, to give its ID in each call, to use one lane for each agent, and to close it.
  3. The server shall remove the name Playwright from the tool descriptions and schemas.
  4. The server shall remove the section `### Ran Playwright code` from each result.
  5. Error results shall not name upstream or a config file (UI-02).

#### REQ-004 — Run upstream in the server process

- **Trigger:** The client starts the server.
- **Basic Flow:**
  1. The server shall take only the argument `--config-dir` (REQ-019).
  2. It shall run upstream in its own process, with one connection for each lane (REQ-061). It
     shall open no network port.
- **Alternative Flow:** A variable `PLAYWRIGHT_MCP_*` is set → the server ignores it and logs
  `ignored`.
- **Exception Flow:** The server gets an other argument → it stops with exit code 1 and an error
  that names the argument.

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
  2. The server shall always start BROWSER (chromium).
- **Alternative Flow:** The variable `CI` is `true` → the launcher also installs the OS packages.

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

- **Basic Flow:** The server shall keep STATE_FILE, the log, DISCOVERED_FILE, temp files and the
  browser registry (Linux) in the tool folder. It shall keep the output files (snapshots,
  screenshots) in OUTPUT_DIR of the working folder: the agent reads them.
- **Alternative Flow:**
  - The user gives `PLAYWRIGHT_BROWSERS_PATH` → the server keeps it.
  - The tool folder cannot hold the Unix socket of Chromium → the server uses `.local_assets/tmp/`
    of the first folder with `.git` above the tool folder (in a submodule: the submodule, e.g.
    `shared/`). If that fails too, it uses the temp folder of the OS. It logs `tmp_dir_fallback`.

#### REQ-014a — File names of the agent

- **Trigger:** A call has the argument `filename`.
- **Basic Flow:** The server shall resolve a relative name against OUTPUT_DIR, and give the
  absolute path to upstream.
- **Exception Flow:** The file is not in OUTPUT_DIR → the server gives an error result (UI-02) and
  does not call upstream.

#### REQ-015 — Render mode of the browser

- **Basic Flow:** The server shall select the render mode with `RENDER_MODE`:
  RENDER_MODE (DEFAULT).
  | Value | Host with a display | WSL | Linux without a display |
  | --- | --- | --- | --- |
  | `DEFAULT` | `HEADED` | `HEADED_INVISIBLE` | `HEADED_INVISIBLE` |
  | `HEADED` | a window | a window (WSLg) | `HEADED_INVISIBLE` |
  | `HEADED_INVISIBLE` | Xvfb (REQ-018); not Linux: error | Xvfb | Xvfb |
  | `HEADLESS` | no window | no window | no window |
- **Alternative Flow:** `PLAYWRIGHT_MCP_HEADLESS` is set → the server ignores it (REQ-004).
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
  3. The server shall start Xvfb with the browser (REQ-065), and start the browser headed on its
     display. It shall stop Xvfb with the browser.
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

- **Trigger:** The browser starts (REQ-065).
- **Basic Flow:** The server shall start Chromium with `--deny-permission-prompts`.
- **Post-condition:** No bubble of the browser covers the page. Each lane starts with an empty
  profile: no "restore pages" bubble. The default switches of Playwright stop the translate bar.
  A test on Xvfb shows no password bubble and no address bubble in a lane.

## 3. Tool switches

#### REQ-019 — Config folder

- **Trigger:** The server starts.
- **Basic Flow:** The server shall read its config files from the folder that `--config-dir DIR`
  gives. A relative path is relative to the working folder. The files are in
  [DESIGN.md](DESIGN.md#data-model).
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
  4. It shall check the host of the page after the submit (REQ-041) before each other step.
  5. It shall repeat steps 1–4 on the new page, a maximum of FILL_ROUNDS (3) rounds.
  6. It shall give the client a snapshot of the page after the last submit, in place of the
     result of upstream.
- **Alternative Flow:**
  - The server waited for this URL before, and the page did not change by a submit → it does not
    wait. It checks the fields one time.
  - No field is visible, or no provider has a value → the server does nothing. The client gets the
    result of upstream.
  - The host of the page after a submit is blocked → the server stops the fill. It opens
    `about:blank` and gives the error of REQ-041.
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

#### REQ-032a — Mask of secret headers

- **Trigger:** A call gives a result, or upstream writes text files in the call.
- **Basic Flow:** The server shall replace the value of each line `Cookie:`, `Set-Cookie:`,
  `Authorization:` and `Proxy-Authorization:` with MASK, in the result and in the files of REQ-032.
  The header name shall stay. Bodies shall stay.

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
  pattern. Each line is `<field name> = <selector>`. Lines `submit = <selector>` are optional; a
  section can have more of them. A selector is CSS, or a label or role locator of Playwright.
  1. A URL pattern is `host/path`. The host part is a host pattern (REQ-040).
  2. In the path, `*` matches each sequence of characters, also `/`.
  3. A pattern without a path matches each path. Scheme, port, query and fragment have no effect.
- **Alternative Flow:** More sections match → all apply. For a field name in more sections, the
  longer pattern wins.

#### REQ-038 — Submit and loop guard

- **Basic Flow:**
  1. The server shall click the first visible element of the `submit` lines: the lines of the
     longer pattern first, each section in file order. Else it shall call `requestSubmit()` of the
     form of the last filled field. Else it shall press Enter in it.
  2. It shall wait a maximum of SUBMIT_WAIT (10000 ms) for the load of the page, then for the
     end of the network requests.
  3. It shall fill each set of visible fields of a form one time only.
- **Alternative Flow:** The same fields of the same form are visible again, e.g. after a wrong
  password → the server does not fill them. It logs `fill_failed`.
- **Post-condition:** The guard is reset when a page does not match `fields.ini`.

#### REQ-039 — Discovery mode

- **Pre-condition:** DISCOVER is `1`.
- **Trigger:** A result of upstream shows a page URL, or the form fill submitted a page.
- **Basic Flow:**
  1. The server shall find the visible input fields and the buttons that can submit, in each frame
     of the page. A button can submit if it is a submit button, an image input, a button without a
     type in a form, or an other button whose parent (up to 4 levels) holds a visible field.
  2. For each field, it shall make a selector that is unique in its frame: `autocomplete`, then
     `name`, then an `id` that does not look generated, then the type, `aria-label`, `placeholder`.
     Else a label locator of Playwright. For each button: an `id` that does not look generated,
     then `name`, then the type. Else a role locator of Playwright with the name of the button.
     A locator of Playwright must find one element.
  3. It shall propose a field name: `username`, `password`, `email`, `otp`, else the `name`. A
     button gets `submit`.
  4. It shall add each field and button whose selector is not in the section to DISCOVERED_FILE,
     in the format of `fields.ini`. The section is the URL pattern of the page. A path segment that
     looks like an ID becomes `*`. It shall not remove a line.
- **Alternative Flow:**
  - The page was submitted by the form fill or by the user → the server waits a maximum of
    DISCOVER_WAIT (5000 ms) for a field or a button.
  - The page has no field and no button → the server writes nothing.
- **Note:** An ID segment has only digits, is a UUID, or has more than 16 characters of hex or
  base64url with a digit and a letter.

#### REQ-039a — Record of the used fields and buttons

- **Pre-condition:** DISCOVER is `1`.
- **Basic Flow:**
  1. The server shall record each fill of a field, each click of a button and each submit without a
     button in the browser. It shall record the selector of REQ-039 and not the value.
  2. It shall get the records after each call of the agent and at shutdown.
  3. It shall give each record to the auto-fill (an element that the form fill touched), to the
     agent (in the time of its call), else to the user.
  4. It shall log the records of the user and of the agent: `<who>_filled`, `<who>_pressed`,
     `<who>_submitted`.
  5. It shall write `; used: filled by <who>` or `; used: pressed by <who>` above the entry in
     DISCOVERED_FILE, one time for each text. A missing entry is added first.

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

- **Basic Flow:** The server shall write each event into two files in LOG_DIR/`<client>`/:
  start, client, tool call, result (duration, error flag, size of the content), opened page,
  filled field, submit, failed fill, discovered fields, records of REQ-039a, blocked host, upstream
  stderr, shutdown. `<client>` is the client name of MCP `initialize`, in lowercase with only
  `a-z`, `0-9` and `-`.
  1. The file name is the start time and the process ID: `mm-dd_hhmmss_<pid>`.
  2. `<name>.log.json` gets one JSON line for each event, with all fields.
  3. `<name>.log` gets one line for each event: `HH:MM:SS <event> <url> <key>=<value> ...`, a
     maximum of LOG_LINE_MAX (160) characters. It has no level and no process ID. A URL has no
     scheme and no fragment. A path segment of more than 24 characters and a query value of more
     than 4 characters are cut.
  4. At the open of the files, the server keeps the newest LOG_KEEP (5) pairs of the folder,
     with the new pair.
- **Alternative Flow:**
  - Events come before `initialize` → the server keeps them, and writes them when it opens the
    files. The server stops before `initialize` → the folder is `unknown`.
  - LOG_LEVEL is `debug` → the server also writes the result text into `.log.json`, a maximum of
    DEBUG_TEXT_MAX (20000) characters.
- **Note:** The name of an error event ends in `_error` or `_failed`.

#### REQ-051 — No secrets in the log

- **Basic Flow:** The server shall replace the values of the arguments `text`, `value`, `values`
  and `password` with their length.
- **Alternative Flow:** LOG_SECRETS is `1` → the server logs the values of the arguments.
- **Post-condition:** The log never has a value of a provider.

---

## 7. Lanes

#### REQ-060 — Lane tools

- **Basic Flow:** The server shall give these tools. They need no lane.
  1. `browser_lane_open`: the server opens a lane (REQ-062) and gives its ID, e.g. `lane-3f9a`.
     The ID is random.
  2. `browser_lane_close` with `lane`: the server closes the lane (REQ-063).
  3. `browser_lanes`: the server gives the open lanes, MAX_LANES, and the tabs and idle time of
     each lane.
- **Alternative Flow:** MAX_LANES (3) lanes are open → `browser_lane_open` fails at once with
  "Busy", the number of open lanes and the text to call `browser_lanes` later.

#### REQ-061 — Lane of a call

- **Basic Flow:**
  1. Each upstream tool shall have the required parameter `lane`.
  2. The server shall forward the call without `lane` to the upstream connection of the lane.
  3. Each lane shall have its own tabs, current tab, page URL, fill state and recorder state.
- **Alternative Flow:**
  - `browser_close` → the server closes the lane, as `browser_lane_close`.
  - `browser_tabs` with `action=new`, and the lane has MAX_TABS_PER_LANE (5) tabs → the server gives
    an error result and does not call upstream.
  - A page opens a tab over MAX_TABS_PER_LANE (5) → the server closes the tab at once. The next
    result of the lane gets a note.
- **Exception Flow:** `lane` is missing, or the lane is not open → the server gives an error result
  (UI-02) that tells the agent to call `browser_lane_open`.

#### REQ-062 — Open a lane

- **Basic Flow:**
  1. The server shall start the browser if it does not run (REQ-065).
  2. It shall read STATE_FILE and open a new browser context with this state.
  3. It shall make a new upstream connection with this context.
- **Alternative Flow:** STATE_FILE is missing or damaged → the lane starts without logins.

#### REQ-063 — Close a lane

- **Trigger:** `browser_lane_close`, `browser_close`, LANE_IDLE (10 min) without a call
  (REQ-066), or the shutdown (REQ-003).
- **Basic Flow:**
  1. In the discovery mode, the server shall get the records of the recorder (REQ-039a).
  2. It shall save the storage state of the lane (REQ-064).
  3. It shall close the upstream connection and the context.
  4. It shall stop the browser when no lane is open (REQ-065).
- **Post-condition:** The log has `lane_closed` with the reason.

#### REQ-064 — Storage state

- **Basic Flow:**
  1. The server shall get the cookies and the localStorage of the lane. It shall also get the
     IndexedDB if `[storage] indexeddb` of `server.ini` lists a host.
  2. It shall remove the IndexedDB of each origin whose host is not in the list.
  3. It shall merge the state into STATE_FILE. An entry is a cookie (name, domain and path) or an
     origin. An entry that the lane changed or added wins. An entry that the lane did not change
     keeps the value of the file. An entry that the lane removed goes away, if the file did not
     change it. Expired cookies go away.
  4. It shall write a temp file with the mode `0600`, then rename it to STATE_FILE.
- **Exception Flow:** The save fails → the server logs `state_save_failed`.
- **Post-condition:** STATE_FILE never goes into a result, a log or OUTPUT_DIR.

#### REQ-065 — Browser of the lanes

- **Basic Flow:**
  1. All lanes of the server shall use one Chromium, in the render mode of REQ-015.
  2. The server shall start Chromium with the first lane, and stop it when the last lane closes.
- **Exception Flow:** Chromium does not start → `browser_lane_open` fails with the error.

#### REQ-066 — Idle lanes

- **Basic Flow:** Each IDLE_CHECK (30000 ms), the server shall close each lane without a call for
  LANE_IDLE (10 min). A lane with a call that runs is not idle.

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
| ASK_TIMEOUT | 300000 | ms | — | Maximum time of a dialog of the ask provider |
| TOOL_TIMEOUT | 600000 | ms | — | Maximum time of one call without progress |
| NODE_VERSION | v24.22.1 | — | `NODE_VERSION` in `run.sh` / `run.bat` | Pinned Node.js runtime |
| RENDER_MODE | DEFAULT | — | `RENDER_MODE` | `DEFAULT`, `HEADED`, `HEADED_INVISIBLE` or `HEADLESS` (REQ-015) |
| BROWSER | chromium | — | — | The only browser |
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
| LOG_DIR | `.local_assets/logs/` | — | `BROWSER_AUTOMATION_X_MCP_LOG_DIR` | Folder of the log folders of the clients |
| LOG_LINE_MAX | 160 | characters | — | Maximum length of a line in the `.log` file |
| LOG_KEEP | 5 | file pairs | — | Log file pairs that stay for each client |
| LOG_LEVEL | info | — | `BROWSER_AUTOMATION_X_MCP_LOG_LEVEL` | `error`, `info` or `debug` |
| LOG_SECRETS | unset | — | `BROWSER_AUTOMATION_X_MCP_LOG_SECRETS` | `1` logs the values of the secret arguments |
| SERVER_NAME | browser-automation-x-mcp | — | — | Server name for the client |
| OUTPUT_DIR | `.local_assets/browser-automation-x-mcp/output/` of the working folder | — | — | Output files of upstream |
| MAX_LANES | 3 | lanes | — | Maximum open lanes of one server |
| MAX_TABS_PER_LANE | 5 | tabs | — | Maximum tabs of one lane |
| LANE_IDLE | 10 | min | — | Time without a call, after which a lane closes |
| IDLE_CHECK | 30000 | ms | — | Interval of the check for idle lanes |
| STATE_FILE | `.local_assets/storage-state-<hash of the working folder>.json` | — | `BROWSER_AUTOMATION_X_MCP_STORAGE_STATE` | Storage state of the lanes of one workspace (REQ-064) |
| FILL_WAIT | 10000 | ms | — | Maximum wait for the fields of a page |
| SUBMIT_WAIT | 10000 | ms | — | Maximum wait for the load and for the network after a submit |
| FILL_ROUNDS | 3 | rounds | — | Maximum fill and submit rounds in one call |
| MASK | `***` | — | — | Replacement of a masked value |
| DISCOVER | unset | — | `BROWSER_AUTOMATION_X_MCP_DISCOVER` | `1` turns on the discovery mode |
| DISCOVERED_FILE | `.local_assets/discovered-fields.ini` | — | — | Fields and buttons that the discovery mode found |
| DISCOVER_WAIT | 5000 | ms | — | Maximum wait for a field or a button after a submit |
| DEBUG_TEXT_MAX | 20000 | characters | — | Result text in a debug entry |
