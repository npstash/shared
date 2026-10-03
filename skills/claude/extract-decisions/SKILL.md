---
name: extract-decisions
description: Extract the decisions from old Claude Code chats of this repository into the ADL.md files of the projects and tools (rule architecture-decision-log). Use only when the user asks, e.g. "extract decisions from old chats", "backfill ADL.md", "/extract-decisions".
---

# Extract decisions from old chats

Add the decisions of old chats to the `ADL.md` files. Follow the rule
[architecture-decision-log](../../../rules/architecture-decision-log.md) for the format
and the decisions to record.

`S` is the folder of this skill. Run each command from the repository root.

## 1. Select the chats

```bash
python3 S/transcript.py list
```

It writes the unprocessed transcripts: ID, date range, title. Add `--all` to also see
processed ones. Use the chats that the user names. Else use all unprocessed chats.

## 2. Read a chat

```bash
python3 S/transcript.py show <ID>
```

It writes one line for each message: date, author, text. It also writes the file paths
of tool calls and the answers to questions. It removes answers to questions about
secrets. Never copy a secret into an `ADL.md` or into the reply.

## 3. Find the decisions

Record these:

- an answer of the user to a question, also if the agent recommended the option,
- a choice that the user made without a question,
- a decision that the agent took itself, e.g. in an "Agent decisions" list.

Record only the decisions that the rule accepts. Do not record decisions that the chat
changed again before its end; record only the final one.

Give each decision the date and the author of the message that made it, not of a message
that repeats it. An agent reply can repeat the decisions of the user. Older chats list
them as "decisions taken without a question". Before you give an agent as author, make
sure that no earlier user message made or chose that decision. For an agent decision,
use the author that `show` writes.

## 4. Find the ADL.md files

- Use the file paths of the chat and the text to find the projects and tools of each decision.
- Add a decision to the `ADL.md` of each project and tool that it affects.
- Skip a decision that affects no project or tool, e.g. a rule or the repository structure.
- If a project or tool no longer exists, skip its decisions.
- Skip a decision if the same `ADL.md` has an entry with the same date and meaning.

## 5. Confirm and write

1. Show the new entries, grouped by `ADL.md`. Wait for the confirmation of the user.
2. Insert each entry at its date position. Keep the lines sorted by date.
3. Mark the chats as processed:

   ```bash
   python3 S/transcript.py done <ID>...
   ```
