# rules

One file for each rule, so that you can copy a rule alone. A **container** is a folder
with `rules/`, `skills/`, `tools/` and an index. This repository is one container.

- `rules/<id>.md` — for all agents; index: [AGENTS.md](../AGENTS.md).
- `rules/claude/<id>.md` — Claude Code only; index: [CLAUDE.md](../CLAUDE.md).

Cite a rule by its id, not by a number. Numbers collide between workspaces.

## File format

```markdown
---
id: credentials-from-vault          # file name without .md (claude/ prefix for Claude-only)
summary: One line, also used in the index.
applies-to: all-agents              # or: claude-code
requires:                           # what to copy with the rule
  - tools/auth
related: [nothing-outside-repo]     # ids of rules that the text cites
---

# Title

Rule text.
```

## How the tools load rules

- **Claude Code** follows `@` imports: root `CLAUDE.md` → `AGENTS.md` → container indexes
  → `@rules/<id>.md`. It does not load a rule without an index line.
- **Kilo** does not follow `@` imports. `.kilo/kilo.jsonc` loads each `AGENTS.md` and
  `<container>/rules/*.md`. The glob does not recurse, so it skips `claude/`.

## Skills

Put a skill into `skills/<name>/SKILL.md` and add it to [AGENTS.md](../AGENTS.md). Put a
Claude Code-only skill into `skills/claude/<name>/SKILL.md` and add it to [CLAUDE.md](../CLAUDE.md). Then run `setup.sh`
(or `setup.bat`) of the repository root. It links the skill into `.claude/skills/`,
where Claude Code and Kilo find it.

## Use in another workspace

1. Add this repository as the `shared` submodule.
2. Import `@shared/AGENTS.md` in the root `AGENTS.md`. Import `@AGENTS.md` and
   `@shared/CLAUDE.md` in the root `CLAUDE.md`.
3. Add `shared/AGENTS.md` and `shared/rules/*.md` to `instructions` in `.kilo/kilo.jsonc`.
4. Copy [setup.sh](../setup.sh) and [setup.bat](../setup.bat) to the root, and run one.
5. Do the `requires` of each rule. For the vault, add a vault home repository that
   `tools/auth/run.sh init` makes.
