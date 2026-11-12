# shared

Rules, skills and tools that more than one repository uses. This repository is one
**container**: a folder with `rules/`, `skills/`, `tools/` and the index [AGENTS.md](AGENTS.md).

The rule [rules-and-skills](rules/rules-and-skills.md) gives the format of a rule, of an index
line and of a skill.

## How the tools load rules

- **Claude Code** follows `@` imports: root `AGENTS.md` → container `AGENTS.md` →
  `@rules/<id>.md`. Thus the index and the "always" rules are in the context from the start.
  The agent reads a triggered rule when its trigger applies.
- **Kilo** does not follow `@` imports. `.kilo/kilo.jsonc` loads each `AGENTS.md` and
  `rules/*.md`. Thus Kilo loads each rule file at the start. The glob does not recurse: it
  skips the rules of one agent, e.g. `rules/claude/`.

To measure if agents follow a rule, use the tool [rule-evals](tools/rule-evals/README.md).

## Use in another repository

1. Add this repository as the `shared` submodule.
2. Copy the root [AGENTS.md](skills/create-repo-structure/templates/AGENTS.md). It explains
   the index lines and imports `@shared/AGENTS.md`.
3. Add `shared/AGENTS.md` and `shared/rules/*.md` to `instructions` in `.kilo/kilo.jsonc`.
4. Copy [setup.sh](setup.sh) to the root, and run it.
5. For the vault, add a vault home repository that `tools/auth/run.sh create-vault` makes.
