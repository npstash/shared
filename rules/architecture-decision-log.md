---
id: architecture-decision-log
summary: Each project and tool has an ADL.md, a one-line-per-decision log of architecture decisions and business rules; an ADR file only on request.
applies-to: all-agents
requires: []
related: [agent-identity, confirm-design-choices, decision-gates]
---

# Architecture decision log

Keep an `ADL.md` in the folder of each project and each tool. Record the decisions about
that item. Create `ADL.md` with the first decision.

```markdown
- 20261004-224512-00 authored Nestor 4abf63da3ce0 Use SQLite for the cache
- 20261004-224512-01 generated Opus-5.5 4abf63da3ce0 Run the import as a weekly job
```

- Record only accepted decisions. Add the entry when the design documents and the code show
  the decision. Do not record a proposed decision; write a proposed ADR for it (see "ADR").
- Record only architectural decisions and business rules. Skip decisions about file
  organisation, source control, versions, configuration values, development tooling and
  documentation.
- Write one line for each decision: `- <id> <type> <name> <commit> <decision>`.
  Separate the fields with one space. Only `<decision>` can contain spaces.
  - `id`: the UTC time of the decision, `yyyymmdd-hhmmss-xx`. It identifies the entry.
    For a decision from a proposed ADR, use the ID of the ADR.
  - `xx`: a counter for entries with the same time, from `00`. After `99`, add digits.
  - `type`: `authored` for a user decision, `generated` for a generated decision. See
    [agent-identity](agent-identity.md).
  - `name`: for `authored`, the git name of the user; for `generated`, the model name,
    e.g. `Opus-5.5`. An agent environment can set `user.name` to the agent; then use the
    name from the commits of the user.
  - `commit`: the 12-character ID of the last commit in the repository of the `ADL.md`
    at the time of the decision. For an entry from before the item moved to this
    repository, use the last commit of the earlier repository.
  - `decision`: the decision only. Do not write reasons, options or other metadata.
- Keep the lines sorted by ID. Put an entry with the ID of an ADR at its sorted position.
- The ADL is a record of the decisions, not a description of the current system. If a
  decision changes, add a new line. Do not change or delete the line of the earlier decision.
- You can correct a line, e.g. a typo or a commit ID that a rebase changed. A correction
  must not change the decision.

## ADR

- Write an ADR only when the user asks. Use the `create-adr` skill.
- Put it into `adr/ADR-<id>.md` beside the `ADL.md`. `<id>` is the ID of the ADL entry.
- A proposed ADR has the status `Proposed` and no ADL entry. Its `<id>` is the UTC time of
  the proposal, in the format of the ADL ID.
- When the user accepts a proposed ADR, set its status to `Accepted`. Update the design
  documents. Then add the ADL entry with the ID of the ADR.
- Suggest an ADR for a decision that changes the architecture much and changes earlier
  decisions.
