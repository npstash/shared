---
id: claude/model-check
summary: Once per day per chat, confirm with the user before working if running below Opus.
applies-to: claude-code
requires: []
related: []
---

# Model check

On the first response of each calendar day in a chat, check the running model. Opus or
higher: continue silently. Lower: state the model and ask whether to proceed or switch
with `/model opus`. Only once per day per chat.
