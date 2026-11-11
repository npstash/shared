# shared

One file for each rule, so that you can copy a rule alone. A **container** is a folder
with `rules/`, `skills/`, `tools/` and an index. This repository is one container.

The rule rules-and-skills ([rules/rules-and-skills.md](rules/rules-and-skills.md)) gives the
format of a rule, of an index line and of a skill.

Cite a rule by its id, not by a number. Numbers collide between workspaces.

## How the tools load rules

The index [AGENTS.md](AGENTS.md) has a section for each agent. It is always in the context of
the agent. A rule has one of three classes:

- **Always**: the index imports the rule file with `@`.
- **Triggered**: the index line gives the trigger and a link. The agent reads the file when the
  trigger applies.
- **Inline**: the index line is the complete rule.

- **Claude Code** follows `@` imports: root `AGENTS.md` → container `AGENTS.md` → `@rules/<id>.md`.
- **Kilo** does not follow `@` imports. `.kilo/kilo.jsonc` loads each `AGENTS.md` and `rules/*.md`.
  Thus Kilo loads each rule file at the start. The glob does not recurse: it skips `rules/claude/`.

To measure if agents follow a rule, use the skill `eval-rule` and the tool
[rule-evals](tools/rule-evals/README.md).

## Skills

Put a skill into `skills/<name>/SKILL.md` and add it to [AGENTS.md](AGENTS.md). Then run
`setup.sh` of the repository root. It links the skill into `.claude/skills/`, where Claude Code
and Kilo find it.

## Use in another workspace

1. Add this repository as the `shared` submodule.
2. Import `@shared/AGENTS.md` in the root `AGENTS.md`.
3. Add `shared/AGENTS.md` and `shared/rules/*.md` to `instructions` in `.kilo/kilo.jsonc`.
4. Copy [setup.sh](setup.sh) to the root, and run it.
5. For the vault, add a vault home repository that `tools/auth/run.sh create-vault` makes.
