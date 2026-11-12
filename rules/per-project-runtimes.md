# Runtimes are per-project

- Keep the runtime and the dependencies in the project folder (`.venv/`, `node_modules/`…).
- A global change is e.g. a global `pip install`, `npm install -g`, or a change of the system
  Python or Node. If one seems necessary, ask the user first.
- Launch with the `run.sh` of the project. It creates or updates the runtime, then activates it.
- Pin the dependencies (`requirements.txt`, `package.json`…).
