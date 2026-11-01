---
name: ssh-remote
description: Use a remote Linux machine over SSH - run a command (also with sudo), upload or download a file - with the login and sudo passwords from the vault, through a script, so that no secret goes into the transcript. Use it each time a task must work on a remote Linux host, before ssh, sshpass or a request to the user. Triggers - "ssh to X", "run on X", "on the NUC", "remote machine", "sudo on X", "copy the file to X", "get the log from X".
---

# SSH to remote Linux machines

Use the [ssh-remote tool](../../tools/ssh-remote/README.md). The rule credentials-from-vault
applies.

- `TOOL` is `tools/ssh-remote` next to the `skills/` folder of this skill. The skill folder
  can be a link, so resolve it: `TOOL="$(realpath <skill folder>)/../../tools/ssh-remote"`.
- Do not run `ssh`, `scp` or `sshpass` yourself. Do not get the passwords with `get-secret`.

## Steps

1. Get the exact name of the SSH system from the user, e.g. `NUC15 SSH in LAN`. For root, get
   also the name of the sudo system, e.g. `NUC15 SUDO`. Do not search the vault for names.
   Get also the vault, e.g. `vault-main`. Each command needs `--vault <vault>` after `run.sh`.
   The commands below leave it out.
2. Run a command: `$TOOL/run.sh exec --system "SSH NAME" -- 'CMD'`. For root, add
   `--sudo --sudo-system "SUDO NAME"`.
3. Copy a file: `$TOOL/run.sh upload --system "SSH NAME" LOCAL REMOTE [--sudo --sudo-system "SUDO NAME"]`
   or `$TOOL/run.sh download --system "SSH NAME" REMOTE LOCAL`. Put local files into `.local_assets/`.

- Each call opens a new connection. There is no interactive shell. Give the full command
  line, e.g. `-- 'cd /var/log && tail -n 50 syslog'`.
- With `--sudo`, the remote command cannot read stdin. Write input to a file with `upload` first.
- Get the confirmation of the user before a command that changes the remote machine, e.g.
  a package install, a restart, a change of a configuration file or a delete.

## Errors

For each error: stop and tell the user.

| Error | Action |
| --- | --- |
| `... is not in ~/.ssh/known_hosts` | Give the user the `ssh` command from the error, for a terminal. The user compares the fingerprint. Do not add the key yourself. |
| `unknown system 'X'` | Ask the user for the exact system name. Do not try other names. |
| `--sudo needs --sudo-system NAME` | Ask the user for the exact name of the sudo system. |
| `has no password` / `has no username` | Ask the user to fill the secret in the vault. |
| `Authentication failed` | Ask the user to check the password in the vault. |
| `no way to open the vault` | See the [credentials](../credentials/SKILL.md) skill. |
| `sudo: ... incorrect password` | Ask the user to check the password of the sudo system. |
