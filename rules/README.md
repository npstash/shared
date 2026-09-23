# rules

One file per rule, so any rule can be copied into another workspace on its own.

Rules, tools and skills live in **containers**. A container is a folder with `rules/`,
`skills/`, `tools/` and an index. This repository is one container.

- `rules/<id>.md` — binding for every agent; indexed in the container's
  [AGENTS.md](../AGENTS.md).
- `rules/claude/<id>.md` — Claude Code only; indexed in the container's
  [CLAUDE.md](../CLAUDE.md).

Rules are cited by **id**, never by number: numbers collide between workspaces.

## File format

```markdown
---
id: credentials-from-vault          # = file name without .md (claude/ prefix for Claude-only)
summary: One line, reused in the index.
applies-to: all-agents              # or: claude-code
requires:                           # what must be copied along for the rule to hold
  - tools/auth
related: [nothing-outside-repo]     # other rule ids the text cites
---

# Title

Rule text.
```

## How each tool loads the rules

- **Claude Code** — the root `CLAUDE.md` imports `@AGENTS.md` and the `CLAUDE.md` of each
  container. The root `AGENTS.md` imports the `AGENTS.md` of each container. Each index
  line ends with an `@rules/<id>.md` import, so every rule file is inlined into context.
- **Kilo** — does not follow `@` imports. `.kilo/kilo.jsonc` loads each `AGENTS.md` and
  `<container>/rules/*.md`. The glob does not recurse, so `claude/` is not loaded. (It
  also loads this README; harmless.)

A rule that exists as a file but has no index line is **not loaded by Claude Code**.

## Skills

Put each skill into `<container>/skills/<name>/SKILL.md`. Then run `setup.sh` (or
`setup.bat`) of the repository root: it links the skill into `.claude/skills/`, where
Claude Code and Kilo find it. Add the skill to the index of its container.

## Using this repository in another workspace

1. Add it as the `shared` submodule.
2. In the root `AGENTS.md`, import `@shared/AGENTS.md`; in the root `CLAUDE.md`, import
   `@AGENTS.md` and `@shared/CLAUDE.md`.
3. In `.kilo/kilo.jsonc`, add `shared/AGENTS.md` and `shared/rules/*.md` to
   `instructions`.
4. Copy [setup.sh](../setup.sh) and [setup.bat](../setup.bat) to the root, and run one.
5. Check the `requires` of each rule. For the vault, add a `private-data` submodule made
   with `tools/auth/run.sh init`.
