---
name: create-vault
description: Make a sub-vault of the credential vault - a blank one, or one with copies of selected systems of the main vault - and fill it. Use when the user asks for a smaller vault, e.g. for one project or for cloud clones. Triggers - "create a sub-vault", "new vault for project X", "vault for the cloud sessions", "/create-vault".
---

# Create a sub-vault

A sub-vault is a smaller vault in `subvaults/<name>/` of the vault home. It has its own master
key and recipients, and no passphrase. Design:
[clone-keys.md](../../tools/auth/docs/clone-keys.md), section "Sub-vaults".

`TOOL` is `tools/auth` next to the `skills/` folder of this skill:
`TOOL="$(realpath <skill folder>)/../../tools/auth"`.

## Requirements

- This clone opens the **main** vault with a clone key. Test it: `$TOOL/run.sh sync`. If it
  fails with `no way to open the vault`, use the `credentials` skill to enrol this clone first.
- You never need the passphrase for the steps below.

## 1. Ask the user

- The name of the sub-vault: letters, digits, `.`, `_`, `-`. Suggest the project name.
- The systems to copy from the main vault. Show `$TOOL/run.sh list`. A blank sub-vault is
  also possible.

## 2. Make it

```bash
$TOOL/run.sh create-vault <name> --system "<system 1>" --system "<system 2>"
$TOOL/run.sh create-vault <name>                     # blank
```

It writes `subvaults/<name>/` with `credentials.json`, `credentials.enc`, `main.master.enc`,
`source.hmac` and an empty `recipients/`. It enrols no clone.

## 3. Fill it

- **A system of the main vault:** add it to `subvaults/<name>/credentials.json` with blank
  secrets, e.g. copy its entry from the `list` output. Then run `$TOOL/run.sh sync`. The sync
  copies the values from the main vault.
- **A system only for the sub-vault:** ask the user to set the secret values in a terminal:
  `$TOOL/run.sh --subvault <name> set <system> --secret KEY=VALUE`. Do not put secret values
  into the chat or a file.

Later changes of the main vault go into the sub-vault with each `sync` in a clone that opens
the main vault.

## 4. Commit

Commit and push `subvaults/<name>/` in the vault home repository. The pre-commit hook stops a
commit with a secret value, a key file or the access log.

## 5. Next steps for the user

Tell the user how a clone gets access. The `credentials` skill does these steps:

1. In the clone: `$TOOL/run.sh --subvault <name> enrol`, then commit and push the request.
2. In a trusted clone: `$TOOL/run.sh --subvault <name> approve <recipient>`. Compare the
   fingerprint. Commit and push.

Scripts select the sub-vault with `get_credential("<system>", subvault="<name>")`.
