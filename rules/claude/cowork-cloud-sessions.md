# Cowork cloud sessions

Applies only in a Cowork **cloud** sandbox: `systemd-detect-virt` gives `docker`, and no
local drive is mounted. In other sessions, use `gh` normally.

The egress proxy blocks `api.github.com/graphql`, so `gh pr create`, `gh pr list`,
`gh issue` and `gh repo view --json` fail. Use `gh api <rest/path>` or `curl`, e.g.
`POST /repos/{owner}/{repo}/pulls` for a PR. `git push` over HTTPS works.
