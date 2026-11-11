# Nothing is written outside the repository

Create and change files only inside this repository. Do not write to home folders
(`~/.config`, `~/.claude`, `~/.local`…), `/tmp`, Windows user folders (`C:\Users\…`,
`.wslconfig`) or other OS locations.

- Rules and preferences: a rule (rule rules-and-skills). Never a memory store of a tool.
- Tool config: the repository copy (e.g. `.kilo/kilo.jsonc`), not the user-level one.
- Temp files, backups, scratch: `.local_assets/`.
- You can read outside. If a write outside is necessary, first ask with the exact
  change. Tell the user about side-effect writes (logs, caches).
- Exception: the [vault tool](../tools/auth/README.md) writes its key passphrases into the OS
  keyring. Write nothing else there.
