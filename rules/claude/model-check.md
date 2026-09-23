---
id: claude/model-check
summary: Once per day per chat, confirm with the user before working if running below Opus.
applies-to: claude-code
requires: []
related: []
---

# Model check

In the first reply of each calendar day in a chat, check the model. Opus or higher:
continue silently. Lower: state the model, and ask to continue or to switch with
`/model opus`.
