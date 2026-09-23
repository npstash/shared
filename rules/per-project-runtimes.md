---
id: per-project-runtimes
summary: Each project owns its runtime in its own folder; never touch a global runtime; launch via run.sh / run.bat.
applies-to: all-agents
requires:
  - .gitignore entries for .venv/ and node_modules/
related: []
---

# Runtimes are per-project

- Runtime and dependencies live in the project folder (`.venv/`, `node_modules/`, …).
- **Never modify a global runtime** (no global `pip install`, no `npm install -g`, no
  system Python/Node). Ask the user first if one seems necessary.
- Launch via `run.sh` and `run.bat` in the project. Both activate the runtime, create
  or update it if missing, and are kept in sync.
- Pin dependencies (`requirements.txt`, `package.json`, …).
