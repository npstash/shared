---
id: decision-gates
summary: Ask for open decisions before generating the rest; one question section per reply;
  user and agent decisions listed apart at the top of the reply.
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
- At the top of each reply, list the decisions in two lists. Write one line each, with
  no reasons and no options.
  - "User decisions": the answers and choices of the user since the last reply. An
    answer is a user decision also if you recommended the option.
  - "Agent decisions": the decisions that you took without the user. This includes
    skipped gates, assumptions, and questions that you answered yourself.
- Never put a decision of the user into "Agent decisions".
- Unattended runs: not applicable.
