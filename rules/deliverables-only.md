---
id: deliverables-only
summary: Commit only what cannot be regenerated; intermediate files go into .local_assets/.
applies-to: all-agents
requires:
  - .gitignore entry for .local_assets/
related: []
---

# Deliverables only

Do not commit what you can regenerate: build output, caches, virtualenvs, logs,
downloads, scratch scripts, notes, test artifacts. Put intermediate and generated files
into the gitignored `.local_assets/` of the project. Put repo-wide scratch into
`./.local_assets/`.
