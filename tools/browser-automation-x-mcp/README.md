# browser-automation-x-mcp

An MCP server for browser automation. It gives the agent the browser tools, and adds lanes, tool
switches, a form fill, host lists and a log. A lane is an own browser context for one agent:
agents and sessions use the browser in parallel (see [Lanes](#lanes)).

The internals are hidden from the agents. An agent sees the MCP server `browser-automation-x-mcp`
and the browser tools. No text for the agent names Playwright, the form fill or its plugins.
The deny rules of the agent tools close this folder and the config folder to the agents (see
[Deny rules](#deny-rules)). Keep each link to this folder out of the files that agents read.

The implementation uses [Playwright MCP](https://github.com/microsoft/playwright-mcp)
(`@playwright/mcp`) and Chromium. The browser is always Chromium.

Documents (SDD): [PRD](sdd/PRD.md), [SRS](sdd/SRS.md), [QAS](sdd/QAS.md), [DESIGN](sdd/DESIGN.md),
[ADL](sdd/ADL.md). Open items: [DESIGN, section 11](sdd/DESIGN.md#11-open-issues).

```
MCP client (Claude Code) <-stdio-> server: one Playwright MCP connection for each lane -> Chromium
                                           (in the server process)       one context for each lane
```

## Structure

```
run.sh run.bat                launcher of the server and its runtime
package.json                  Node.js packages; the dev packages are for the tests only
tsconfig.json eslint.config.ts   type check and lint (static analysis)
config/                       templates of the config files
plugins/<category>/<plugin>/  the plugins: index.ts; plugins/common/ for shared plugin code
src/                          server.json, hosts.json, logger, host check, plugin APIs and host
playwright/src/               the server
tests/                        the test phases: static/, unit/, functional/, online/; fixtures/
sdd/                          documents of the tool
```

## Run

```bash
./run.sh install                           # make the runtime, install the browser, then stop
./run.sh --config-dir <DIR>                # start the server (MCP server on stdio)
./run.sh test [phase...]                   # run the test phases: all, or e.g. "unit"
run.bat install                            # the same on Windows
```

- Do `install` one time before you add the server to a client. The first install downloads
  approximately 350 MB. A client can stop a server that does not start in time.
- `--config-dir` is necessary. A relative path is relative to the working folder. See
  [Config folder](#config-folder). The server takes no other argument: an other argument stops it
  with an error.
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
| Linux, macOS, WSL | `<TOOL>/run.sh` | `["--config-dir", "<DIR>"]` |
| Windows (native) | `cmd` | `["/c", "<TOOL>\\run.bat", "--config-dir", "<DIR>"]` |
| Windows, browser in WSL | `wsl.exe` | `["<TOOL in WSL>/run.sh", "--config-dir", "<DIR>"]` |

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
        "args": ["--config-dir", "local/configs/browser-automation-x-mcp"]
      }
    }
  }
  ```

- **CLI, user scope:** `claude mcp add --scope user browser-automation-x-mcp -- <TOOL>/run.sh --config-dir <DIR>`.
  Check with `claude mcp list`. In a session, `/mcp` shows the state.
- **VSCode:** the extension uses the configuration of the CLI. If VSCode runs in WSL, run
  `claude mcp add` in the WSL terminal and use `run.sh`.
- **Native Windows:** the root `.mcp.json` has `run.sh`. Add the server in the local scope, which
  wins over the project scope: `claude mcp add --scope local browser-automation-x-mcp -- cmd /c <TOOL>\run.bat --config-dir <DIR>`.
- **Desktop app (Code tab):** uses the configuration of Claude Code on the same computer.
- **Agent SDK:** give the server in `mcp_servers` / `mcpServers` of the options, and allow
  `mcp__browser-automation-x-mcp__*`. Sessions can run at the same time: each one uses its own
  lanes.

  ```python
  options = ClaudeAgentOptions(
      mcp_servers={"browser-automation-x-mcp": {"type": "stdio", "command": "<TOOL>/run.sh",
                   "args": ["--config-dir", "<DIR>"]}},
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
| `unknown argument` | The server takes only `--config-dir`. Remove the other arguments. |
| No window opens | On WSL and without a display, the default is `HEADED_INVISIBLE`. Set `RENDER_MODE=HEADED`. The window opens with the first lane and closes with the last lane. On WSLg it can open behind the editor. |
| A change of `kilo.jsonc` has no effect | Kilo keeps a server that runs. Reload the VSCode window. |

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

`--config-dir` gives the config folder, e.g. `local/configs/browser-automation-x-mcp`. It holds
`server.json`, `hosts.json` and the files of the plugins. A missing `server.json` or `hosts.json` is
first a copy of its template in `config/` of this folder. A plugin makes its missing files itself.

**`server.json`**: how the server works.

```json
{
  "recordHosts": false,
  "plugins": {
    "key-value-source": [
      { "name": "vault-main", "plugin": "vault", "description": "Logins of personal sites", "enabled": true, "mask": true,
        "config": { "vault": "vault-main", "file": "vault-main.json" },
        "approval": { "plugin": "approve-https", "enabled": true,
                      "config": { "address": "https://127.0.0.1:8743", "fingerprint": "AB:CD:..." } } },
      { "name": "values", "plugin": "values", "description": "Values that are not secret", "enabled": true, "mask": false,
        "config": { "values": { "name": "Anna Nowak" } } }
    ],
    "dom-classifier": [
      { "name": "discovery", "plugin": "discovery", "description": "The learned forms", "enabled": true, "config": { "file": "discovery.json" } },
      { "name": "heuristic", "plugin": "heuristic", "description": "Submit methods", "enabled": true, "config": { "fields": false } }
    ],
    "match-strategy": [
      { "name": "propagate", "plugin": "propagate", "description": "Hint as key", "enabled": true, "config": {} }
    ],
    "page-script": [
      { "name": "discovery-recorder", "plugin": "discovery", "description": "The recorder", "enabled": false, "config": { "file": "discovery.json" } }
    ]
  },
  "tools": {
    "browser_click":           { "enabled": true },
    "browser_run_code_unsafe": { "enabled": false }
  }
}
```

- `plugins`: the plugin instances, one array for each category, in the order of use. See
  [Plugins](#plugins). Each instance needs `name` (unique), `plugin` (the folder in
  `plugins/<category>/`), `description` and `config`. `"enabled": false` turns it off. A path in
  `config` is relative to the config folder.
- A key-value-source also has `mask` (see [Form fill](#form-fill); without it, the instance is
  masked) and an optional `approval`.
- `recordHosts`: `true` records the root domain of each loaded page of an allowed host in
  `hosts.json` with `"access": "allow"`. The default is `false`.
- `tools`: the tool switches (see [Tool switches](#tool-switches)). The server adds missing tools.

**`hosts.json`**: the access of the hosts (see [Host access](#host-access)).

```json
{
  "defaultAccess": "allow",
  "hosts": {
    "amazon.pl": { "access": "allow" },
    "premium.pl": { "subdomains": { "sklep.premium.pl": { "access": "deny" } } }
  }
}
```

- A key of `hosts` is a root domain, e.g. `amazon.pl`, not `www.amazon.pl`. The Public Suffix List
  gives the root domain: `amazon.co.uk`, `user.github.io`. An IP address and `localhost` stay.
- `subdomains`: the nodes of the subdomains. A key is the full host name. A deeper host can be the
  child of a subdomain. A node has only `access` and `subdomains`.
- The files of the `vault` and `discovery` plugins are host trees of the same form.

## Form fill

The agent never fills credentials or personal data. After each call that can change the page, the
server asks the plugins:

1. The **dom-classifiers** run in each frame of the page and give the fields (each with a hint, e.g.
   `password`), the submit methods and the login links. A field is a fill candidate: the classifier
   decides what to fill.
2. The **match-strategies** give the key of each field from its hint.
3. The **key-value-sources** give the values; an attached **approval plugin** approves them first.
4. The server fills the fields and runs the submit method. The agent gets the page after the
   submit. It does not know about the fill.

- **No fill after:** `browser_snapshot`, `browser_take_screenshot`, `browser_console_messages`,
  `browser_network_requests`, `browser_network_request`, and `browser_tabs` with `"action": "list"`.
- **Wait:** after a login click or a submit (a login flow), the server waits a maximum of 3 s for a
  visible field. On other pages, it waits until the page settles (no change of the DOM for 300 ms),
  a maximum of 3 s, one time for each URL.
- **No field:** in a login flow, a page without a field ends the flow. The log gets
  `fill_no_field`.
- **Selection:** the server uses the submit method that serves the most fields with a key; on a
  tie, the first one in the order of the dom-classifiers. It fills only the fields that the method
  serves. Without a method, it fills the fields and does not submit.
- **Values:** the first key-value-source in order that has the key gives the value. A field without
  a value stays empty. If no field has a value, the server does nothing.
- **Rounds:** after a submit, the server waits a maximum of 10 s for the page. A second step, e.g.
  the password after the username, gets a fill in the same call. Maximum 3 rounds.
- **Login link:** before the fill, the server clicks the first visible login link of a
  dom-classifier, one time for each lane and host, and only if a key-value-source has keys for the
  page. After the login flow, also after a failed login, it opens again the URL where it clicked.
- **Host check:** each page after a submit gets the host check before the next fill.
- **Loop guard:** the server does each fill (the host and the keys) one time. If the same fill
  comes back, e.g. after a wrong password, it does not fill again. The log gets `fill_failed`. The
  guard is reset on a page without a field.
- **Mask:** `"mask": true` (the default) replaces the values of the instance with `***` in each
  result and in each text file of the output folder. Binary files, e.g. screenshots, stay unchanged.
- **Errors:** a plugin error or a page error goes only to the log. The agent gets the page as it is.

## Plugins

A plugin is one implementation in `plugins/<category>/<plugin>/index.ts`. Its default export is a
class of the API of its category in [src/plugins/](src/plugins/). Shared plugin code is in
`plugins/common/`. A plugin gets only its config and the data of each call: no object of the
server and no object of Playwright.

| Category | Plugin | `config` | What it does |
| --- | --- | --- | --- |
| key-value-source | `vault` | `vault`, `file` | The secrets of the vault system of the page. The file is a host tree; the nearest node with a `"system"` gives the system. The keys are the secret names, e.g. `password`. |
| key-value-source | `values` | `values` | Values that are not secret; the same keys on each page. |
| approval-plugin | `approve-dialog` | none | Approves in a dialog of the client. In `claude -p`, Claude Code cancels the dialog. |
| approval-plugin | `approve-https` | `address`, `fingerprint` | Asks an approval service. |
| dom-classifier | `discovery` | `file` | The forms and the login links of the discovery file. |
| dom-classifier | `heuristic` | `fields` | The submit methods of the forms: the submit button, else `requestSubmit()`, else Enter. With `"fields": true`, also login fields by rules. |
| match-strategy | `propagate` | none | The hint of a field is its key, if a key-value-source has the key. |
| page-script | `discovery` | `file` | The recorder: it writes the forms that the user fills into the discovery file. |

- **Approval:** goes into `"approval"` of a key-value-source. Before a fill, the plugin approves all
  keys of that instance in one request: the host, the keys and the client name; no value and no
  URL. A refusal, or no answer in 15 s, stops the fill. No later source gives the keys. The result
  of the call gets the note "The user did not approve an action on this page."
- **approve-https:** sends `POST <address>/approve` with `{ "host", "keys", "client" }`, and expects
  `{ "approved": true }`. It pins the certificate of the service with `fingerprint` (SHA-256; case and
  `:` have no effect), and sends nothing to an other certificate. An empty `address` or `fingerprint`
  refuses each fill. A service that approves each request is in `projects/other/approve-provider-service`
  of the workspace.
- **heuristic fields:** a visible password field that is not `new-password`, and the text or email
  field before it; else a field with `autocomplete` `username` or `webauthn`. A form that asks for
  the password to confirm an action looks the same as a login: turn `fields` on only if you accept
  this.
- **Vault file**, e.g. `vault-main.json`:

  ```json
  { "hosts": { "amazon.pl": { "system": "Amazon - Nestor" } } }
  ```

### The discovery file

The `discovery` dom-classifier reads it; the recorder writes it.

```json
{
  "hosts": {
    "amazon.pl": {
      "login": [{ "css": "a", "text": "zaloguj się" }],
      "forms": [
        { "fields": { "input[name=\"email\"]": "email" }, "submit": ["#continue"] },
        { "fields": { "#ap_password": "password" }, "submit": ["#signInSubmit"] }
      ]
    }
  }
}
```

- `fields`: `"<css>": "<hint>"`. The hint is a key of a key-value-source, e.g. `password`.
- `submit` and `login`: matchers. A matcher is a CSS selector, or `{ "css", "text" }`: an element
  of the selector whose visible text has the text, case-insensitive. `"enter"` in `submit` presses
  Enter in the last field. Use a login link text that shows only before the login: after the login
  the text changes, and the server does not click.
- The forms and the login links of a node apply to its host and to its subdomains.

### Record the fields of a page (the recorder)

Turn on the page-script `discovery` in `server.json`. The recorder writes into the discovery file at
once. No call of the agent is necessary.

- **Forms:** the forms and the login links go into the node of the root domain. A new form that
  has a selector of a recorded form adds its selectors to that form. Else it is a new form.
- **Fields:** at a click of a button or a submit, the page code sends the values of the fields that
  the user filled. The server gives the recorder only the keys of the values. The recorder writes
  `"<selector>": "<key>"`. A field without a key gets a name from its attributes (`username`,
  `password`, `email`, `otp`, else its `name`), but only if the selector has no key yet.
- **Submit:** the button that the user clicks goes into `submit`. For a submit with Enter, the submit
  button of the form goes into `submit`; without such a button, `"enter"`.
- **Login link:** the last link that the user followed before a submit goes into `login`.
- The form fill still works while the recorder is on. The fields that the form fill or the agent
  touched do not go into the file. A field that the agent changes with `browser_evaluate` counts as
  a field of the user.
- The log gets each action of the user, without values: `user_filled`, `user_pressed`,
  `user_submitted`, `user_followed`, each with the time of the event (`at`). It gets
  `fields_written` for each change of the file.
- Before each write, the recorder reads the file again. Your changes stay.
- Selector of a field: autocomplete, name, an id that does not look generated, the type, aria-label,
  placeholder: the first CSS selector that is unique. Matcher of a button: id, name, type; else
  `{ "css", "text" }`.

1. Map the root domain of the site to its vault system in the vault file. Do this before the
   submit: without it, the vault has no keys for the site.
2. Do each step of the login in the browser.
3. Turn off the recorder.

## Host access

`hosts.json` decides which hosts open:

- A node with `"access": "deny"` blocks its host and its subdomains. A deny wins also over an
  `"allow"` of a subdomain below it.
- Else the nearest node with an `access` decides: the node of the host, else its parents.
- Else `defaultAccess` decides (`"allow"` or `"deny"`).
- The server checks the URL before it opens a page, and the page after each call (clicks,
  redirects, submits). A blocked page is replaced by `about:blank`, and the call fails.
- The server writes `hosts.json` only with `recordHosts`: it records the opened hosts.

## Tool switches

`tools` of `server.json` has one entry for each tool: `{ "enabled": true }` or
`{ "enabled": false }`. At start, the server adds the missing tools with their default.

- Disabled by default: `browser_run_code_unsafe`, `browser_evaluate`, `browser_file_upload` and
  `browser_drop`. A web page can misuse them through prompt injection.
- A disabled tool stays in the tool list with a note. A call to it fails with the reason.
- The form fill uses `browser_run_code_unsafe` of Playwright MCP also when the switch disables it.
- `browser_evaluate` can read a value that stays in a field after a failed submit.

## Lanes

A lane is an own browser for one agent: its own tabs, current tab and form state. Each session (a
Claude Code chat, a Codex session, a Kilo window) has its own server and render mode.

- `browser_lane_open` gives a lane ID, e.g. `lane-3f9a`. Each other tool needs the parameter
  `lane` with this ID. It needs `browserSession` (see **Browser session** below), and its result
  tells the agent to tell you the browser session. Each agent that works in parallel, also a subagent, opens its own lane.
- `browser_lane_close` closes the lane. `browser_close` does the same.
- `browser_lanes` gives the open lanes and the maximum. When `browser_lane_open` gives "Busy",
  call `browser_lanes` later, then try again.
- Limits: 3 lanes for each server, 5 tabs for each lane. A popup over the tab limit closes, and the
  next result tells it. A lane without a call of the agent and without input of the user (key
  press, click, scroll) for 10 minutes closes.
- Each lane has its own Chromium. Its profile is in `.local_assets/lanes/<pid>-<lane id>/`, with
  the settings that stop the bubbles of Chrome (translate, password manager, autofill). The server
  deletes it when the lane closes.
- **Logins:** a new lane loads the storage state of the workspace,
  `.local_assets/storage-state-<workspace hash>.json` of this folder: cookies, localStorage and
  IndexedDB. At each page load of a lane (e.g. after your login), and when the lane closes, the
  server merges the state of the lane into the file. Thus a login reaches the other lanes and
  sessions. The file has the mode `0600`, and it never goes into a result, a log or the output
  folder.
- **Browser session:** sets the logins of a lane. Ask the agent for it, e.g. "open amazon.pl in
  a fresh session". "Session" in such a request means the browser session.

  | Browser session | Loads the saved logins | Saves its logins |
  | --- | --- | --- |
  | `normal` | yes | yes |
  | `fresh` | no | yes: it adds or changes entries, and removes no entry of the file |
  | `isolated` | no | no |

  `browser_lanes` shows the browser session of each lane.
- **IndexedDB:** some sites keep the login in IndexedDB, e.g. Firebase apps or WhatsApp Web. The
  server keeps it only for the hosts of `hosts.json`.

- **File names:** the `filename` of a tool must be in the output folder. A name without a folder
  goes there. An other path gives an error.
- **Headers:** the values of `Cookie`, `Set-Cookie`, `Authorization` and `Proxy-Authorization`
  become `***` in the results and in the output files.

## Render mode

Some sites block a headless browser. Thus the server never runs headless by default. `RENDER_MODE`
selects the mode:

| Value | Host with a display | WSL | Linux without a display |
| --- | --- | --- | --- |
| `DEFAULT` (not set) | `HEADED` | `HEADED_INVISIBLE` | `HEADED_INVISIBLE` |
| `HEADED` | a window | a window (WSLg) | `HEADED_INVISIBLE` |
| `HEADED_INVISIBLE` | Xvfb on Linux; else an error | Xvfb | Xvfb |
| `HEADLESS` | no window | no window | no window |

- `HEADED_INVISIBLE` runs a headed browser on Xvfb, a virtual display. Nobody sees the window.
- Only `HEADLESS` gives a headless browser. If a mode is not possible, the server stops with an
  error.
- The server ignores `PLAYWRIGHT_MCP_HEADLESS` and each other `PLAYWRIGHT_MCP_*` variable.
- `run.sh install` unpacks Xvfb into this folder on Linux. No root. The server starts Xvfb with
  Chromium on the first free display from `:99`, only on the abstract socket of Linux, and stops it
  with Chromium. After a SIGKILL of the server, the kernel stops Xvfb. The next start kills a
  leftover Xvfb.
- To solve a challenge of a site, use `HEADED` on a host with a display. The storage state keeps
  the cookies of the result. While you work in the window, the lane stays open.
- Chromium shows no permission prompt: it denies the request (`--deny-permission-prompts`).
- With `HEADED_INVISIBLE`, all lanes of a server use one Xvfb.

## Linux: libraries and fonts

Chromium needs system libraries (e.g. `libnss3`). `run.sh` finds the missing ones with `ldd`,
downloads their Ubuntu packages with `apt-get download` and unpacks them into
`.local_assets/syslibs/<platform>/`. This needs no root. If the host has no fonts, it also gets
fonts.

- To do it again, delete `.local_assets/syslibs/`.
- If a library has no package, `run.sh` stops with its name. Add it to `EXCEPTIONS` in
  [playwright/src/setup/syslibs.ts](playwright/src/setup/syslibs.ts).
- In CI (`CI=true`), `run.sh` installs the OS packages with `--with-deps`. CI runners have sudo.

## Arguments and defaults

The server takes only `--config-dir`. It ignores each `PLAYWRIGHT_MCP_*` variable and logs
`ignored`.

| Value | Default of the server |
| --- | --- |
| Render mode (`RENDER_MODE`) | `DEFAULT`: never headless |
| Browser files (`PLAYWRIGHT_BROWSERS_PATH`) | `.local_assets/browsers/<platform>/` |
| Storage state (`BROWSER_AUTOMATION_X_MCP_STORAGE_STATE`) | `.local_assets/storage-state-<workspace hash>.json` |
| Output files | `.local_assets/browser-automation-x-mcp/output/` of the working folder |
| Temp files (`TMPDIR`, `TEMP`, `TMP`) | `.local_assets/tmp/` |
| Browser registry (`XDG_CACHE_HOME`, Linux only) | `.local_assets/cache/` |

- The browser is always Chromium, installed by the launcher.
- A `PLAYWRIGHT_BROWSERS_PATH` of the user stays.
- Chromium makes a Unix socket in the temp folder. If the temp folder of this tool cannot hold it,
  the server uses `.local_assets/tmp/` of the first folder with `.git` above this tool (in a
  submodule: the submodule, e.g. `shared/`), else the temp folder of the OS. It logs
  `tmp_dir_fallback`.
- On Windows and macOS, Playwright writes a registry of the open browsers into the cache folder of
  the user. The server cannot move it.

## Logs

Each server start writes two files into `.local_assets/logs/<client>/` of this folder. `<client>` is
the client name from MCP `initialize`, e.g. `claude-code`. The file name is the start time and the
process ID: `mm-dd_hhmmss_<pid>`. The last 5 pairs of each client stay.

- `<name>.log`: one line for each event, a maximum of 160 characters. The line has the time, the
  event and its fields. URLs have no scheme. Long path segments and query values are cut.
- `<name>.log.json`: one JSON object for each event, with all fields, the level and the `session`
  (the process ID).

```
20:18:08 page_opened www.amazon.pl/ax/claim?arb=7a41…&openid.mode=chec… via=auto_submit
20:18:09 fields_written www.amazon.pl/ax/claim written=#ap_password=password,submit=#signInSubmit
```

| Env variable | Default | Effect |
| --- | --- | --- |
| `BROWSER_AUTOMATION_X_MCP_LOG_DIR` | `.local_assets/logs` | Folder of the log folders. |
| `BROWSER_AUTOMATION_X_MCP_LOG_LEVEL` | `info` | `error`, `info` or `debug`. `debug` adds the text of each result, only in `.log.json`. |
| `BROWSER_AUTOMATION_X_MCP_LOG_SECRETS` | unset | `1` logs the values of `text`, `value`, `values` and `password`. |

Events of the plugins: `plugins_loaded`, `source_error`, `classifier_error`, `match_error`,
`approval_error`, `page_script_error`; each event of a plugin has `plugin`, the instance name.
Events of the form fill: `fill_value` (field and plugin, no value), `fill_approved`,
`fill_refused`, `approval_refused`, `fill_filled`, `fill_submitted` (`how` and `classifier` of the
submit method), `fill_failed`, `fill_no_value`, `fill_no_field`, `fill_error`, `scrub_file`. Events
of the recorder: `fields_written`, `user_filled`, `user_pressed`, `user_submitted`,
`user_followed`. Other events:
`upstream_ready`, `client_ready`, `list_tools`, `tool_call`, `tool_result`, `tool_error`,
`browser_started`, `browser_stopped`, `lane_opened`, `lane_closed` (`reason`: `tool`, `idle` or the
shutdown), `lane_folder_removed`, `tab_limit`, `state_saved`, `state_save_failed`, `mask_file`,
`login_clicked`, `page_opened` (`via`:
`tool`, `auto_login`, `auto_submit` or `user_submit`), `host_blocked`, `host_recorded`, `tools_config_added`,
`ignored`, `shutdown`. The name of
an error event ends in `_error` or `_failed`.

- By default, the log has no typed text and no form values: `"<redacted 8 chars>"`. The log never
  has a value that a key-value-source gave.
- At level `debug`, the result text can contain values that are not masked.

```bash
tail -f "$(ls -t .local_assets/logs/*/*.log | head -1)"
```

## Tests

The code is TypeScript in strict mode. Node.js runs the `.ts` files directly (type stripping);
there is no build step.

`./run.sh test` runs the test phases in this order: `static`, `unit`, `functional`, `online`.
`./run.sh test unit` runs one phase. A failure does not stop the run. A passed test gives a short
summary; a failed test gives its full output ([tests/reporter.ts](tests/reporter.ts)). Only this
path installs the dev packages: TypeScript and ESLint. Each test uses a copy of the config in
`.local_assets/test-config/`, and its own storage-state file in `.local_assets/test-state/`. The
committed config and the real storage state stay unchanged. The test client opens a lane and gives
it in each call.

- [tests/static/](tests/static/): `tsc --noEmit` and ESLint (rule typed-code).
- [tests/unit/policy.test.ts](tests/unit/policy.test.ts): `server.json`, `hosts.json`, host access, tool
  switches, URL patterns, the plugin host (values, approvals, keys of a value, scrub), the discovery
  file, and the plugins (the vault through the test double in
  [tests/fixtures/fake-vault/](tests/fixtures/fake-vault/); `approve-https` against a local HTTPS server).
- [tests/functional/policy.test.ts](tests/functional/policy.test.ts): tool switches, host lists,
  `recordHosts`, form fill with the plugins (fill, submit, mask, loop guard, two steps, heuristic
  fields, several submits, host check after a submit, login link, approval), the recorder (keys of
  the values of the user, submit buttons, `enter`, login links, the marks of agent calls).
- [tests/functional/tools.test.ts](tests/functional/tools.test.ts): the same tools as upstream with
  the parameter `lane`, the texts for the client, navigation, errors, screenshots, the log and the
  storage state from one session to the next.
- [tests/functional/lanes.test.ts](tests/functional/lanes.test.ts): lanes in parallel, the limits,
  the lane errors, `browser_close`, logins between lanes, file names, header masks, the input of
  the user as activity, the deletion of old lane profiles.
- [tests/functional/forms.test.ts](tests/functional/forms.test.ts): form tools of the agent on local
  pages.
- [tests/online/online.test.ts](tests/online/online.test.ts): public sites. A test is
  skipped when its site is not reachable. Set `BROWSER_AUTOMATION_X_MCP_OFFLINE=1` to skip all of
  them.
- [tests/unit/server.test.ts](tests/unit/server.test.ts),
  [tests/functional/xvfb.test.ts](tests/functional/xvfb.test.ts): redaction, defaults, the library
  mapping, the storage-state merge, the masks, idle lanes, Xvfb, the start and stop of Chromium
  with the lanes.

## Update Playwright MCP

1. Change the version of `@playwright/mcp` in `package.json`.
2. Run `npm install` in this folder with the Node.js of `.local_assets/runtime/` to update
   `package-lock.json`.
3. Run `./run.sh test`. The launcher installs the new Chromium.
