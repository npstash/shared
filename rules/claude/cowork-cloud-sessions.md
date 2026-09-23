---
id: claude/cowork-cloud-sessions
summary: In a Cowork cloud session reach GitHub over REST - GraphQL is blocked.
applies-to: claude-code
requires: []
related: []
---

# Cowork cloud sessions

Only in a Cowork **cloud** sandbox — `systemd-detect-virt` reports `docker` and no local
drive is mounted. On desktop and local sessions use `gh` normally.

`api.github.com/graphql` does not pass the egress proxy, so `gh pr create`, `gh pr list`,
`gh issue` and `gh repo view --json` fail. Use `gh api <rest/path>` or `curl` instead —
e.g. `POST /repos/{owner}/{repo}/pulls` to open a PR. `git push` over HTTPS is unaffected.
