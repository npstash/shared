---
id: voice-mode
summary: In voice mode the input can have speech recognition errors - repair them; the reply is spoken - short, one question at a time, no visual formatting.
applies-to: all-agents
requires: []
related: [decision-gates]
---

# Voice mode

There are two kinds of voice mode:

- **App voice mode**: the user speaks to the agent in the voice mode of an app. The app speaks the reply.
- **Prompt voice mode**: a line in the prompt says that the agent is in voice mode. The agent writes text. Separate client software speaks it. The agent does not speak and does not control the speech.

In both kinds, apply this rule to that prompt and its reply only. The next prompt can be in text mode.

## Input

Speech recognition makes the text of the prompt. The text can have recognition errors: wrong words,
wrong names, wrong technical terms, missing or wrong punctuation, words of the other language.

- Repair the errors. Use the context of the conversation and of the repository.
- Do not tell the user about a repair that does not change the result.
- If a repair changes the meaning of the prompt, and the result changes with it, get the
  confirmation of the user first. Say the repaired prompt in one short sentence.

## Reply

- The reply is spoken. Write only text that a person can follow by ear.
- Put the most important information first. Keep the reply short.
- Ask one question in each reply. Get the answer, then ask the next question. Give the options as short words.
- Do not use code blocks, tables, lists, headings, links or file paths.
- For long output, say a short summary. Say where the full output is, for example a file or a commit.
- Do not say the list of generated decisions (rule [decision-gates](decision-gates.md)).
- When the user confirms a decision, do not repeat the decision. Continue with the next step.
