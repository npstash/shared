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
  or its plugins.
  1. The server name shall be SERVER_NAME (browser-automation-x-mcp).
  2. The instructions shall start with: "Use the tools of this server for each browser automation
     task when they are available. This is mandatory." Then they shall tell the agent to open a
     lane with a browser session (REQ-062), to tell the user the browser session, to give the lane
     ID in each call, to use one lane for each agent, and to close it. A "session" of the browser
     that the user asks for is the browser session.
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

- **Basic Flow:** The server shall keep STATE_FILE, the log, temp files and the browser registry
  (Linux) in the tool folder. It shall keep the output files (snapshots,
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

- **Trigger:** The Chromium of a lane starts (REQ-065).
- **Basic Flow:**
  1. Before the start, the server shall write settings into `Default/Preferences` of the lane
     profile. The settings stop the password manager, its leak check, the translate bar, the
     "restore pages" bubble and autofill prompts.
  2. The server shall start Chromium with `--deny-permission-prompts`.
- **Post-condition:** No bubble of the browser covers the page. A test on Xvfb shows no translate
  bubble on a Polish page.

## 3. Tool switches

#### REQ-019 — Config folder

- **Trigger:** The server starts.
- **Basic Flow:** The server shall read its config files from the folder that `--config-dir DIR`
  gives. A relative path is relative to the working folder. The files are JSON:
  1. `server.json`: the plugin instances (REQ-031), the tool switches, and `recordHosts`
     (REQ-042).
  2. `hosts.json`: `defaultAccess`, and the hosts: a tree of root domains and their subdomains,
     each with its access (REQ-037).
  The schemas are in [DESIGN.md](DESIGN.md#8-data-model). The server writes `hosts.json` only as
  REQ-042 says. The plugins read and write their own files in the config folder (REQ-031).
- **Alternative Flow:** A config file is missing → the server shall copy its template from the
  tool folder.
- **Exception Flow:** `--config-dir` is missing → the server does not start. It writes the error
  to stderr.

#### REQ-020 — Tool list in the config

- **Trigger:** The server starts.
- **Basic Flow:** The server shall add `"<tool>": { "enabled": true|false }` to `tools` of
  `server.json` for each tool that the file does not list. The default is `false` for the tools
  in DANGEROUS_TOOLS and `true` for the others. The other keys of the file shall stay.
- **Alternative Flow:**
  - `enabled` is not `true` or `false` → the server treats the tool as disabled and logs it.
  - The user changes the file → the server uses the new values at the next call.
- **Post-condition:** `tools` lists each tool of the server, sorted.

#### REQ-021 — Call of a disabled tool

- **Trigger:** The client calls a disabled tool.
- **Basic Flow:** The server shall not forward the call. It shall give an error result with the
  reason (UI-02).
- **Alternative Flow:** `tools/list` → the server lists the tool. Its description starts with
  `DISABLED: this tool is turned off in the configuration.` and the reason.

## 4. Form fill

The agent does not fill credentials or personal data. The server fills the fields that the
plugins find and match, and submits the form. The agent gets the page after the submit. The server
has no code that finds fields: the plugins do this (REQ-031).

#### REQ-030 — Fill after a call

- **Trigger:** A result of upstream shows a page URL, and a dom-classifier instance is on.
- **Basic Flow:**
  1. The server shall run the dom-classifier instances in each frame of the page (REQ-031b). It
     shall wait for a classified field. In a login flow (after a login click or a submit), it
     waits a maximum of FLOW_WAIT (3000 ms). Else it waits a maximum of PEEK_WAIT (3000 ms).
  2. It shall get the key of each field from the match-strategy instances (REQ-031c).
  3. It shall select the submit method that serves the most fields with a key. On a tie, the
     first method in the order of the dom-classifier instances wins. It shall fill only the fields
     that this method serves.
  4. It shall get the values of the keys (REQ-031a), fill the fields that have a value, and
     submit (REQ-038).
  5. It shall check the host of the page after the submit (REQ-041) before each other step.
  6. It shall repeat steps 1–5 on the new page, a maximum of FILL_ROUNDS (3) rounds.
  7. It shall give the client a snapshot of the page after the last submit, in place of the
     result of upstream.
- **Alternative Flow:**
  - The server waited for this URL before, and the page did not change by a submit or a login
    click → it does not wait. It checks the fields one time.
  - No submit method serves a field with a key → the server fills each field with a key, and
    does not submit (REQ-038).
  - No field is classified, no field has a key, or no key has a value → the server does nothing.
    The client gets the result of upstream.
  - No field is classified in a login flow → the server logs `fill_no_field` with the URL and the
    wait. The flow ends.
  - The host of the page after a submit is blocked → the server stops the fill. It opens
    `about:blank` and gives the error of REQ-041.
- **Exception Flow:** A plugin or the page code fails → the server logs the error and does
  nothing. The client gets the result of upstream. The error is not visible to the client.

#### REQ-031 — Plugins

- **Basic Flow:**
  1. A plugin is one implementation in `plugins/<category>/<plugin>/`. A plugin instance is one
     entry in `server.json` with its config. Shared plugin code is in `plugins/common/<plugin>/`.
  2. `plugins` of `server.json` has one array for each category: `key-value-source`,
     `dom-classifier`, `match-strategy`, `page-script`. An approval plugin
     (category `approval-plugin`) is only in `approval` of a key-value-source instance.
  3. An instance has `name` (unique), `plugin`, `description`, `enabled` and `config`. A
     key-value-source instance also has `mask` and an optional `approval` with `plugin`,
     `enabled` and `config`.
  4. The server shall use the instances that are on, in the order of the array.
  5. A plugin shall get only its config, a logger, and the data of each call. An approval plugin
     also gets the MCP elicitation. A plugin gets no object of the server and no object of
     Playwright.
  6. A plugin can keep state. It reads and writes its own files. A path in its config is relative
     to the config folder.
- **Alternative Flow:**
  - An instance has `"enabled": false` → the server does not use it.
  - `approval` has `"enabled": false` → the key-value-source gives its values without an approval.
  - A category has no instance that is on → the server does not do the steps of that category.
- **Exception Flow:** An instance has no `name`, `plugin`, `description` or `config`, two
  instances have the same `name`, the plugin has no folder in its category, or `approval` names a
  plugin that is not in `approval-plugin` → the server does not start.

#### REQ-031a — Key-value-source

- **Basic Flow:**
  1. A key-value-source instance shall give the keys that it has for a page, and the values of
     these keys.
  2. The first instance in the array order that has a key for the page shall give the value.
  3. It shall give the keys of a value (REQ-031d).
- **Alternative Flow:** The instance has an approval plugin → the server gets the approval first
  (REQ-036c).

#### REQ-031b — Dom-classifier

- **Basic Flow:**
  1. A dom-classifier instance shall run as a page script against the live DOM of each frame.
  2. It shall give the fields: the element and a hint. A hint is a short text, e.g. `password`,
     `username`, `email`. The hints are an open list. A hint is not a key.
  3. It shall give the submit methods, each with the field elements that it serves: a click of an
     element, Enter in a field, or `requestSubmit()` of the form of a field.
  4. It shall give the login links: the elements.
  5. The server shall merge the results of all instances. For the same element, the first
     instance in the array order wins.
- **Note:** Selectors that only Playwright can resolve, e.g. `internal:role=…`, are not used.

#### REQ-031c — Match-strategy

- **Basic Flow:**
  1. A match-strategy instance shall give the key of a field from its hint. The key is a key
     that a key-value-source has for the page.
  2. The server shall ask the instances in the array order. Each instance gets only the fields
     without a key.
- **Alternative Flow:** No instance gives a key for a field → the server does not fill the field.

#### REQ-031d — Page-script

- **Basic Flow:**
  1. The server shall inject the page script of each page-script instance into each frame of each
     lane.
  2. It shall give the page script a channel to the Node code of its plugin.
  3. A message can have values. The server shall replace each value with its keys from the
     key-value-source instances, in their order, before it gives the message to the Node code. The
     Node code never gets a value.
  4. The server shall tell the Node code when a lane closes.
- **Alternative Flow:** The value is equal to a value of a masked instance → the server adds it to
  the masked values (REQ-032).
- **Note:** A page script can read the field values in the page. The page scripts are reviewed
  local code.

#### REQ-031e — Marks for page scripts

- **Basic Flow:** The server shall mark each element that the form fill touches, and each element
  of an agent call with a `ref`. A page script shall be able to read the mark.
- **Alternative Flow:** An element that `browser_evaluate` or `browser_press_key` changes has no
  mark.

#### REQ-032 — Mask of filled values

- **Pre-condition:** The key-value-source instance of the value is masked: its `mask` in
  `server.json` is not `false`.
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

#### REQ-034 — Key-value-source `vault`

- **Basic Flow:**
  1. The plugin shall read the file that `file` of its config gives: a tree of root domains and
     subdomains (as REQ-037), each node with an optional `system`. The nearest node of the host
     wins. `system` is the exact name of a vault system.
  2. Its keys for a page are the secret names of the system. The case of a key has no effect.
  3. It shall give the secret whose name is the key, through the vault tool, from the vault that
     `vault` of its config gives.
  4. To give the keys of a value, it shall compare the value with each secret of the system, in
     the order of `get-system`.
  5. It shall not search the vault for systems.
- **Alternative Flow:** No node of the host has a `system` → the instance has no keys.
- **Exception Flow:**
  - `vault` or `file` is empty, or the file is not valid → error.
  - The vault tool fails → error with its message.

#### REQ-035 — Key-value-source `values`

- **Basic Flow:**
  1. The plugin shall give the value of the key from `values` of its config. The case of the key
     has no effect. It has the same keys for each page.
  2. To give the keys of a value, it shall give each key of `values` with an equal value.

#### REQ-036 — Removed

The ask provider is removed.

#### REQ-036a — Approval plugin `approve-dialog`

- **Pre-condition:** The client declared the elicitation capability.
- **Basic Flow:** The plugin shall show a dialog to the user (UI-03). It shall give `true` when the
  user accepts with the approval.
- **Alternative Flow:** The client cannot show dialogs → the plugin refuses.
- **Exception Flow:** The user declines, cancels, or gives no answer in APPROVAL_TIMEOUT (15000 ms)
  → the plugin refuses.

#### REQ-036b — Approval plugin `approve-https`

- **Basic Flow:**
  1. The plugin shall connect to `address` of its config with TLS.
  2. It shall compare the SHA-256 fingerprint of the certificate of the service with `fingerprint`
     of its config. Case and `:` have no effect.
  3. It shall send `POST <address>/approve` with the JSON `{ "host", "keys", "client" }`. It sends
     no authentication.
  4. It shall give `true` when the answer is `200` with `{ "approved": true }`.
- **Alternative Flow:** `address` or `fingerprint` is empty → the plugin refuses, and does not
  connect.
- **Exception Flow:** The fingerprint is not equal, the connection fails, the answer is an other
  answer, or no answer comes in APPROVAL_TIMEOUT (15000 ms) → the plugin refuses. It sends nothing
  after a wrong fingerprint.

#### REQ-036c — Approval of a fill

- **Trigger:** The fill needs keys whose key-value-source instance has an approval plugin
  (REQ-031a).
- **Basic Flow:**
  1. The server shall ask each approval plugin one time for each fill. The request has all keys
     of the fill that its instance gives, the host of the page, and the client name of MCP
     `initialize`. It has no value and no URL.
  2. When the plugin approves, the server shall get the values of the keys from the instance.
- **Exception Flow:** The plugin refuses → error; the server does not fill. No later instance gives
  the keys. The server logs `fill_error`. The result of the call gets the note "The user did not
  approve an action on this page." The note does not name the form fill (REQ-005).
- **Note:** The mask of the key-value-source instance applies (REQ-032).

#### REQ-037 — Hosts of `hosts.json`

- **Basic Flow:** The server shall read the hosts of `hosts.json` as a tree:
  1. A key of `hosts` is a root domain: the registrable domain of the Public Suffix List, also for
     private suffixes. An IP address or a host without a registrable domain is its own root domain.
  2. A node has optional `access` and `subdomains`. A key of `subdomains` is the full host name of
     a subdomain of the node.
  3. The node of a host is the deepest node that covers it. A node covers its host and each
     subdomain of it.
  4. `access` goes down the tree. The nearest value wins: the node of the host, then its parents.
- **Exception Flow:** A key of `hosts` is not a root domain, a key of `subdomains` is not a
  subdomain of its node, or a node has an other key → the server gives an error.
- **Note:** The plugin files that have a tree of hosts use the same rules, e.g. REQ-034, REQ-039c.

#### REQ-030a — Login link

- **Pre-condition:** A dom-classifier gives a login link on the page (REQ-031b), and a
  key-value-source instance has keys for the page (REQ-031a).
- **Trigger:** A result of upstream shows a page URL.
- **Basic Flow:**
  1. Before the fill of REQ-030, the server shall click the first visible login link.
  2. It shall wait SUBMIT_WAIT (10000 ms) for the next page, then check its host (REQ-041).
  3. It shall log `login_clicked`, and continue with REQ-030 on the next page. The click is not a
     round of FILL_ROUNDS.
  4. At the end of the fill, the server shall open again the URL where it clicked, also after a
     failed login. It shall check its host (REQ-041) and log `page_opened` with `login_return`.
- **Alternative Flow:**
  - No login link is visible → the server does not click.
  - The server clicked a login link of the host in this lane before → it does not click again.
  - The page at the end of the fill has the URL of the click → the server does not open it again.

#### REQ-038 — Submit and loop guard

- **Basic Flow:**
  1. The server shall run the submit method of the dom-classifier: click the element, press Enter
     in the field, or call `requestSubmit()` of the form of the field.
  2. It shall wait a maximum of SUBMIT_WAIT (10000 ms) for the load of the page, then for the
     end of the network requests.
  3. It shall fill each fill one time only. The identity of a fill is the host and the sorted keys
     of its fields.
- **Alternative Flow:**
  - No dom-classifier gives a submit method for the filled fields → the server fills and does not
    submit.
  - The same fill comes again, e.g. after a wrong password → the server does not fill. It logs
    `fill_failed`.
- **Post-condition:** The guard is reset on a page without a classified field.

#### REQ-039 — Page-script `discovery`: record

- **Pre-condition:** An instance of the page-script `discovery` is on.
- **Trigger:** A fill of a field, a click of a button, a click of a link to an other page, or a
  submit without a button, in a page of a lane.
- **Basic Flow:**
  1. For a field, the script shall make a CSS selector that is unique in its frame: `autocomplete`,
     then `name`, then an `id` that does not look generated, then the type, `aria-label`,
     `placeholder`. For a button: an `id` that does not look generated, then `name`, then the
     type. Else, for a button or a link, a matcher `{ "css", "text" }` with its visible text,
     case-insensitive.
  2. It shall skip each element with a mark of the server (REQ-031e).
  3. At a click of a button or a submit, the script shall send the values of the fields of the
     form that were filled since the last submit (REQ-031d).
  4. The plugin shall log each record: `user_filled`, `user_pressed`, `user_submitted`,
     `user_followed`, each with the time of the event in the browser (`at`). The log has no value.
- **Note:** An element that `browser_evaluate` changes has no mark: the plugin records it as an
  element of the user.

#### REQ-039a — Page-script `discovery`: write the discovery file

- **Pre-condition:** An instance of the page-script `discovery` is on.
- **Trigger:** A click of a button or a submit (REQ-039), a navigation of the page, or the close of
  the lane.
- **Basic Flow:**
  1. The plugin shall read the discovery file again. It is the file that `file` of its config
     gives.
  2. The node is the node of the root domain of the host (REQ-037). A missing root domain is a new
     node.
  3. The form is the form of the node that has a selector of the filled fields. Else a new form
     goes at the end of `forms`.
  4. For each field, it shall write `"<selector>": "<key>"` into `fields` of the form. The key is
     the first key of the value (REQ-031d).
  5. It shall write the button that the user clicked into `submit` of the form.
  6. For a submit without a button, it shall write the first visible submit button of the form into
     `submit`. If the form has no such button, it shall write `enter`.
  7. At a submit, it shall write the last link that the user followed before into `login`. Then it
     forgets the link.
  8. It shall change only these entries. The other entries of the file stay.
- **Alternative Flow:**
  - The value has no key, or the trigger has no values (a navigation, the close of the lane) → the
    plugin writes the name from the attributes of the field: `username`, `password`, `email`,
    `otp`, else its `name`. It does this only if the selector has no key.
  - The value is empty → the server gives no key.

#### REQ-039b — Dom-classifier `discovery`

- **Pre-condition:** An instance of the dom-classifier `discovery` is on.
- **Basic Flow:**
  1. The plugin shall read the discovery file that `file` of its config gives. It shall read it
     again when it changes.
  2. The forms and the login links of the node of the host and of its parents apply (REQ-037).
  3. Each visible field of a form is a field. Its hint is the key of the file.
  4. The first `submit` entry of a form that applies is the submit method of its visible fields. A
     matcher applies when its element is visible: a click. `enter` always applies: Enter in the
     last field.
  5. Each visible element of a `login` matcher is a login link.
- **Exception Flow:** The file is not valid → error; the classifier gives no result.

#### REQ-039c — Dom-classifier `heuristic`

- **Basic Flow:**
  1. The plugin shall give each visible field of a form as a field. The hint comes from the
     attributes: `username`, `password`, `email`, `otp`, else its `name`.
  2. The submit method of the fields of a form is the click of the first visible submit button of
     the form. Without a button, it is `requestSubmit()` of the form. A field without a form gets
     Enter.
  3. It gives no login links.

#### REQ-039d — Match-strategy `propagate`

- **Basic Flow:** The key of a field shall be its hint, if a key-value-source instance has this
  key for the page. The case has no effect.
- **Alternative Flow:** No key-value-source has the hint as a key → the plugin gives no key.

## 5. Host access

#### REQ-040 — Check before a page opens

- **Trigger:** The client calls `browser_navigate`, or `browser_tabs` with `action = new` and a URL.
- **Basic Flow:** The server shall check the host of the URL with the tree of `hosts.json` (REQ-037):
  1. The node of the host or one of its parents has `"access": "deny"` → blocked. A deny wins also
     over an `"allow"` below it.
  2. Else the nearest node with an `access` decides.
  3. Else `defaultAccess` decides.
- **Alternative Flow:** The URL has no host (e.g. `about:blank`) → the server allows it.
- **Exception Flow:** The host is blocked → the server forwards nothing. It gives an error result
  with the URL and the reason (UI-02).

#### REQ-041 — Check after each call

- **Trigger:** A result of upstream shows a page URL.
- **Basic Flow:** The server shall check the host of the page as REQ-040 says.
- **Exception Flow:** The host is blocked → the server opens `about:blank`. It gives an error
  result with the closed URL and the reason.

#### REQ-042 — Record the opened hosts

- **Pre-condition:** RECORD_HOSTS (false) is `true`.
- **Trigger:** A page of an allowed host loaded: by a call, or by the user in the browser.
- **Basic Flow:** The server shall add the root domain of the host (REQ-037) with
  `"access": "allow"` to `hosts.json` at once. An access that the file has stays.

#### REQ-043 — Config files in the config folder

- **Trigger:** The server starts, and `server.json` or `hosts.json` is missing in the config folder.
- **Basic Flow:** The server shall copy `config/server.template.json` or `config/hosts.template.json`
  to it (REQ-019).
- **Note:** A plugin makes its missing files itself.

## 6. Logging

#### REQ-050 — Log of each call

- **Basic Flow:** The server shall write each event into two files in LOG_DIR/`<client>`/:
  start, client, tool call, result (duration, error flag, size of the content), opened page,
  filled field, submit, failed fill, events of the plugins, blocked host, upstream stderr,
  shutdown. `<client>` is the client name of MCP `initialize`, in lowercase with only
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
- **Post-condition:** The log never has a value of a key-value-source.

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
  3. Each lane shall have its own tabs, current tab, page URL and fill state.
- **Alternative Flow:**
  - `browser_close` → the server closes the lane, as `browser_lane_close`.
  - `browser_tabs` with `action=new`, and the lane has MAX_TABS_PER_LANE (5) tabs → the server gives
    an error result and does not call upstream.
  - A page opens a tab over MAX_TABS_PER_LANE (5) → the server closes the tab at once. The next
    result of the lane gets a note.
- **Exception Flow:** `lane` is missing, or the lane is not open → the server gives an error result
  (UI-02) that tells the agent to call `browser_lane_open`.

#### REQ-062 — Open a lane

- **Trigger:** `browser_lane_open` with `browserSession`: `normal`, `fresh` or `isolated`.
- **Basic Flow:**
  1. The server shall make the lane profile in LANES_DIR/`<pid>-<lane id>` with the settings of
     REQ-016, and start a Chromium with it (REQ-065).
  2. For `normal`, it shall read STATE_FILE and give this state to the context of the Chromium.
     For `fresh` and `isolated`, the context starts without logins.
  3. It shall make a new upstream connection with this context.
  4. The result shall give the lane ID and the browser session, and tell the agent to tell the user
     the browser session. `browser_lanes` shall give the browser session of each lane.
- **Alternative Flow:** STATE_FILE is missing or damaged → the lane starts without logins.
- **Exception Flow:** `browserSession` is missing or has an other value → the server gives an error
  result (UI-02) with the three values.

#### REQ-063 — Close a lane

- **Trigger:** `browser_lane_close`, `browser_close`, LANE_IDLE (10 min) without a call
  (REQ-066), or the shutdown (REQ-003).
- **Basic Flow:**
  1. The server shall tell the page-script instances that the lane closes (REQ-031d).
  2. It shall save the storage state of the lane (REQ-064).
  3. It shall close the upstream connection and the Chromium of the lane, and delete the lane
     profile.
  4. It shall stop Xvfb when no lane is open (REQ-065).
- **Post-condition:** The log has `lane_closed` with the reason.

#### REQ-064 — Storage state

- **Pre-condition:** The browser session of the lane is `normal` or `fresh` (REQ-062).
- **Trigger:** A page of the lane loads (also after a login of the user), or the lane closes.
- **Basic Flow:**
  1. The server shall get the cookies, the localStorage and the IndexedDB of the lane.
  2. It shall remove the IndexedDB of each origin whose host no node of `hosts.json` covers.
  3. It shall merge the state into STATE_FILE. An entry is a cookie (name, domain and path) or an
     origin. An entry that the lane changed or added wins. An entry that the lane did not change
     keeps the value of the file. An entry that the lane removed goes away, if the file did not
     change it. Expired cookies go away.
  4. It shall write a temp file with the mode `0600`, then rename it to STATE_FILE.
- **Alternative Flow:**
  - `fresh` → the merge starts from an empty state: the lane adds or changes entries, but removes
    no entry of the file.
  - `isolated` → the server does not save the state of the lane.
- **Exception Flow:** The save fails → the server logs `state_save_failed`.
- **Post-condition:** STATE_FILE never goes into a result, a log or OUTPUT_DIR.

#### REQ-065 — Browser of the lanes

- **Basic Flow:**
  1. Each lane shall have its own Chromium, in the render mode of REQ-015.
  2. In `HEADED_INVISIBLE`, all lanes of the server shall use one Xvfb. The server shall start it
     with the first lane, and stop it when the last lane closes.
  3. At each start, the server shall delete the lane profiles of servers that do not run.
- **Exception Flow:** Chromium does not start → `browser_lane_open` fails with the error.

#### REQ-066 — Idle lanes

- **Basic Flow:** Each IDLE_CHECK (30000 ms), the server shall close each lane without activity
  for LANE_IDLE (10 min). Activity is a call of the agent, or a key press, click, scroll or input
  of the user in the browser. A page script reports the input of the user at most each
  ACTIVITY_INTERVAL (5000 ms). A lane with a call that runs is not idle.

## User interface

### UI-03 — Dialog of the approval plugin `approve-dialog`

- **Purpose:** The user approves a fill with values of a key-value-source, e.g. a login.
- **Shows:** The host of the page, the keys, and the client name. It shows no value and no URL.
- **Actions:** Approve and accept → the server fills the values (REQ-036c). Decline, cancel or no
  approval → the server does not fill the form.
- **Feedback:** The agent gets the page after the submit, with MASK in place of masked values.
- **Realization:** An MCP elicitation form of the client with one checkbox `approve`.

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
| APPROVAL_TIMEOUT | 15000 | ms | — | Maximum time of one approval of an approval plugin |
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
| LANES_DIR | `.local_assets/lanes/` | — | — | Profiles of the open lanes: `<pid>-<lane id>` |
| ACTIVITY_INTERVAL | 5000 | ms | — | Minimum time between two reports of the input of the user |
| STATE_FILE | `.local_assets/storage-state-<hash of the working folder>.json` | — | `BROWSER_AUTOMATION_X_MCP_STORAGE_STATE` | Storage state of the lanes of one workspace (REQ-064) |
| FLOW_WAIT | 3000 | ms | — | Maximum wait for a form field in a login flow |
| PEEK_WAIT | 3000 | ms | — | Maximum wait for a form field on an other page, one time for each URL |
| SUBMIT_WAIT | 10000 | ms | — | Maximum wait for the load and for the network after a submit |
| FILL_ROUNDS | 3 | rounds | — | Maximum fill and submit rounds in one call |
| MASK | `***` | — | — | Replacement of a masked value |
| RECORD_HOSTS | false | — | `recordHosts` in `server.json` | `true` records the opened hosts in `hosts.json` (REQ-042) |
| DEBUG_TEXT_MAX | 20000 | characters | — | Result text in a debug entry |
