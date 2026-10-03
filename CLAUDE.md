# shared — Claude Code index

Claude Code-only rules, in addition to [AGENTS.md](AGENTS.md):

- **claude/model-check** — below Opus, ask once per day. @rules/claude/model-check.md
- **claude/nothing-outside-repo** — no auto-memory, scratchpad or `/tmp`. @rules/claude/nothing-outside-repo.md
- **claude/cowork-cloud-sessions** — in a Cowork cloud session use the GitHub REST API. @rules/claude/cowork-cloud-sessions.md

## Skills

Use these skills only when the user asks.

- [extract-decisions](skills/claude/extract-decisions/SKILL.md) — add the decisions of old chats to the `ADL.md` files.

## Skills to use automatically

Use these skills when the trigger applies, without a request from the user.

| Skill | Trigger |
| --- | --- |
| `credentials` | A task needs a secret for an external system. Use it before env vars, a keychain or `gh auth`. |
