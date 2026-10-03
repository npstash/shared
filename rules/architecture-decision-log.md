---
id: architecture-decision-log
summary: Each project and tool has an ADL.md, a one-line-per-decision log of architecture decisions and business rules, sorted by date.
applies-to: all-agents
requires: []
related: [confirm-design-choices, decision-gates]
---

# Architecture decision log

Keep an `ADL.md` in the folder of each project and each tool. Record the decisions about
that item: the decisions of the user and the decisions of an agent.

```markdown
- 2026-10-03 Nestor Use SQLite for the cache
- 2026-10-03 ClaudeCode/Opus-5.5 Run the import as a weekly job
```

- Record only architectural decisions and business rules. Skip decisions about file
  organisation, source control, versions, configuration values, development tooling and
  documentation.
- Write one line for each decision: `- <yyyy-mm-dd> <author> <decision>`.
  The list item keeps one line for each decision when Markdown renders the file.
- Author: for the user, the git `user.name`. For an agent, `<tool>/<model>`. Use no spaces.
- Write the decision only. Do not write reasons, options or other metadata.
- Keep the lines sorted by date, oldest first. Keep the order of decisions on the same date.
- Never change or delete a line. If a decision changes, add a new line.
- Create `ADL.md` with the first decision.
