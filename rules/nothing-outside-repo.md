---
id: nothing-outside-repo
summary: Every file an agent creates or modifies lives inside the repository.
applies-to: all-agents
requires: []
related: [deliverables-only]
---

# Nothing is written outside the repository

Create and change files only inside this repository. Do not write to home folders
(`~/.config`, `~/.claude`, `~/.local`…), `/tmp`, Windows user folders (`C:\Users\…`,
`.wslconfig`) or other OS locations.

- Rules and preferences: `<container>/rules/<id>.md` (Claude Code only:
  `<container>/rules/claude/<id>.md`), and an index line in the `AGENTS.md` or
  `CLAUDE.md` of the container. Never a memory store of a tool.
- Tool config: the repository copy (e.g. `.kilo/kilo.jsonc`), not the user-level one.
- Temp files, backups, scratch: `.local_assets/`.
- You can read outside. If a write outside is necessary, first ask with the exact
  change. Tell the user about side-effect writes (logs, caches).
