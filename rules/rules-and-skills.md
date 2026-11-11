# Rules and skills

A rule is a constraint. A skill is a procedure. The user decides the container of each one.

A container is a folder with `rules/`, `skills/` and an index `AGENTS.md`. The rule
repo-structure of the repository names the containers. Do not name a container in
another rule or in a skill.

## Class

Give each rule one class.

- **Inline**: the complete rule is one index line of a maximum of 40 words. It has no file.
- **Triggered**: the rule applies to a task, a tool or a state that an agent can observe.
- **Always**: the rule applies to each reply, or an agent cannot observe its trigger.

Use "always" only if the other classes are not possible.

## Rule file

- Write one file for each rule: `rules/<id>.md`. The id is the file name.
- Put a rule for one agent into `rules/<agent>/<id>.md`.
- Write the complete rule in the file. Write no frontmatter.
- Put the other files of a rule into `rules/<id>/`, e.g. the eval scenarios `evals.toml`.
- If a rule needs a tool or a file of its container, give a relative link to it in the rule text.
- Refer to another rule or skill by its id or name. Do not write a path to it.

## Index line

Put the line into the index of the container of the rule, in the section of its agent.

- Inline: `- **<id>** — <rule>`
- Triggered: `- **<id>** — <core>. When <trigger>: read [<id>](rules/<id>.md).`
- Always: `- **<id>** — @rules/<id>.md`

- Core: each prohibition that an agent can break before it reads the file. Omit it if there is none.
- Trigger: an event that an agent can observe. Do not use a judgement as a trigger.
- Do not write `@` in a triggered line. `@` loads the file at the start of each session.
- Write the core and the trigger only in the index line.

## Skills

- Put a skill into `skills/<name>/SKILL.md`, or `skills/<agent>/<name>/SKILL.md` for one agent.
- The `description` in the frontmatter is the trigger. Write the index line with the name and the link only.
- Run `setup.sh` after you add or remove a skill.

## Add, change or merge

- For a new rule, and for a changed core or trigger, use the skill `eval-rule`.
- Merge two rules when they have the same subject and the same trigger.

## Disable

To disable a rule in one repository, add its id to "Disabled rules" in the root
`AGENTS.md`. Do not change the index of a container that other repositories use.

## Move, rename or copy

- Update the index line and each reference to the rule.
- To copy a rule to another repository, copy the file, the folder `rules/<id>/` and the index line.
- The rule repo-structure-template applies.
