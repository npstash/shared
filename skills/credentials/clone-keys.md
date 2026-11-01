# Clone keys

Part of the [credentials](SKILL.md) skill. `TOOL` and the vault home are as SKILL.md says.
The rule credentials-from-vault applies to each step.

## 1. Enrol this clone

If the vault does not open (`no way to open the vault`), follow the rule
credentials-from-vault. To enrol this clone:

```bash
$TOOL/run.sh enrol                       # a generated name
```

1. It writes `recipients/<name>.pub` and the gitignored key file. It prints the name and the
   fingerprint. Without a terminal, it is a request. Tell the user if the keyring was
   used, from the `key` line.
2. Commit and push the `.pub` in the vault home repository.
3. Tell the user the name and the fingerprint. Ask the user to approve the request in a
   trusted clone: `run.sh approve-enrol <name>`.
4. After the approval, pull the vault home. Then the vault opens.

Do not copy a key file from another clone. Do not create or copy `master.key`.

## 2. Approve a request of another clone

Only if the user asks. Pull the vault home, then:

```bash
$TOOL/run.sh approve-enrol <name>
```

Compare the printed fingerprint with the fingerprint that the user gives. If they are
different, stop and tell the user. Else commit and push `recipients/<name>.master.enc`.

## 3. Unenrol this clone

Only if the user asks. It removes this clone from vaults without a new master key. The clone
knows the current master key: to lock a clone out, the user runs
`unenrol-and-rotate-master-key` in a terminal.

1. Find the vaults of this clone: each vault submodule in `.gitmodules` of the repository
   with a `clone.<name>.key` and a `recipients/<name>.pub`. Show the vault, the name, and "approved" if
   `recipients/<name>.master.enc` exists, else "request".
2. Ask the user which vaults to unenrol: one or more, or all.
3. Unenrol: `$TOOL/run.sh --vault-home <vault home> unenrol` for each vault.
4. Commit and push each changed vault home. Git uses its own credentials, not the vault.
5. If a push fails, run `git restore recipients/` in that vault home, then stop and tell the
   user. The vault still opens.
6. After each push: `$TOOL/run.sh --vault-home <vault home> delete-private-clone-key`.
7. Commit and push the submodule pointers in the root repository, if the user asks.

To unenrol another clone, the user gives the name: `$TOOL/run.sh unenrol <name>`, then commit
and push. Do not delete a private key of another clone.

## 4. Keys

- List the key passphrases in the OS keyring: `$TOOL/run.sh list-keyring-secrets`. Delete one
  only if the user asks: `$TOOL/run.sh delete-keyring-secret <name>`. Its key file stops working.

After each change in the vault home, commit and push it in the vault home repository.
