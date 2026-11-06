# browser-automation-x-mcp

An MCP server for browser automation. It gives the agent the browser tools, and adds lanes, tool
switches, a form fill, host lists and a log. A lane is an own browser context for one agent:
agents and sessions use the browser in parallel (see [Lanes](#lanes)).

The internals are hidden from the agents. An agent sees the MCP server `browser-automation-x-mcp`
and the browser tools. No text for the agent names Playwright, the form fill or its providers.
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
package.json                  Node.js packages
config/                       templates of the config files
providers-form-fill/<type>/   form-fill providers: index.js
src/                          server.json, sites.json, logger, host check, fill registry
tests/                        tests of src/ and of the providers
playwright/                   the server: src/, tests/
sdd/                          documents of the tool
```

## Run

```bash
./run.sh install                           # make the runtime, install the browser, then stop
./run.sh --config-dir <DIR>                # start the server (MCP server on stdio)
./run.sh test                              # run the tests
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

`--config-dir` gives the config folder, e.g. `local/configs/browser-automation-x-mcp`. It holds two
JSON files. A missing file is first a copy of its template in `config/` of this folder.

**`server.json`**: how the server works.

```json
{
  "providers": [
    { "type": "vault",  "enabled": true, "mask": true,  "vault": "vault-main",
      "approval": { "type": "approve-https", "address": "https://127.0.0.1:8743", "fingerprint": "AB:CD:..." } },
    { "type": "values", "enabled": true, "mask": false, "values": { "name": "Anna Nowak" } },
    { "type": "ask",    "enabled": true, "mask": true,  "fields": ["phone"] }
  ],
  "tools": {
    "browser_click":           { "enabled": true },
    "browser_run_code_unsafe": { "enabled": false }
  }
}
```

- `providers`: the form-fill providers, in the order that the server asks them. `"enabled": false`
  turns one off. `"mask"`: see [Form fill](#form-fill); without it, the provider is masked. The
  other keys are the settings of the provider. `"approval"` attaches an approval provider to a
  key-value provider. See [Providers](#providers).
- `tools`: the tool switches (see [Tool switches](#tool-switches)). The server adds missing tools.

**`sites.json`**: what the server knows about sites. Only the discovery mode writes it (see
[Discovery](#find-the-fields-of-a-page-discovery)).

```json
{
  "defaultAccess": "allow",
  "sites": {
    "amazon.pl": {
      "access": "allow",
      "provider-config": { "vault": { "vault": "vault-main", "entry": "Amazon - Nestor" } },
      "subdomains": {
        "www.amazon.pl": {
          "pages": {
            "/":          { "login": ["internal:role=link[name=\"zaloguj się\"i]"] },
            "/ap/signin": { "fields": { "input[name=\"email\"]": "username", "#ap_password": "password" },
                            "submit": ["#continue", "#signInSubmit"] }
          }
        }
      }
    },
    "premium.pl": { "subdomains": { "sklep.premium.pl": { "access": "deny" } } }
  }
}
```

- A key of `sites` is a root domain, e.g. `amazon.pl`, not `www.amazon.pl`. The Public Suffix List
  gives the root domain: `amazon.co.uk`, `user.github.io`. An IP address and `localhost` stay.
- `subdomains`: the nodes of the subdomains, with the same keys as a site. A key is the full host
  name. A deeper host can be the child of a subdomain.
- `access` and `provider-config` go down the tree: a subdomain without them gets them from the
  nearest parent. The nearest value wins. For `provider-config`, this applies to each provider type
  separately. `access`: see [Host access](#host-access).
- `provider-config`: the config of a provider for the site, by the provider type. `"vault"` needs
  `"vault"` (the vault of the vault provider in `server.json`) and `"entry"` (the vault system). A
  page can have its own `provider-config`. It wins over the host, only for that page.
- `pages`: only for the host of their node, not for its subdomains. The key is a path pattern. `*`
  matches each sequence of characters, also `/`. `/*` matches each path. See [Form fill](#form-fill).
- A site key that is not a root domain, a `subdomains` key outside its parent, `credentials`, or a
  `"vault"` config without `vault` or `entry` is a load error.

## Form fill

The agent never fills credentials or personal data. After each call, the server checks the page.
If a page of `sites.json` matches the URL, the server fills the fields and submits the form. The
agent gets the page after the submit. It does not know about the fill.

- **Fields:** `"fields": { "<selector>": "<key>" }`. The key is the key of a provider value, e.g.
  `password`. A selector is CSS, or a label or role locator of Playwright, e.g.
  `internal:label="Password"s`. The server looks for the selector in each frame of the page. If more
  pages of the host match, all apply. For a selector in more pages, the more specific page (the
  longer path) wins.
- **Wait:** the server waits a maximum of 10 s for a visible field. It waits only one time for each
  URL, and after each submit.
- **Values:** for each key of the visible fields, the server asks the providers of `server.json`, in
  their order. The first provider with the key gives the value. A field without a value stays
  empty. If no field has a value, the server does nothing.
- **Submit:** `"submit": [...]`. The server uses the first entry that applies: a visible element (it
  clicks it), or `"enter"` (it presses Enter in the last field). The more specific page comes first.
  Without such an entry, it calls `requestSubmit()` of the form, else it presses Enter. Then
  it waits a maximum of 10 s for the page. A second step, e.g. the password after the username, gets
  a fill in the same call. Maximum 3 rounds.
- **Login link:** `"login": [...]` gives the sign-in links of a page, e.g. on the start page of a
  shop. Before the fill, the server clicks the first visible one, then fills the login page. It
  clicks one time for each lane and host, and only for a page that has a vault config. Use a
  locator with the text that shows only before the login, e.g.
  `internal:role=link[name="zaloguj się"i]`. After the login the text changes, and the server does
  not click.
- **Host check:** each page after a submit gets the host check before the next fill (see
  [Host access](#host-access)).
- **Loop guard:** the server fills each set of visible fields of a form one time. If the same fields
  come back, e.g. after a wrong password, it does not fill them again. The log gets `fill_failed`.
  The guard is reset when a page does not match `sites.json`.
- **Mask:** `"mask": true` (the default) replaces the values of the provider with `***` in each
  result and in each text file of the output folder. Binary files, e.g. screenshots, stay unchanged.
- **Errors:** a provider error or a page error goes only to the log. The agent gets the page as it
  is.

### Providers

| Provider | Kind | Settings in `server.json` | Values |
| --- | --- | --- | --- |
| vault | key-value | `"vault": "vault-<name>"` | The secret of the vault system of the page: `entry` of the nearest `provider-config.vault` in `sites.json`, if its `vault` is the vault of the provider. The key is the secret name, e.g. `password`. |
| values | key-value | `"values": { "<key>": "<value>" }` | Values that are not secret. |
| ask | value | `"fields": ["phone", ...]` | A dialog of the client for the listed keys. Only clients with MCP elicitation. In `claude -p`, Claude Code cancels the dialog. Do not list passwords: the MCP specification does not allow this dialog for sensitive data. |
| approve-dialog | approval | none | The values of its key-value provider, after the user approves in a dialog of the client. |
| approve-https | approval | `"address": "https://<host>:<port>"`, `"fingerprint": "<SHA-256>"` | The values of its key-value provider, after an approval service approves. |

- **Key-value:** has keys and values. In the discovery mode, it gives the key of a value that the user
  filled.
- **Value:** gives a value for a key. The discovery mode does not use it.
- **Approval:** goes into `"approval"` of a key-value provider entry, e.g.
  `"approval": { "type": "approve-dialog" }`. The mask of that entry applies. `"enabled": false` in
  `"approval"` turns the approval off. An approval provider in the list of `providers` is a load
  error. Before a fill, the provider asks for one
  approval for all its keys of the form. The request has the host, the keys and the client name; no
  value and no URL. A refusal, or no answer in 15 s, stops the fill. No later provider gives the keys.
  The result of the call gets the note "The user did not approve an action on this page."
  The discovery mode uses the key-value provider without an approval.
- **approve-https:** sends `POST <address>/approve` with `{ "host", "keys", "client" }`, and expects
  `{ "approved": true }`. It pins the certificate of the service with `fingerprint` (SHA-256; case and
  `:` have no effect), and sends nothing to an other certificate. An empty `address` or `fingerprint`
  refuses each fill. A service that approves each request is in `projects/other/approve-provider-service`
  of the workspace.

To add a provider, see [src/fill/provider.js](src/fill/provider.js).

### Find the fields of a page (discovery)

Start the server with `BROWSER_AUTOMATION_X_MCP_DISCOVER=1`, e.g. in the `env` of `.mcp.json`. The
server writes into `sites.json` at once. No call of the agent is necessary.

- **Hosts:** for each loaded page of an allowed host, its root domain goes into `sites.json` with
  `"access": "allow"`, e.g. `amazon.pl` for `www.amazon.pl`. An access that the file has stays.
- **Pages:** the pages go into the node of their host. A missing subdomain node goes into
  `subdomains` of the nearest node that covers the host.
- **Fields:** at a click of a button or a submit, the server gets the values of the fields that the
  user filled. It asks the key-value providers for the key of each value, in their order, and writes
  `"<selector>": "<key>"`. Then it discards the values. It never logs or writes a value. A field
  without a key gets a name from its attributes (`username`, `password`, `email`, `otp`, else its
  `name`), but only if the selector has no key yet. A later value provider, e.g. `ask`, can fill it.
- **Submit:** the button that the user clicks goes into `submit`. For a submit with Enter, the submit
  button of the form goes into `submit`; without such a button, `"enter"`.
- **Login link:** the last link that the user followed before a submit goes into `login` of the page
  of the link.
- **Fill:** the key-value providers fill the known fields, without an approval. Value providers do not fill. The server does not submit.
- Only the fields of the user go into the file. The fills of the agent and of the form fill do not.
- The log gets each record at once, without values: `user_filled`, `user_pressed`, `user_submitted`,
  `user_followed` and the same for `agent`, each with the time of the event (`at`). It gets
  `fields_written` for each change of `sites.json`.
- Before each write, the server reads `sites.json` again. Your changes stay.
- Selector of a field: autocomplete, name, an id that does not look generated, the type, aria-label,
  placeholder; else `internal:label="<label>"s`. Selector of a button: id, name, type; else
  `internal:role=button[name="<text>"s]`. A selector must find one element.

1. Open the login page of a site in a lane. The server writes the root domain.
2. Add `"provider-config": { "vault": { "vault": "<vault>", "entry": "<system>" } }` to the root
   domain in `sites.json`, and save the file. Do this before the submit: without it, the vault
   provider has no keys for the site.
3. Do each step of the login in the browser.
4. Remove `BROWSER_AUTOMATION_X_MCP_DISCOVER`.

## Host access

`sites.json` decides which hosts open:

- A node with `"access": "deny"` blocks its host and its subdomains. A deny wins also over an
  `"allow"` of a subdomain below it.
- Else the nearest node with an `access` decides: the node of the host, else its parents.
- Else `defaultAccess` decides (`"allow"` or `"deny"`).
- The server checks the URL before it opens a page, and the page after each call (clicks,
  redirects, submits). A blocked page is replaced by `about:blank`, and the call fails.
- Only the discovery mode writes `sites.json`: it records the opened hosts.

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
  server keeps it only for the sites of `sites.json`.

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
  [playwright/src/setup/syslibs.js](playwright/src/setup/syslibs.js).
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

Events of the form fill: `fill_providers`, `fill_value` (field and provider, no value),
`fill_approved`, `fill_refused`, `approval_refused`, `fill_filled`, `fill_submitted`, `fill_failed`,
`fill_no_value`, `fill_error`, `scrub_file`. Events of the discovery: `fields_written`,
`user_filled`, `user_pressed`, `user_submitted`, `user_followed`, `agent_filled`, `agent_pressed`,
`agent_submitted`, `agent_followed`, `discovery_error`, `discovery_match_error`. Other events:
`upstream_ready`, `client_ready`, `list_tools`, `tool_call`, `tool_result`, `tool_error`,
`browser_started`, `browser_stopped`, `lane_opened`, `lane_closed` (`reason`: `tool`, `idle` or the
shutdown), `lane_folder_removed`, `tab_limit`, `state_saved`, `state_save_failed`, `mask_file`,
`login_clicked`, `page_opened` (`via`:
`tool`, `auto_login`, `auto_submit` or `user_submit`), `host_blocked`, `host_recorded`, `tools_config_added`,
`ignored`, `shutdown`. The name of
an error event ends in `_error` or `_failed`.

- By default, the log has no typed text and no form values: `"<redacted 8 chars>"`. The log never
  has a value that a provider gave.
- At level `debug`, the result text can contain values that are not masked.

```bash
tail -f "$(ls -t .local_assets/logs/*/*.log | head -1)"
```

## Tests

`./run.sh test` runs the tests with `node --test`. Each test uses a copy of the config in
`.local_assets/test-config/`, and its own storage-state file in `.local_assets/test-state/`. The
committed config and the real storage state stay unchanged. The test client opens a lane and gives
it in each call.

- [tests/policy-unit.test.js](tests/policy-unit.test.js): `server.json`, `sites.json`, host access, tool
  switches, URL patterns, the fill registry, the provider kinds, matching and approvals, and the
  providers (the vault through the test double in [tests/fixtures/fake-vault/](tests/fixtures/fake-vault/);
  `approve-https` against a local HTTPS server).
- [playwright/tests/policy.test.js](playwright/tests/policy.test.js): tool switches, host lists,
  form fill (fill, submit, mask, loop guard, two steps, label locators, several submits, host
  check after a submit, login link, approval), discovery (hosts, keys of the values of the user,
  submit buttons, `enter`, login links, fill without a submit).
- [playwright/tests/tools.test.js](playwright/tests/tools.test.js): the same tools as upstream with
  the parameter `lane`, the texts for the client, navigation, errors, screenshots, the log and the
  storage state from one session to the next.
- [playwright/tests/lanes.test.js](playwright/tests/lanes.test.js): lanes in parallel, the limits,
  the lane errors, `browser_close`, logins between lanes, file names, header masks, the input of
  the user as activity, the deletion of old lane profiles.
- [playwright/tests/forms.test.js](playwright/tests/forms.test.js): form tools of the agent on local
  pages.
- [playwright/tests/online.test.js](playwright/tests/online.test.js): public sites. A test is
  skipped when its site is not reachable. Set `BROWSER_AUTOMATION_X_MCP_OFFLINE=1` to skip all of
  them.
- [playwright/tests/unit.test.js](playwright/tests/unit.test.js),
  [playwright/tests/xvfb.test.js](playwright/tests/xvfb.test.js): redaction, defaults, the library
  mapping, the storage-state merge, the masks, idle lanes, Xvfb, the start and stop of Chromium
  with the lanes.

## Update Playwright MCP

1. Change the version of `@playwright/mcp` in `package.json`.
2. Run `npm install` in this folder with the Node.js of `.local_assets/runtime/` to update
   `package-lock.json`.
3. Run `./run.sh test`. The launcher installs the new Chromium.
