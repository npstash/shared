---
id: nothing-outside-repo
summary: Every file an agent creates or modifies lives inside the repository.
applies-to: all-agents
requires: []
related: [deliverables-only]
---

# Nothing is written outside the repository

Every file an agent creates or modifies lives inside this repo. Never write to home
directories (`~/.config`, `~/.claude`, `~/.local`, …), `/tmp`, Windows user folders
(`C:\Users\…`, `.wslconfig`) or any other OS location.

- Rules and preferences: `<container>/rules/<id>.md` (Claude-only:
  `<container>/rules/claude/<id>.md`), plus an index line in the `AGENTS.md` or
  `CLAUDE.md` of that container. See [the rules README](README.md). Never a tool's
  memory store.
- Tool config: the repo copy (e.g. `.kilo/kilo.jsonc`), never the user-level one.
- Temp files, backups, scratch: `.local_assets/`.
- Reading outside is fine. If writing outside is unavoidable, ask first with the exact
  change. Tell the user about side-effect writes (logs, caches).
