# ADR-20261108-plugin_architecture — Plugins in place of form-fill providers

- ADL entry: `20261108-01` to `20261108-17` in [ADL.md](../ADL.md)
- Name: Nestor
- Commit: 43f592f2878e
- Status: Accepted

## Context

The form fill uses providers in `providers-form-fill/`
([ADR-20261106-provider_kinds_and_matching](ADR-20261106-provider_kinds_and_matching.md)). The
term "provider" does not fit each kind: an approval provider gives no value.

The discovery is server code: the recorder (`playwright/src/page-lib.js`), the writer of
`sites.json` (`playwright/src/discover.js`) and the discovery mode (`DISCOVER`). The forms and the
login links of the fill come from `sites.json`. Thus the server cannot run without the discovery
code, and other methods of field detection cannot be added.

`sites.json` holds the host access, the provider config of the vault and the forms. The code is
JavaScript without types.

Fathom (Mozilla) classifies elements of the live DOM in the page. Firefox uses Fathom in production
only for new-password, sign-up and credit card fields. The login ruleset of Fathom is a proof of
concept.

## Decision

### Terms and folders

- A plugin is one implementation, e.g. `vault`. A plugin category is one API. A plugin instance is
  one entry in `server.json` with its config.
- The plugins are in `plugins/<category>/<plugin>/`. Shared plugin code is in
  `plugins/common/<plugin>/`. `common/` is not a category.
- The term "provider" is removed.

### Categories

- **key-value-source:** has keys and values for a page. The server uses each enabled instance.
  The first instance in `server.json` order that has a key gives the value.
- **approval-plugin:** is attached to one key-value-source instance. It approves the fill of the
  keys of that instance.
- **dom-classifier:** runs as a page script against the live DOM. It gives the fields (each with a
  short hint, e.g. `password`; a hint is not a key), the login links, and the submit method for the fields that it
  serves. The server merges the results of all enabled instances; on a conflict, the first instance
  wins. Selectors that only Playwright can resolve are not used.
- **match-strategy:** gives the key of each field from its hint. The server uses the enabled instances in order;
  each instance gets only the fields that are not matched yet.
- **page-script:** injects a script into each frame, with Node code beside it.
- The value-source category is removed, and with it the `ask` provider.
- No auto-submitter category: the server runs the submit method that a dom-classifier gives. If no
  dom-classifier gives one, the server fills and does not submit.

### Isolation and server APIs

- Plugins run in the server process. They get only JSON data and the services that the server gives
  explicitly. They get no server objects and no Playwright objects.
- The services are a logger for each plugin, and the MCP elicitation for approval plugins only.
- The server gives page scripts a message channel to the Node code of their plugin, and an API that
  gives the keys of a value from the key-value-sources. The server adds the value to the mask set.
  The Node code of a plugin gets only the keys.
- Page scripts are trusted as reviewed local code. They can read field values in the page.
- The server marks each element that the form fill touches, and each element of an agent tool call
  with a `ref`. Page scripts read the mark.
- Plugins can keep state. A plugin reads and writes its own files; the path is a field of its config.

### Discovery

- The discovery is two plugins: `plugins/dom-classifier/discovery/` reads the discovery file, and
  `plugins/page-script/discovery/` records the actions of the user and writes the file. The file
  format is in `plugins/common/discovery/`.
- The discovery file keeps the tree of root domains and subdomains, with `forms` and `login`. Fields
  are CSS selectors. Login links and submit buttons are a matcher `{ css, text }`.
- The discovery mode and `DISCOVER` are removed. The server knows no learning mode. The enabled
  plugins give the behaviour.
- The submit detection and the field names of the discovery become a heuristic dom-classifier.
  Fathom is an optional second dom-classifier.
- The server clicks a login link only if a key-value-source instance has keys for the page.

### Config

- `server.json` has `plugins`: an object with one array of instances for each category. The array
  order is the order of use.
- An instance has `name` (unique), `plugin`, `description`, `enabled` and `config`. A
  key-value-source also has `mask` and an optional `approval` with `plugin`, `enabled` and `config`.
- The vault system of each site is in the config file of the vault instance: a tree of root domains
  and subdomains; the nearest node wins. One instance is one vault.
- `sites.json` becomes `hosts.json`. It holds only `defaultAccess` and the tree with `access` and
  `subdomains`. The server records opened hosts in it, as before (REQ-042).
- The local config is converted by hand. The tool has no migration code.

### Code

- The tool is TypeScript in strict mode. Node runs the `.ts` files with type stripping; there is no
  build step.
- Each component of DESIGN section 5.1 has an interface and a class. The constructors get the
  dependencies. One composition root builds the objects. No mutable state is at module level.
- The tests run in phases: static analysis (type check, lint), unit, functional, online and QAS.
  The folders are `tests/static/`, `tests/unit/`, `tests/functional/` and `tests/online/`.
- `run.sh test` runs all phases. `run.sh test <phase>` runs one phase. A failure does not stop the
  run.
- A passed test gives a short summary. A failed test gives its full output.
- The work has two steps: first the TypeScript and OOD migration with no change of behaviour, then
  the plugins.

## Consequences

- The server has no discovery code. To stop the discovery, disable its plugin instances.
- A new method of field detection is a new dom-classifier plugin, with no server change.
- The typed plugin APIs are reviewed after the migration step, before the plugins are made.
- It supersedes [ADR-20261106-provider_kinds_and_matching](ADR-20261106-provider_kinds_and_matching.md)
  and the `provider-config` part of
  [ADR-20261106-domain_tree_and_provider_config](ADR-20261106-domain_tree_and_provider_config.md).
- REQ-031, REQ-034 to REQ-036, REQ-037, REQ-030a, REQ-039, REQ-039a and UI-01 of SRS change or are
  removed. DESIGN sections 4, 5.1, 6.2, 8 and 9 change. ASK_TIMEOUT is removed.
- Login links that only a Playwright locator can find, e.g. `internal:role=link[...]`, become
  `{ css, text }` matchers.
- A site that keeps the same link text after the login still has no login link sign.
- Events of `browser_evaluate` count as events of the user. The recorder can write a field that the
  agent filled with `browser_evaluate`.
- Page scripts run in the main world of the page. The scripts of the site can see the marks and the
  APIs of the server.
- Fathom adds a dependency (MPL-2.0). Its login ruleset is not proven.
- The tests of the form fill and of the discovery change with the plugins.
