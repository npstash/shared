# Architecture Decision Log (ADL)

The log of the decisions that change the design. Write one line for each decision. The AI agent adds the lines.

```markdown
- 20261004-01 Nestor 4abf63da3ce0 Use SQLite for the cache
- 20261004-02 Opus-5.5 4abf63da3ce0 Run the import as a weekly job
```

## Format

`- [id] [name] [commit] [decision]`

Separate the fields with one space. Only [decision] can contain spaces.

- `id`: `yyyymmdd-NN`. `yyyymmdd` is the UTC date of the decision. `NN` is a counter of the entries of that date, from `01`. After `99`, add digits.
- `name`: the git name of the user for a user decision. The model name, e.g. `Opus-5.5`, for an action that the AI agent took without input from the user.
- `commit`: the 12-character ID of the last commit in the repository at the time of the decision.
- `decision`: the decision only. Do not write reasons, options or other metadata.

## Rules

- Record only accepted decisions that change the design in a non-trivial way. Add the line when DESIGN shows the decision.
- Do not mention a proposed decision. It has only an ADR with the status Proposed and the `ADL entry` field `n/a`.
- Do not record decisions that change only the metadata or the structure of a design file.
- Do not record changes to PRD, SRS or QAS. These files hold the current state.
- Keep the lines sorted by the date, then by the number `NN`.
- Never change or delete a line. If a decision changes, add a new line.
- For an important decision, write an ADR in `sdd/adr/ADR-[yyyymmdd]-[topic].md`. The field `ADL entry` of the ADR holds the ID of the ADL line.

## Log

