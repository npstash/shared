---
id: confirm-design-choices
summary: Never make a design choice without the user's confirmation, except in unattended runs.
applies-to: all-agents
requires: []
related: [decision-gates]
---

# Confirm design choices

Never make a design choice (algorithm, format, structure, dependency, interface,
unspecified behaviour) without the user's explicit confirmation. If a request leaves
one open or can't be done as stated, stop and ask: give the options and their
consequences, then wait. Mentioning a choice afterwards is not confirmation.

**Exception — unattended runs:** when no interactive user can answer (a scheduled or
cloud run, e.g. a Cowork cloud session), decide yourself and record each decision with
its reason in the commit message.
