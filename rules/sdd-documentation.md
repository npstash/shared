# SDD documentation

The SDD (SW Development Documents) and their process are in
[workflow.md](../tools/sdd-templates/workflow.md).

- Apply the workflow only to a project with an `sdd/` folder.
- Create an `sdd/` folder only when the user asks.
- In a project with `sdd/`, `sdd/ADL.md` replaces the `ADL.md` of architecture-decision-log.

## Values

- Write each value (a limit, a time, a default) as an uppercase name, e.g. `RETRY_COUNT`.
- Define each name with its default in the "Default values" section of one SDD document: the first document that uses the value.
- In other documents, use the same name. Do not define it again. Refer to the document that defines it.
- In the text, write the default and the unit in parentheses after the name, e.g. `RETRY_COUNT (3)`, `SOME_TIMEOUT (1000 ms)`. Do not do this in the "Default values" table and in code blocks.
- When a default changes, update each occurrence of the name.

## Components

This section applies only to a project that keeps its components in separate folders. If
the repository has a rule that defines components, use its definition.

- Do not apply the workflow to a component. Update the SDD of the parent project.
- Create an `sdd/` folder in a component only with the explicit confirmation of the user.
