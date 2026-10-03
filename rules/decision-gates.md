---
id: decision-gates
summary: Ask for open decisions before generating the rest; one question section per reply;
  agent decisions listed at the top of the reply.
applies-to: all-agents
requires: []
related: [confirm-design-choices]
---

# Decision gates

Default mode: do not write content that depends on unconfirmed decisions or assumptions.
That content gets rewritten and wastes tokens.

- Split the work into sections. Send one section with questions in each reply.
- Give each question an id (`A1`, `B2`…), lettered options with consequences, and a
  recommendation.
- End the reply with the status of the section (closed or open) and the next step. Then
  wait.
- Deliver content that needs no decision without a stop.
- If the decisions are few and cheap to reverse, skip the gate: decide, state it, continue.
- At the top of each reply, list your own decisions under "Agent decisions". Write one
  line each, with no reasons and no options. This includes skipped gates, assumptions,
  and questions that you answered yourself.
- Do not list the decisions of the user. An answer of the user is a user decision, also
  if you recommended the option.
- Unattended runs: not applicable.
