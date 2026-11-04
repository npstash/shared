# ADR-20261104-browser_lanes — Browser lanes: parallel agents and sessions with shared logins

- ADL entry: `20261104-01` in [ADL.md](../ADL.md)
- Name: Nestor
- Commit: 598b2ac53d38
- Status: Accepted

## Context

Each MCP client starts its own server process. Each server process starts Playwright MCP as a
child process ([ADL 20261024-04](../ADL.md)). The child process opens Chromium with one
persistent profile for each workspace ([ADL 20261024-08](../ADL.md)).

These problems occur:

- Chromium lets only one process use a profile folder. When one session has the browser open,
  the browser of an other session fails with `Browser is already in use`. Thus only one session
  in a workspace can use the browser at a time.
- Claude Code and Codex use `RENDER_MODE=DEFAULT`, thus `HEADED_INVISIBLE` on WSL. Kilo uses
  `HEADED`. When a Claude Code session holds the profile, Kilo cannot open a visible window.
- Subagents use the connection of their parent session. All Kilo chats of one Kilo instance use
  one connection. Playwright MCP has one current tab for each connection, and tabs have an
  index that changes when a tab closes. Thus two agents that work in parallel change the tab
  of each other.
- An MCP call does not identify the agent that makes it.

## Options and evaluation

| Option | Evaluation |
| --- | --- |
| a) One tab for each agent in one browser context | Logins are shared live. The server must select the tab before each call, and run all calls one after the other. Popups and the changed indexes make the mapping of tabs fragile. |
| b) One browser context for each agent (lane), loaded from a shared storage-state file | The lanes run in parallel, each with its own tabs and current tab. One Chromium process for all lanes. Logins are shared through the file, not live. |
| c) One shared browser for all sessions, connected with `--cdp-endpoint` | Logins are shared live. All sessions get one render mode and see the same tabs. A process must own the life of the browser. |
| d) A copy of the profile for each session | Full profile in each session. Each start copies a large folder, and the logins of the copies differ. |

For the upstream process:

| Option | Evaluation |
| --- | --- |
| a) Playwright MCP in the server process, with `createConnection(config, contextGetter)` | No network port. A crash of Playwright stops the server. |
| b) One upstream child process in HTTP mode, one HTTP client for each lane | A process boundary stays. Each local process can connect to the port and use the logins. |

## Decision

Option b, with upstream option a.

- **Lane:** one browser context for one agent. All lanes of a server process use one Chromium.
  The render mode applies to that Chromium. Thus each session has its own render mode. Chromium
  (and Xvfb) starts with the first lane and stops after the last lane.
- **Upstream:** the server launches Chromium. For each lane, it calls `createConnection()` of
  `@playwright/mcp` with a context getter that gives a new context. The server connects to it
  through an in-memory transport. There is no upstream child process and no port.
- **Arguments:** the server takes only `--config-dir`. An other argument stops the server with an
  error. The server ignores each `PLAYWRIGHT_MCP_*` variable and logs it. The variable
  `BROWSER_AUTOMATION_X_MCP_STORAGE_STATE` gives an other storage-state file, for the tests.
- **Tools:** `browser_lane_open` gives a new lane ID, e.g. `lane-3f9a`. The ID is random, so an
  ID that the server reclaimed is not used again by mistake. `browser_lane_close` closes a lane.
  `browser_lanes` gives the number of open lanes, `MAX_LANES`, and the idle time of each lane.
  `browser_close` closes the lane, like `browser_lane_close`.
- **Lane parameter:** each other tool requires the parameter `lane`. A call without a known lane
  fails with a neutral error.
- **Limits:**
  - `MAX_LANES` (3) for each server process. When all lanes are in use, `browser_lane_open`
    fails at once with "busy". The agent calls `browser_lanes` again later.
  - `MAX_TABS_PER_LANE` (5). `browser_tabs action=new` fails at the limit. A popup that is over
    the limit closes at once, and the result tells it.
  - `LANE_IDLE` (10 min). The server closes a lane after this time without a call.
- **Logins:** one storage-state file for each workspace, in `.local_assets/` of the tool, with
  the mode `0600`. A new lane loads it. The server saves the state of a lane when the lane
  closes, when the server reclaims an idle lane, and at shutdown.
  - It merges the state into the file: cookies by name, domain and path, and localStorage by
    origin. The newer entry wins.
  - It keeps IndexedDB only for the origins in `[storage] indexeddb` of `server.ini`, e.g.
    `indexeddb = web.whatsapp.com, myapp.firebaseapp.com`. It removes the IndexedDB of each
    other origin before it merges. The merge takes the IndexedDB of one origin as one entry.
  - It writes a temp file, then renames it.
  - The file never goes into a result, a log or the output folder.
- **Chrome settings:** Chromium starts with `--deny-permission-prompts`. The server writes no
  `Default/Preferences`. A policy file is not possible: Chromium reads policies only from system
  folders, which need root. `launch()` makes its own temp profile and does not accept
  `--user-data-dir`. A test on Xvfb showed no password bubble and no address bubble in a lane.
  Each lane starts with an empty profile: no "restore pages" bubble. The default switches of
  Playwright stop the translate bar.

These earlier decisions change:

- [ADL 20261024-04](../ADL.md) and [ADL 20261025-06](../ADL.md): the server stays an MCP stdio
  server for the client. Upstream runs in the server process, not as a child process.
- [ADL 20261024-08](../ADL.md): no persistent profile. The storage-state file keeps the logins.
- [ADL 20261024-12](../ADL.md): at shutdown, the server saves the storage state of each lane.
- [ADL 20261101-02](../ADL.md): `--deny-permission-prompts` replaces `Default/Preferences`.
- [ADL 20261101-08](../ADL.md), [ADL 20261103-03](../ADL.md): `--headless` and `--browser` stop
  the server, as each other argument.

## Consequences

- Up to `MAX_LANES` (3) agents of one session, and any number of sessions, use the browser at
  the same time. Kilo can show a window while a Claude Code session runs on Xvfb.
- An agent must first call `browser_lane_open`, and then give `lane` in each call. The server
  instructions tell it. A model that forgets the lane gets an error.
- A login reaches an other lane or session only after a save of the state. Two sessions that
  log in to the same site at the same time can lose one login.
- The storage state keeps cookies, localStorage and the IndexedDB of the listed origins. The
  history, the IndexedDB of other origins, saved passwords and the cache are lost when a lane
  closes. A site that keeps its login in IndexedDB asks for the login in each new lane, until
  its origin is in `[storage] indexeddb`.
- An agent that stops without `browser_lane_close` holds a lane for `LANE_IDLE` (10 min).
- The form fill and the discovery work for each lane. The scrub and the host checks apply to
  each lane. `browser_run_code_unsafe` for the form fill ([ADL 20261101-40](../ADL.md)) runs in
  the lane of the call.
- A crash of Chromium or Playwright stops all lanes of the server process.
- The server uses `createConnection()`. An update of `@playwright/mcp` can change this API.
  The tests must cover it.
- SRS, DESIGN and README get the lanes, the tools, the limits and the storage-state file. The
  tests get lanes in parallel, the limits, the idle reclaim and the merge of the state.
