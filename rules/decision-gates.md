---
id: decision-gates
summary: Ask for open decisions before generating the rest; one question section per reply;
  automatic decisions listed at the top of the reply.
applies-to: all-agents
requires: []
related: [confirm-design-choices]
---

# Decision gates

Default conversation mode (stage-gate): don't write an answer whose content depends on
unconfirmed decisions, clarifications or inferred assumptions — it wastes tokens and
gets rewritten.

- Split the work into sections; send **one section with questions per reply**.
- Each question: id (`A1`, `B2`…), lettered options with consequences, a recommendation.
- End the reply by saying whether the section is closed and what comes next; wait.
- Content that needs no decision may be delivered without stopping.
- Skip the gate when decisions are few and cheap to reverse: decide, state it, go on.
- **Every decision taken without asking is listed at the top of that reply**, before
  anything else: a short bulleted list, one line each, no reasoning, no options. The
  user asks if they want more. This covers the skipped gates above, inferred
  assumptions, and any question the agent raised itself and then answered.
- Not applicable to unattended runs (nobody to answer).
