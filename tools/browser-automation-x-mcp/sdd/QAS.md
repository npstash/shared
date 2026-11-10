# Quality Attribute Scenarios — browser-automation-x-mcp

Quality attribute scenarios in the ADD (SEI) format. The containers and components are in
[DESIGN.md](DESIGN.md).

---

## QAS-001 — Portable start on Ubuntu

- **Quality attribute:** Portability
- **Source of stimulus:** A user without root
- **Stimulus:** Runs `run.sh install`, then `run.sh test`
- **Environment:** Ubuntu 22.04 or 24.04 (desktop, WSL, server, minimal image, GitHub runner), no
  Chromium libraries, no fonts, maybe no apt package lists
- **Artifact:** Launcher, `playwright/src/setup/syslibs.ts`
- **Response:** The launcher gets Node.js, Chromium, the missing libraries and fonts into the tool
  folder. The tests pass.
- **Response measure:** 0 OS packages installed, 0 files written outside the repository and the
  temp folder of the OS, 0 test failures
- **Related ADR:** —
- **Verification (test):** `run.sh test` on WSL (done) and on GitHub runners (CI). MISSING: clean
  container test for Ubuntu 22.04 and 24.04 (open item B3).

## QAS-002 — No masked value reaches the client

- **Quality attribute:** Security (confidentiality)
- **Source of stimulus:** The agent
- **Stimulus:** Opens a page that `fields.ini` matches, then reads the page (snapshot, evaluate)
- **Environment:** Normal operation
- **Artifact:** Server process: form fill, fill registry, logger
- **Response:** The server fills and submits the form, and replaces each masked value with MASK in
  each result and log line.
- **Response measure:** 0 occurrences of a masked value in the results and the log
- **Related ADR:** —
- **Verification (test):** `tests/functional/policy.test.ts`, "the server fills and submits; the client
  sees the page after the submit and *** for masked values"

## QAS-003 — A denied host does not stay open

- **Quality attribute:** Security (integrity)
- **Source of stimulus:** A web page or the agent
- **Stimulus:** A navigation, redirect or click to a host in `[deny]`
- **Environment:** Normal operation
- **Artifact:** Server process: host policy
- **Response:** The server does not open the page, or it opens `about:blank` after the call.
- **Response measure:** The browser shows `about:blank` after the call, in 100 % of the cases;
  no further tool call runs on the denied page
- **Related ADR:** —
- **Verification (test):** `tests/functional/policy.test.ts`, "host lists"

## QAS-004 — A disabled tool does not run

- **Quality attribute:** Security (prompt injection)
- **Source of stimulus:** The agent, maybe misled by a web page
- **Stimulus:** Calls a tool that `tools.ini` disables
- **Environment:** Normal operation
- **Artifact:** Server process: tool switches
- **Response:** The server gives an error result with the reason.
- **Response measure:** 0 forwarded calls of disabled tools
- **Related ADR:** —
- **Verification (test):** `tests/functional/policy.test.ts`, "tool switches"

## QAS-005 — Overhead of the server

- **Quality attribute:** Performance
- **Source of stimulus:** The agent
- **Stimulus:** Calls a tool on a page that `fields.ini` does not match
- **Environment:** Normal operation, one client
- **Artifact:** Server process
- **Response:** The server forwards the call and the result.
- **Response measure:** Added time per call < SERVER_OVERHEAD_MAX
- **Related ADR:** —
- **Verification (test):** MISSING: a measure of the time with and without the server (Playwright MCP alone)

---

## Scenario register

| ID | Attribute | Measure | ADR | Test |
| :-: | :-: | :-: | :-: | :-: |
| QAS-001 | Portability | 0 OS installs, 0 failures | — | `run.sh test`; MISSING: clean containers |
| QAS-002 | Security | 0 masked values visible | — | `tests/functional/policy.test.ts` |
| QAS-003 | Security | about:blank after a denied page | — | `tests/functional/policy.test.ts` |
| QAS-004 | Security | 0 forwarded disabled calls | — | `tests/functional/policy.test.ts` |
| QAS-005 | Performance | < SERVER_OVERHEAD_MAX | — | MISSING |

## Default values

| Name | Default | Unit | Configuration key | Meaning |
| --- | --- | --- | --- | --- |
| SERVER_OVERHEAD_MAX | 50 | ms | — | Maximum time that the server adds to one call |
