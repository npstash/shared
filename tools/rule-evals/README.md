# rule-evals

This tool measures if an agent detects the trigger of a rule and follows the rule. The rule
rules-and-skills and the skill `eval-rule` use it.

## Method

- A scenario is a prompt with checks. The scenarios of a rule are in `rules/<id>/evals.toml` of its container.
- Each run starts headless Claude Code (`claude -p`) in a new copy of the repository.
- The copies are in `<repo>_evals/` beside the repository. A copy in the repository loads the
  `AGENTS.md` of the repository as a parent, and the result is wrong.
- The tool deletes `<repo>_evals/` at the end, also after an error.
- Claude Code makes a scratchpad folder for each copy in the temp folder of the system. The tool
  deletes these folders also.
- A copy has no vault files, no `evals.toml` files and a clean work tree.

## Isolation

- The Bash sandbox of Claude Code is on. It needs `bubblewrap` and `socat`.
- A shell command writes only into the copy. The network is blocked.
- The permission mode is `dontAsk`: the run denies each call that needs a confirmation.
- The file tools write only into the copy.
- The MCP servers, the user settings and the auto-memory are off.
- The checks and the `setup` commands of a scenario run outside the sandbox. Review them as code.

## Commands

```
run.sh eval --label <name> [--rules <id,id|all>] [--ruleset <git-ref|worktree>]
            [--models opus,sonnet] [--runs 3] [--parallel 4] [--judge-model opus]
            [--claude-bin <path>] [--budget-usd 2] [--timeout 900] [--keep]
run.sh report --label <name>
run.sh test
```

- `--ruleset` selects the rules: a git ref, or `worktree` for the files as they are.
- `--claude-bin` must be a Claude Code version that reads `AGENTS.md` (2.1.314 or later).
- The results are in `.local_assets/results/<label>/`: `results.jsonl`, `report.md`, `transcripts/`.
- The runs use the login of Claude Code on the machine.

## evals.toml

```toml
trigger_reads = ["skills/credentials/SKILL.md"]   # optional: a read of these files is also the trigger
trigger_skills = ["credentials"]                  # optional: a call of these skills is also the trigger

[[scenario]]
kind = "pressure"              # direct | indirect | pressure | negative
prompt = """..."""
setup = ["git checkout -q -B main"]   # optional: commands in the copy before the run
action = "git commit"                 # optional: a regular expression; a tool call that matches is an action

[[scenario.check]]
type = "tool"                  # a regular expression over the tool calls (name and JSON input)
pattern = "netrc"
expect = "none"                # none | some
```

| Kind | Content |
|---|---|
| `direct` | The prompt names the subject of the rule. |
| `indirect` | The trigger occurs in another task. The prompt does not name the subject. |
| `pressure` | The prompt pushes the agent to break the rule. |
| `negative` | The rule does not apply. A read of the rule is an unnecessary load. |

| Check | Key | `expect` |
|---|---|---|
| `tool` | `pattern` | `none`, `some` |
| `files` | `glob` in the copy | `exists`, `absent` |
| `shell` | `command` in the copy; exit code 0 is a pass | |
| `judge` | `question` to the judge model | `yes` (default), `no` |

## Report

- **Rule read**: the runs in which the agent read the rule file before its first action. An action
  is a write, an edit, or a tool call that matches `action`. `loaded` = an index imports the rule
  with `@`, or the rule is inline.
- **Passed**: the runs that pass all checks.
- **Launch tokens**: the input tokens of the first request.
