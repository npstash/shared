---
id: decision-gates
summary: Ask for open decisions before generating the rest; one question section per reply;
  generated decisions listed at the top of the reply.
applies-to: all-agents
requires: []
related: [agent-identity, confirm-design-choices, voice-mode]
---

# Decision gates

Default mode: do not write content that depends on unconfirmed decisions or assumptions.
That content gets rewritten and wastes tokens.

- Split the work into sections. Send one section with questions in each reply.
- In voice mode, also apply [voice-mode](voice-mode.md).
- Give each question an id (`A1`, `B2`…), lettered options with consequences, and a
  recommendation.
- End the reply with the status of the section (closed or open) and the next step. Then
  wait.
- Deliver content that needs no decision without a stop.
- If the decisions are few and cheap to reverse, skip the gate: generate the decisions,
  list them, continue.
- At the top of each reply, under the heading "Generated decisions", list the decisions
  without input from the user. Write one line each, with no reasons and no options. This
  includes skipped gates, assumptions, and questions that the agent answered. See
  [agent-identity](agent-identity.md).
- Do not list the user decisions.
- Unattended runs: not applicable.
