# ADR-20261106-provider_kinds_and_matching — Provider kinds, value matching and discovery into sites.json

- ADL entry: `20261106-01` to `20261106-15` in [ADL.md](../ADL.md)
- Name: Nestor
- Commit: a5ea4caf7298
- Status: Accepted

## Context

Discovery writes the discovery file `discovered-sites.json` ([ADL 20261104-24](../ADL.md)). The
server never writes `sites.json` ([ADL 20261104-22](../ADL.md)). The recorder does not read the
values of the fields ([ADL 20261103-07](../ADL.md)).

Discovery gives each field a name from its attributes, e.g. `username` or the `name` attribute.
The provider must have a value with that name. Thus the user does these steps by hand:

- copy the entries from the discovery file into `sites.json`;
- change each field name to the key of the value in the provider;
- add the `credentials` of the site.

All providers have one kind. No provider can approve a fill, e.g. with a confirmation on a phone.

Goal: discovery is fully automatic. A run without discovery needs no manual configuration.

## Options and evaluation

| Option | Evaluation |
| --- | --- |
| a) Keep the discovery file; the user copies and renames | No change. The manual steps stay. |
| b) Discovery writes `sites.json`; the server matches the filled values to the keys of the providers | No copy and no rename. The server reads the values that the user fills. |

How a key-value provider gives its keys for matching:

| Option | Evaluation |
| --- | --- |
| a) `match(value, ctx)` gives the first key with that value | The values stay in the provider. |
| b) `list(ctx)` gives all keys and values | The server holds all secrets of the site in its memory. |

## Decision

### Provider kinds

- **Key-value provider:** has keys and values, e.g. `vault` and `values`. It has
  `match(value, ctx)`. This gives the first key with the value, or `undefined`.
- **Value provider:** gives a value for a key, but cannot list keys, e.g. `ask`.
- **Approval provider:** wraps one key-value provider. It gets the user approval, then gives the
  values of the wrapped provider. The entry in `server.json` holds the wrapped entry in `provider`:

```json
{ "type": "approve-https", "enabled": true, "address": "", "fingerprint": "",
  "provider": { "type": "vault", "mask": true, "vault": "vault-main" } }
```

- The mask of an approval provider is the mask of the wrapped entry.

### Matching

- In discovery, the page code sends the values of the fields that the user filled to the server at
  the submit. The server compares them and then discards them. It never logs or writes a value.
- Only key-value providers match, also the wrapped provider of an approval provider.
- The first provider in the order of `server.json` with a match gives the key.
- The vault provider matches only in the system of `credentials.vault` of the site or page.
- The server reads `sites.json` again before it matches.
- A field without a match gets the name from its attributes. A provider that is later in the order,
  also a value provider, can fill it.
- A field with a key keeps it. Only a new match changes it.

### Discovery writes sites.json

- Discovery writes into `sites.json` and only there. Remove the discovery file, `found` and the
  `used` marks. The log keeps the recorded events.
- When a page loads, discovery writes its host as a site with `"access": "allow"`, if the site is
  missing.
- Discovery writes only the fields that the user filled. The agent and the form fill do not add
  fields.
- Change the schema of `fields` to `{ "<selector>": "<key>" }`. A new key for a selector replaces
  the old key.
- Discovery writes the button that the user clicks on a page with fields of the user into `submit`.
- At a submit with Enter, discovery writes the submit button of the form. If the form has no submit
  button, it writes `"enter"`. A run without discovery then presses Enter in the last filled field.
- Discovery writes a link that the user follows into `login`, if the user then fills fields on the
  next page.
- Before each write, the server reads `sites.json` again and changes only its own entries.

### Fill in discovery

- Key-value providers fill. The wrapped provider of an approval provider fills without approval.
- Value providers do not fill.
- The server does not submit automatically.

### Approval providers

- `approve-dialog`: asks the user in a dialog of the MCP client (elicitation).
- `approve-https`: sends `POST <address>/approve` with `{ "host", "keys", "client" }`. It gets
  `{ "approved": true|false }`. It waits APPROVAL_TIMEOUT at most.
- `approve-https` pins the SHA-256 fingerprint of the certificate in `fingerprint`. It sends no
  authentication.
- `approve-https` refuses each request when `address` or `fingerprint` is empty, or the
  fingerprint is wrong.
- One approval covers all values of the approval provider for one fill of one form.
- The request shows the host, the keys and the client name. It never shows a value or the URL.
- A refusal, or no answer in APPROVAL_TIMEOUT, stops the fill with a `FillError`. No later provider
  fills the field.

### Approval service

- Add the project `projects/other/approve-provider-service` in the workspace repository.
- It approves each request.
- It uses Python with `http.server`, `ssl` and `cryptography`.
- At the first start, it makes a self-signed certificate in its `.local_assets/`. It shows the
  SHA-256 fingerprint.
- It listens on `127.0.0.1:8743`. The arguments `--host` and `--port` change this.

## Consequences

- These ADL entries change: 20261103-06, 20261103-07, 20261104-19, 20261104-22, 20261104-24 and
  20261104-25. Add new entries; do not change the old entries.
- Change each `sites.json` to the new `fields` schema. Delete each discovery file.
- The server process holds the values of the user for a short time. It must not log them.
- A site needs `credentials.vault` before the vault provider can match. The user adds it before
  the submit.
- The value of a field can match a wrong key, e.g. a username that is also an email.
- The approval service approves each request. It gives no protection. It is a placeholder for
  a service with real decisions.
- Discovery fills without approval. Use discovery only with a person at the browser.
