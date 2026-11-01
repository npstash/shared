# Design — browser-tool-facades

The intended architecture. For the reasons, see [ADL.md](ADL.md). Values in uppercase are
defined in [SRS.md](SRS.md#default-values) and [QAS.md](QAS.md#default-values).

## 1. Overview

The tool holds facades for browser tools. Each facade has its own folder (`playwright/`). The
facades share the launcher, the runtime, the code in `src/`, the form-fill providers
(`providers-form-fill/`) and the config templates in `config/`. The config files are in a config
folder of the repository that uses the tool, e.g. `local/configs/browser-facade`. A second facade is an open issue
(section 11).

The Playwright facade is an MCP server on stdio between an MCP client (Claude Code, a wrapper with
the Agent SDK) and Playwright MCP. It forwards the browser tools, and it adds tool switches,
placeholders for form values and host lists. It runs without root and without OS installs.

## 2. Architectural drivers

- Functional requirements: [SRS.md](SRS.md)
- Quality attributes: [QAS-001](QAS.md#qas-001--portable-start-on-ubuntu) to [QAS-005](QAS.md#qas-005--overhead-of-the-facade)
- Constraints:
  - The tool lives in the `shared` container. It writes files only into its folder (rules
    nothing-outside-repo, per-project-runtimes).
  - Secrets come only from the vault tool `shared/tools/auth` (rule credentials-from-vault).
  - No OS package installs, no root.
  - The client starts the facade as a child process (stdio).

## 3. System context (C4 level 1)

System boundary: the tool folder `shared/tools/browser-tool-facades/`. The vault tool and
the vault home are near, but outside.

```mermaid
flowchart TD
    A[AI agent in an MCP client<br/><i>Claude Code, Agent SDK wrapper</i>] -->|MCP, stdio| S[Playwright facade<br/><i>this system</i>]
    U[User<br/><i>person</i>] -->|answers dialogs, MCP elicitation via the client| S
    U -->|edits config files| S
    S -->|HTTP/HTTPS, browser| W[Web sites<br/><i>external systems</i>]
    S -->|get system, get secret; CLI| V[Vault tool shared/tools/auth<br/><i>near, outside</i>]
    S -->|reads, writes| K[(Config folder<br/><i>--config-dir, outside</i>)]
    S -->|download Node.js; HTTPS| N[nodejs.org]
    S -->|download Chromium; HTTPS| P[Playwright CDN]
    S -->|apt-get download; HTTP| D[Ubuntu archive]
```

- **AI agent in an MCP client:** calls the browser tools; writes placeholders, never user data.
- **User:** configures the tool, edits the host list, answers the dialogs of the ask provider.
- **Web sites:** the pages that the agent opens.
- **Vault tool:** gives the secrets of the vault provider.
- **nodejs.org, Playwright CDN, Ubuntu archive:** the sources of the runtime, the browser and the
  missing Linux libraries.

## 4. Containers (C4 level 2)

```mermaid
flowchart TD
    C[MCP client] -->|MCP, stdio| F
    subgraph S[browser-tool-facades]
        L[Launcher<br/><i>run.sh / run.bat, playwright/src/setup/syslibs.js</i>] -->|starts: run.sh playwright --config-dir DIR| F[Playwright facade process<br/><i>Node.js, MCP SDK</i>]
        F -->|MCP, stdio| M[Playwright MCP<br/><i>Node.js child process</i>]
        M -->|CDP, pipe| B[Chromium<br/><i>downloaded browser</i>]
        F -->|appends| G[(Log<br/><i>JSON Lines</i>)]
        L -->|writes| R[(Runtime files<br/><i>.local_assets/</i>)]
    end
    F -->|CLI| V[Vault tool]
    F -->|reads, writes| K[(Config folder<br/><i>--config-dir</i>)]
```

- **Launcher:** one for all facades. It makes and updates the shared runtime: Node.js, npm
  packages, and for the Playwright facade Chromium and the missing Linux libraries and fonts.
  Then it starts the facade that its first argument names. stdout stays free for MCP.
- **Playwright facade process:** the MCP server for the client and the MCP client of Playwright
  MCP. It runs the call pipeline (section 5.1). An other facade is an other process of the same
  kind, with its own folder.
- **Playwright MCP:** `@playwright/mcp`, unchanged. It runs the browser tools.
- **Chromium:** the browser of Playwright, from the tool folder.
- **Xvfb:** the virtual display of a headed browser on Linux without a display. The facade
  starts and stops it. Unpacked into the tool folder.
- **Config folder:** outside the tool folder; `--config-dir` gives it (REQ-019 of SRS). Shared by
  all facades: `facade.ini`, `host-policy.ini`, `provider-<name>.ini`. For one facade:
  `<facade>-tools.ini`. A missing file is a copy of its template in the tool folder. The facade
  adds tool lines and records hosts.
- **Log:** `LOG_FILE`, gitignored.
- **Runtime files:** Node.js, browsers, libraries, profiles, output, temp files; gitignored.

## 5. Components (C4 level 3)

### 5.1 Playwright facade process

The components with a path in `src/` and `providers-form-fill/` are shared: each facade process
loads them. The components with a path in `playwright/` are for this facade only.

```mermaid
flowchart TD
    subgraph F[Facade process]
        SV[MCP server] --> P[Call pipeline<br/><i>playwright/src/facade.js</i>]
        P --> T[Tool switches<br/><i>src/tools-config.js</i>]
        P --> H[Host policy<br/><i>src/hosts/</i>]
        P --> R[Fill registry<br/><i>src/fill/registry.js</i>]
        R --> PV[Vault provider]
        R --> PI[INI provider]
        R --> PA[Ask provider]
        H --> AP[Allow provider<br/><i>file-allow-provider.js</i>]
        P --> CL[MCP client of upstream]
        P --> LG[Logger<br/><i>src/logger.js</i>]
        P --> XV[Xvfb starter<br/><i>playwright/src/xvfb.js</i>]
    end
    XV -->|starts, stops| X[Xvfb]
    CL -->|MCP, stdio| M[Playwright MCP]
    PA -->|elicitation/create| SV
    PV -->|CLI| V[Vault tool]
```

- **MCP server / MCP client:** the SDK objects for the two connections. The facade forwards
  roots, progress, cancellation and tool-list changes between them.
- **Call pipeline:** the steps of one call, in this order: tool switch → host check of the target
  URL → placeholders → upstream → scrub → host check of the opened page and record → log.
- **Tool switches:** `src/tools-config.js` with `playwright-tools.ini` and the dangerous
  tools of Playwright MCP; adds missing tools; gives the error of a disabled tool.
- **Host policy:** `[deny]` first, then the allow provider. Patterns: `src/hosts/patterns.js`.
- **Allow provider:** the default reads `[allow]` and records each opened host.
- **Fill registry:** loads the providers in the order of `facade.ini`, fills the placeholders in
  the arguments that the facade gives (for Playwright: `browser_type.text`,
  `browser_fill_form.fields[].value`, `browser_select_option.values[]`), scrubs the results and the
  text files that upstream wrote in the call, gives
  `fill_values_list`.
- **Vault, INI, ask providers:** `providers-form-fill/<name>/index.js` with `provider-<name>.ini`.
  The vault provider uses only the systems that `[systems]` names (REQ-034 of SRS).
- **Xvfb starter:** `playwright/src/xvfb.js`. `renderMode()` of `playwright/src/config.js`
  resolves `PLAYWRIGHT_RENDER_MODE` (REQ-015 of SRS). For `HEADED_INVISIBLE`, the facade starts
  Xvfb through `setpriv --pdeathsig KILL` before upstream, records it in XVFB_DIR and gives
  `DISPLAY` to upstream. At each start, it kills the Xvfb of facades that do not run (REQ-018).
- **Chrome settings:** `playwright/src/chrome-prefs.js` writes `CHROME_PREFS` into the persistent
  profile before the browser starts: at the first call, and after `browser_close`.
- **Logger:** JSON Lines; redacts the secret arguments.

### 5.2 Launcher

- **`run.sh` / `run.bat`:** steps 1–4: Node.js (checksum), npm packages (when
  `package-lock.json` changes), Chromium (for each Playwright version), Linux libraries.
- **`playwright/src/setup/syslibs.js`:** `ldd` → soname → package (Debian rule and an exception table) →
  `apt-get download` → `dpkg-deb -x`, in rounds; private apt lists if the system has none; fonts;
  Xvfb with the patched path of `xkbcomp` (REQ-017 of SRS).

## 6. Interfaces

### 6.1 Container interfaces

| Container | Operation | Description |
| --- | --- | --- |
| Facade process | MCP `initialize` | Gives the tools capability of upstream and the instructions for placeholders. |
| Facade process | MCP `tools/list` | The tools of upstream, then `fill_values_list`; notes for disabled tools and placeholders. |
| Facade process | MCP `tools/call` | The call pipeline (5.1). Error results: UI-02 of SRS. |
| Facade process | MCP `elicitation/create` (to the client) | The dialog of the ask provider (UI-01). |
| Facade process | arguments | `--config-dir DIR` (necessary; REQ-019 of SRS). Each other argument goes to Playwright MCP, e.g. `--isolated`. The facade removes `--headless`. |
| Facade process | environment | `PLAYWRIGHT_RENDER_MODE` (REQ-015 of SRS; the facade ignores `PLAYWRIGHT_MCP_HEADLESS`); `PLAYWRIGHT_FACADE_LOG_FILE`, `_LOG_LEVEL`, `_LOG_SECRETS`; `BROWSER_FACADES_VAULT_TOOL` (tests: a test double of the vault tool). |
| Launcher | `run.sh [install|test|args]` | Makes the runtime; `install` stops after it; `test` runs the tests. |
| Vault tool (used) | `run.sh --vault NAME get-system SYSTEM` / `get-secret SYSTEM KEY` | The secret names of one system; one secret on stdout. |

### 6.2 Component interfaces

| Component | Interface | Used by |
| --- | --- | --- |
| Fill provider | `list(ctx)`: placeholder names; `resolve(name, ctx)`: value, `undefined`, or a `FillError`; `dispose()`. `ctx = { host, url, tool, field, elicit }`. See `src/fill/provider.js`. | Fill registry |
| Allow provider | `isAllowed(host, ctx)`; `recordOpened(host, ctx)`. `ctx = { url, tool }`. See `src/hosts/allow-provider.js`. | Host policy |
| Host policy | `check(url, ctx)` → `{ allowed, reason }`; `opened(url, ctx)` | Call pipeline |
| Tool switches | `addMissing(names)`, `isEnabled(name)`, `describe(tool)`, `disabledResult(name)` | Call pipeline |
| Fill registry | `fill(tool, args, ctx)`, `scrub(result)`, `scrubFiles(files)`, `list(ctx)` | Call pipeline |

## 7. Key flows

Tool call with placeholders:

```mermaid
sequenceDiagram
    Agent->>Facade: tools/call browser_fill_form {value: "{{password}}"}
    Facade->>Facade: tool switch, host check
    Facade->>Vault provider: resolve("password", host)
    Vault provider->>Vault tool: get-secret "System" password
    Vault tool-->>Vault provider: secret
    Facade->>Playwright MCP: tools/call browser_fill_form {value: secret}
    Playwright MCP-->>Facade: result (may show the secret)
    Facade->>Facade: scrub of the result and the output files: secret → {{password}}
    Facade-->>Agent: result with {{password}}
```

A redirect to a denied host:

```mermaid
sequenceDiagram
    Agent->>Facade: tools/call browser_navigate allowed.example/redirect
    Facade->>Facade: check allowed.example: allowed
    Facade->>Playwright MCP: browser_navigate
    Playwright MCP-->>Facade: result, Page URL: denied.example/x
    Facade->>Facade: check denied.example: [deny]
    Facade->>Playwright MCP: browser_navigate about:blank
    Facade-->>Agent: error: page closed, reason
```

Dialog of the ask provider:

```mermaid
sequenceDiagram
    Agent->>Facade: tools/call browser_type {text: "{{phone}}"}
    Facade->>Client: elicitation/create (host, field)
    Client->>User: dialog
    User-->>Client: value, accept
    Client-->>Facade: {action: accept, content: {value}}
    Facade->>Playwright MCP: browser_type {text: value}
    Facade-->>Agent: result with {{phone}}
```

## 8. Data model

| File | Committed | Format | Written by |
| --- | --- | --- | --- |
| `<config>/facade.ini` | yes | `[fill] providers = vault, ini, ask`; `[hosts] record = true|false` | user |
| `<config>/playwright-tools.ini` | yes | `[tools]` `<tool> = enabled|disabled`, sorted | user; facade adds missing tools |
| `<config>/host-policy.ini` | yes | header comments; `[deny]`, `[allow]`: one host pattern per line, sorted, unique | user; facade records hosts |
| `<config>/provider-vault.ini` | yes | `[vault]` `vault = vault-<name>`; `[systems]` `<host or URL prefix> = <system name>` | user |
| `<config>/provider-ini.ini` | yes | `[all]` and `[<host pattern>]` with `key = value` | user |
| `<config>/provider-ask.ini` | yes | `[ask]` `fields = a, b, c` | user |
| `config/*.template.ini`, `<facade>/config/tools.template.ini`, `providers-form-fill/<name>/config.template.ini` | yes | the first content of each file above | user; facade copies a template to a missing file |
| `LOG_FILE` | no | JSON Lines: `ts`, `level`, `session`, `event`, fields of the event | facade |
| `.local_assets/` | no | runtime, browsers, `syslibs/<platform>/root` (also Xvfb), `xvfb/<display>.json` (PID and start time of facade and Xvfb), profiles, output, tmp | launcher, Playwright |
| `<repo>/.local_assets/tmp/` | no | temp files of Chromium when the tool folder cannot hold its socket | Playwright |

Host patterns: `*` (each host), `*.example.com` (subdomains only), `example.com` (exact),
`192.168.1.*` (IPv4 octets). Host only, no case. A URL without a host passes.

`<config>` is the config folder that `--config-dir` gives, e.g. `local/configs/browser-facade` of the
repository.

Placeholders: `{{<name>}}`, the name is a letter, then letters, digits, `_`, `.`, `-`. No case.

## 9. Deployment

- Deployment and configuration: [README.md](../README.md), [playwright/README.md](../playwright/README.md),
  client setup: [playwright/docs/clients.md](../playwright/docs/clients.md).

| Dependency | Container | Use |
| --- | --- | --- |
| Node.js NODE_VERSION (downloaded) | Launcher, facade, Playwright MCP | Runtime |
| `@playwright/mcp` 0.0.83 | Playwright MCP | Browser tools |
| `@modelcontextprotocol/sdk` 1.32.2 | Facade process | MCP server and client |
| Chromium (downloaded) | Chromium | Browser |
| `ldd`, `apt-get`, `apt-cache`, `dpkg-deb` (Ubuntu base) | Launcher | Missing libraries, no root |
| `curl`, `tar`, `sha256sum` / `certutil` | Launcher | Download of Node.js |
| Vault tool `shared/tools/auth` | Vault provider | Secrets |

Manual test: see [playwright/README.md](../playwright/README.md#tests), and run `claude -p` with
`--mcp-config` as [playwright/docs/clients.md](../playwright/docs/clients.md) says.

## 10. Architecture decisions

All decisions are in [ADL.md](ADL.md).

- [ADR-20261028-facade_folders](adr/ADR-20261028-facade_folders.md): one folder for each facade, shared
  providers and config.

## 11. Open issues

- A second facade, for the browser that Claude opens in a chat of the Claude desktop app.
- Composite tools that combine Playwright tools, e.g. `fill_form_by_labels`.
- A pop-up allow provider (MCP elicitation) for hosts that are not in `[allow]`.
- A network fill provider.
- Proof of QAS-001 in clean Ubuntu 22.04 and 24.04 containers, with instructions (B3).
- CJK fonts (`fonts-noto-cjk`, 58 MB) for screenshots of Chinese, Japanese and Korean text.
- `libgssapi-krb5-2` for Kerberos sign-on on hosts without it (lazy-loaded by Chromium).
- In `claude -p` (no UI), Claude Code cancels each dialog of the ask provider. The call stops.

## 12. Default values

See [SRS.md](SRS.md#default-values) and [QAS.md](QAS.md#default-values).
