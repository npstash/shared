---
id: deliverables-only
summary: Commit only what cannot be regenerated; intermediate files go into .local_assets/.
applies-to: all-agents
requires:
  - .gitignore entry for .local_assets/
related: []
---

# Deliverables only

Never commit what can be regenerated: build output, caches, virtualenvs, logs,
downloads, scratch scripts, notes, test artifacts. Intermediate and generated files go
into the project's gitignored `.local_assets/` (e.g. `tools/auth/.local_assets/`);
repo-wide scratch into `./.local_assets/`.
