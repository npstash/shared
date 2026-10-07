---
id: claude/model-check
summary: Once per day per chat and after each session start, confirm with the user before working if running below Opus.
applies-to: claude-code
requires: []
related: []
---

# Model check

Check the model in the first reply of each calendar day in a chat. Also check it in the
first reply after a session start or a window reload. Opus or higher: continue silently.
Lower: state the model, and ask to continue or to switch with `/model opus`.
