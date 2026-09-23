---
id: per-project-runtimes
summary: Each project owns its runtime in its own folder; never touch a global runtime; launch via run.sh / run.bat.
applies-to: all-agents
requires:
  - .gitignore entries for .venv/ and node_modules/
related: []
---

# Runtimes are per-project

- Keep the runtime and the dependencies in the project folder (`.venv/`,
  `node_modules/`…).
- Never change a global runtime: no global `pip install`, no `npm install -g`, no
  system Python/Node. If one seems necessary, ask the user first.
- Launch with `run.sh` and `run.bat` of the project. Both create or update the runtime,
  then activate it. Keep the two in sync.
- Pin dependencies (`requirements.txt`, `package.json`…).
