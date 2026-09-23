---
id: confirm-design-choices
summary: Never make a design choice without the user's confirmation, except in unattended runs.
applies-to: all-agents
requires: []
related: [decision-gates]
---

# Confirm design choices

Get the explicit confirmation of the user for each design choice: algorithm, format,
structure, dependency, interface, unspecified behaviour. If a request leaves a choice
open, or you cannot do it as stated, stop. Give the options and their consequences,
then wait. A choice that you mention after you make it is not confirmed.

**Unattended runs** (scheduled or cloud, e.g. a Cowork cloud session): decide yourself.
Record each decision and its reason in the commit message.
