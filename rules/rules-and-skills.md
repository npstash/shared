# Rules and skills

A rule is a constraint. A skill is a procedure. A container is a folder with `rules/`,
`skills/` and the index `AGENTS.md`. Ask the user for the container of a new rule or skill.

## Content

The set of rules and skills can change at any time. Each rule and each skill must be correct
alone.

- Do not name another rule or skill in a rule, an index line or a skill. Name the subject,
  e.g. "the vault tool".
- Do not name a container. Only the rule for the repository structure names the containers.
- Give each instruction in one rule only. Before you add an instruction, search the other
  rules for its subject. If two rules give the same instruction, keep it in the rule of its subject.
- Write only instructions that change what an agent does. Do not describe what an agent
  knows or finds without the rule.
- Give a relative link only to a tool or a file of the same container.

## Class

Give each rule one class.

- **Inline**: the complete rule is one index line of a maximum of 40 words. It has no file.
- **Triggered**: the rule applies to a task, a tool or a state that an agent can observe.
- **Always**: the rule applies to each reply, or an agent cannot observe its trigger.

Use "always" only if the other classes are not possible.

## Index line

The index has one list of rules. Each agent reads each line.

- Inline: `- **<id>** — <rule>`
- Triggered: `- **<id>** — <core>. When <trigger>: read [<id>](rules/<id>.md).`
- Always: `- **<id>** — @rules/<id>.md`

- Core: each prohibition that an agent can break before it reads the file. Omit it if there
  is none. Do not repeat the core in the file.
- Trigger: an event that an agent can observe. Do not use a judgement as a trigger.
- For a rule of one agent, start the trigger with the agent: "When you are <agent> and …".
- `@` loads the file at the start of each session. Use it only in an "always" line.
- Do not add a `CLAUDE.md`. Claude Code reads `AGENTS.md`.

## Rule file

- Write one file for each rule: `rules/<id>.md`, or `rules/<agent>/<id>.md` for a rule of one
  agent. The id is the file name.
- Write no frontmatter.
- Put the other files of a rule into `rules/<id>/`.

## Skills

- Put a skill into `skills/<name>/SKILL.md`, or `skills/<agent>/<name>/SKILL.md` for one agent.
- The `description` in the frontmatter is the trigger. Write the index line with the name and
  the link only.
- Never put a skill into `.claude/skills/`. `setup.sh` makes the links there. Run it after you
  add or remove a skill.

## Add, change or merge

- Merge two rules when they have the same subject and the same trigger.
- For a new rule, and for a changed core or trigger, write eval scenarios into
  `rules/<id>/evals.toml`. Run them only with the confirmation of the user.

## Disable

To disable a rule in one repository, add its id to "Disabled rules" in the root
`AGENTS.md`. Do not change the index of a container that other repositories use.

## Move, rename or copy

- Update the index line.
- To copy a rule to another repository, copy the file, the folder `rules/<id>/` and the index line.
