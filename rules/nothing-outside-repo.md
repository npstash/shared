# Nothing is written outside the repository

Create and change files only inside this repository. Do not write to home folders
(`~/.config`, `~/.claude`, `~/.local`…), `/tmp`, the memory folder or the scratchpad of an
agent tool, Windows user folders (`C:\Users\…`, `.wslconfig`) or other OS locations.

- Rules and preferences: write a rule. Never use a memory store of a tool.
- Tool config: change the copy in the repository (e.g. `.kilo/kilo.jsonc`), not the
  user-level one.
- You can read outside. If a write outside is necessary, first ask with the exact change.
  Tell the user about side-effect writes (logs, caches).
- Exception: the vault tool writes its key passphrases into the OS keyring. Write nothing else there.
