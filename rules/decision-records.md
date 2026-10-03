---
id: decision-records
summary: Each project and tool has a DR.md, a one-line-per-decision log sorted by date.
applies-to: all-agents
requires: []
related: [confirm-design-choices, decision-gates]
---

# Decision records

Keep a `DR.md` in the folder of each project and each tool. Record each decision about
that item: the decisions of the user and the decisions of an agent.

```markdown
- 2026-10-03 Nestor Use SQLite for the cache
- 2026-10-03 ClaudeCode/Opus-5.5 Pin requests to 2.32.3
```

- Write one line for each decision: `- <yyyy-mm-dd> <author> <decision>`.
  The list item keeps one line for each decision when Markdown renders the file.
- Author: for the user, the git `user.name`. For an agent, `<tool>/<model>`. Use no spaces.
- Write the decision only. Do not write reasons, options or other metadata.
- Do not record cosmetic decisions (names of variables, text style, layout).
- Keep the lines sorted by date, oldest first. Keep the order of decisions on the same date.
- Never change or delete a line. If a decision changes, add a new line.
- Create `DR.md` with the first decision.
