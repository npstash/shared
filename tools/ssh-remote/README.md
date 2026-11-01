# tools/ssh-remote — remote Linux machines over SSH

Run commands on a remote Linux machine, and copy files to and from it. The credentials
come from the [vault](../auth/README.md). Code: [src/sshremote.py](src/sshremote.py).
Decisions: [ADL.md](ADL.md).

## Commands

```bash
run.sh exec --system NAME [--sudo --sudo-system NAME] -- CMD ...   # run CMD; the exit code is that of CMD
run.sh upload --system NAME LOCAL REMOTE [--sudo --sudo-system NAME]   # copy a local file to the host
run.sh download --system NAME REMOTE LOCAL                         # copy a file from the host
run.sh --vault NAME ...                                            # the vault, e.g. vault-main; necessary
run.sh --vault-home DIR ...                                        # or the folder of the vault
```

- `exec` writes the stdout and the stderr of the remote command.
- One argument after `--` is a shell command line, e.g. `-- 'ls | wc -l'`. More arguments
  are quoted one by one.
- `--system` and `--sudo-system` give the exact names of the vault systems. See "Vault entries".

## Vault entries

| System | Secrets | Example |
| --- | --- | --- |
| SSH system, with `url` `ssh://HOST[:PORT]` | `username`, `password` | `NUC15 SSH in LAN` |
| sudo system (optional) | `username`, `password` | `NUC15 SUDO` |

- The tool does not search the vault. The user gives the exact system names.
- `--sudo` needs `--sudo-system NAME`.

## Security

- The passwords go only to the SSH login and to the stdin of `sudo`. They are not in a
  command line, an environment variable, a file or the output.
- The tool logs in only with the password. It does not use SSH keys or an SSH agent.
- The tool accepts only host keys from `~/.ssh/known_hosts`. It does not write to that file.
  For an unknown host, the tool stops and gives the `ssh` command. Run it in a terminal,
  and compare the fingerprint before you accept it.

## sudo

- `--sudo` runs the command as root with `sudo -- sh -c CMD`.
- sudo asks for the password of the SSH user. The sudo system holds that password.
- The tool first runs `sudo -n true`. If sudo needs no password, the tool sends no
  password. Else it runs `sudo -k -S` and writes the password to the stdin of sudo.
- With a password, the remote command cannot read stdin.
- `upload --sudo` copies the file to `/tmp` on the host. Then it runs `cat` with sudo
  into the target, and deletes the temporary file. An existing target keeps its owner and mode.

## Python

`run.sh` adds `src/` and `../auth/src` to `PYTHONPATH`. Tests: `run.sh test`.
