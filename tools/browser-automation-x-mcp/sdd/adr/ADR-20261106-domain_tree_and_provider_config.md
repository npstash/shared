# ADR-20261106-domain_tree_and_provider_config — sites.json as a domain tree, provider-config, approval attached to a key-value provider

- ADL entry: `20261106-16` to `20261106-23` in [ADL.md](../ADL.md)
- Name: Nestor
- Commit: 29c0c2f718c6
- Status: Accepted

## Context

A site key of `sites.json` is a host. It covers each subdomain ([ADL 20261104-19](../ADL.md)).
Discovery writes the exact host of each loaded page ([ADL 20261106-04](../ADL.md)). Thus one shop can
get two sites, e.g. `www.amazon.pl` with the pages and `amazon.pl` with the `credentials`. The
vault of `amazon.pl` applies to `www.amazon.pl`, but the file does not show it.

`credentials` holds only the vault system. Other providers cannot have a config for a site.

An approval provider wraps a key-value provider in its `provider` key ([ADL 20261106-01](../ADL.md)).
Thus the vault provider of a site config is hard to find in `server.json`.

## Options and evaluation

| Option | Evaluation |
| --- | --- |
| a) Keep flat sites; discovery writes the exact host | Two entries for one shop. The inheritance is not visible. |
| b) Discovery writes into the most specific site that covers the host | Pages of all subdomains go into one site. |
| c) A tree: root domains with `subdomains` | Each host has its own pages. The inheritance is visible. |

## Decision

### Domain tree

- A key of `sites` is a root domain: the registrable domain of the Public Suffix List, also for
  private suffixes (`user.github.io`). Use `tldts`. An IP address and `localhost` stay.
- A node has `access`, `provider-config`, `pages` and `subdomains`. A key of `subdomains` is the
  full host name of a subdomain of the node.
- `access` and `provider-config` go down the tree. The nearest value wins. For `provider-config`,
  this applies to each provider type separately.
- A `deny` of a node wins over an `allow` of a node below it.
- `pages` apply only to the node of the exact host.
- A site key that is not a root domain, a `subdomains` key outside its node, and `credentials` are
  load errors.

```json
"amazon.pl": {
  "access": "allow",
  "provider-config": { "vault": { "vault": "vault-main", "entry": "Amazon - Nestor" } },
  "subdomains": { "www.amazon.pl": { "pages": { ... } } }
}
```

### provider-config

- `provider-config` replaces `credentials`. It has one object for each provider type.
- The vault config is `{ "vault": "<vault>", "entry": "<system>" }`. It applies only to the vault
  provider with that `vault`. Both keys are necessary.
- A page can have `provider-config`. It wins over the host, only for that page.

### Discovery

- At a page load, discovery writes the root domain of the host with `"access": "allow"`.
- Discovery writes the pages into the node of the exact host. A missing node goes into `subdomains`
  of the nearest node that covers the host.

### Approval attached to a key-value provider

- An approval provider is the `approval` of the entry of a key-value provider in `server.json`:

```json
{ "type": "vault", "enabled": true, "mask": true, "vault": "vault-main",
  "approval": { "type": "approve-https", "address": "", "fingerprint": "" } }
```

- `"enabled": false` in `approval` turns the approval off.
- An approval provider in `providers` is a load error.
- The mask of the entry applies.

## Consequences

- These ADL entries change: 20261104-19, 20261104-20, 20261106-01, 20261106-02, 20261106-04,
  20261106-06 and 20261106-12. Add new entries; do not change the old entries.
- Change each `sites.json` to the tree and to `provider-config`. Change each approval entry of
  `server.json`.
- The tool has a new dependency, `tldts`. A new public suffix needs an update of `tldts`.
- The pages of a parent domain do not apply to its subdomains. Discovery writes them again for
  each subdomain.
- `"enabled": false` in `approval` lets the vault fill without approval.
