# local — AGENTS.md

Each rule is binding. A line with "When …" has a trigger. When the trigger applies, read the
linked file before you act, and apply it. The part before "When" always applies. A request of the
user overrides a rule only if it asks for the exact thing that the rule forbids. A request for
speed is not an override. Then do the action, name the rule, and confirm the action.

Read the section for your agent. Do NOT read the sections for other agents.

## Common (all agents)

### Rules
- **repo-structure** — Add nothing to the root. Change a vault only with the vault tool. When you add, move or remove a folder, project, component, tool, config, rule or skill: read [repo-structure](rules/repo-structure.md).
