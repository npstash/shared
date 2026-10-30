---
id: architecture-decision-log
summary: Each project and tool has an ADL.md, a one-line-per-decision log of architecture decisions and business rules; an ADR file only on request.
applies-to: all-agents
requires: []
related: [agent-identity, confirm-design-choices, decision-gates]
---

# Architecture decision log

Keep an `ADL.md` in the folder of each project and each tool. Record the decisions about
that item. Create `ADL.md` with the first decision. A component of a project has no `ADL.md`.
Record its decisions in the ADL of the project.

```markdown
- 20261004-01 Nestor 4abf63da3ce0 Use SQLite for the cache
- 20261004-02 Opus-5.5 4abf63da3ce0 Run the import as a weekly job
```

- Record only accepted decisions. Add the entry when the design documents and the code show
  the decision. Do not record a proposed decision; write a proposed ADR for it (see "ADR").
- Record only architectural decisions and business rules. Skip decisions about file
  organisation, source control, versions, configuration values, development tooling and
  documentation.
- Write one line for each decision: `- <id> <name> <commit> <decision>`.
  Separate the fields with one space. Only `<decision>` can contain spaces.
  - `id`: `yyyymmdd-NN`. `yyyymmdd` is the UTC date of the decision. `NN` is a counter
    of the entries of that date in this `ADL.md`, from `01`. After `99`, add digits.
  - `name`: the git name of the user for a user decision. For an action that an agent
    took without input from the user, the model name, e.g. `Opus-5.5`. See
    [agent-identity](agent-identity.md). An agent environment can set `user.name` to the
    agent; then use the name from the commits of the user.
  - `commit`: the 12-character ID of the last commit in the repository of the `ADL.md`
    at the time of the decision. For an entry from before the item moved to this
    repository, use the last commit of the earlier repository.
  - `decision`: the decision only. Do not write reasons, options or other metadata.
- Keep the lines sorted by the date, then by the number `NN`.
- The ADL is a record of the decisions, not a description of the current system. If a
  decision changes, add a new line. Do not change or delete the line of the earlier decision.
- You can correct a line, e.g. a typo or a commit ID that a rebase changed. A correction
  must not change the decision.

## ADR

- Write an ADR only when the user asks. Use the `create-adr` skill.
- Put it into `adr/ADR-<yyyymmdd>-<topic>.md` beside the `ADL.md`. `<yyyymmdd>` is the UTC
  date of the ADR. `<topic>` is a short topic in lowercase, with `a-z`, `0-9` and `_`, e.g.
  `ADR-20261029-images_from_registry.md`. The name is not related to the ADL IDs.
- The ADR field `ADL entry` connects the ADR to its ADL entry.
- A proposed ADR has the status `Proposed`. Its `ADL entry` field is `n/a`. Do not mention
  it in the ADL.
- When the user accepts a proposed ADR, set its status to `Accepted`. Update the design
  documents. Then add the ADL entry, and write its ID into the `ADL entry` field.
- Suggest an ADR for a decision that changes the architecture much and changes earlier
  decisions.
