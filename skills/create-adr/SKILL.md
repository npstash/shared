---
name: create-adr
description: Write an architecture decision record (ADR) for an entry of an ADL.md (rule architecture-decision-log). Use only when the user asks, e.g. "write an ADR for X", "create ADR", "/create-adr".
---

# Create an ADR

Follow the rule [architecture-decision-log](../../rules/architecture-decision-log.md).

1. Find the ADL entry that the user names. If the decision has no entry yet, add the
   entry first. For a proposed decision, add no entry: the ID is the UTC time now, and
   the status is `Proposed`.
2. Fill Context, Decision and Consequences from the chat, the ADL, the code and earlier
   ADRs.
3. Ask the user for information that the context does not give. Do not invent it.
4. Write the file `adr/ADR-<id>.md` beside the `ADL.md`, then show its path.

Use this template. Copy the header fields from the ADL entry. Write the text in the
style of the repository.

```markdown
# ADR-<id>: <title>

- ADL entry: `<id>` in [ADL.md](../ADL.md), or `none` for a proposed ADR
- Type: <authored|generated>
- Name: <name>
- Commit: <commit>
- Status: <Accepted|Proposed>

## Context

## Decision

## Consequences
```
