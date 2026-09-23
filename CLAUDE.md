# shared — Claude Code index

Claude Code-only rules, binding in addition to the ones in [AGENTS.md](AGENTS.md):

- **claude/model-check** — once per day per chat, confirm with the user before working if running below Opus. @rules/claude/model-check.md
- **claude/nothing-outside-repo** — no auto-memory, no scratchpad or `/tmp`. @rules/claude/nothing-outside-repo.md
- **claude/cowork-cloud-sessions** — in a Cowork cloud session reach GitHub over REST, GraphQL is blocked. @rules/claude/cowork-cloud-sessions.md

## Skills to use automatically

Invoke these skills automatically when their trigger applies — no need for the user to ask.

| Skill | Use it when |
| --- | --- |
| `credentials` | A task needs a username, password, token or key for any external system — before reaching for env vars, a keychain or `gh auth`. See credentials-from-vault. |
