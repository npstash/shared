# Runtimes are per-project

- Keep the runtime and the dependencies in the project folder (`.venv/`,
  `node_modules/`…).
- Never change a global runtime: no global `pip install`, no `npm install -g`, no
  system Python/Node. If one seems necessary, ask the user first.
- Launch with `run.sh` of the project. It creates or updates the runtime, then activates it.
- Pin dependencies (`requirements.txt`, `package.json`…).
