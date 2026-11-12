---
name: eval-rule
description: Measure if agents detect the trigger of a rule and follow the rule, with headless Claude Code runs. Use when you add a rule, or change the core, the trigger or the class of a rule, or when the user asks, e.g. "eval the rule X", "test the trigger of X".
---

# Evaluate a rule

Use the tool [rule-evals](../../tools/rule-evals/README.md). The README gives the format of
`evals.toml` and the commands.

## 1. Write the scenarios

Write `rules/<id>/evals.toml` beside the rule file. Write one scenario of each kind:

- `direct`: the prompt names the subject of the rule.
- `indirect`: the trigger occurs in another task. The prompt does not name the subject.
- `pressure`: the prompt pushes the agent to break the rule, but does not ask for it.
- `negative`: the rule does not apply.
- `override`: the prompt asks directly for the action that the rule forbids. The agent must
  do it and name the rule. Write it only for a rule that forbids an action.

For each scenario:

- Write a prompt that a user can write. Do not name the rule or its file.
- Give each design choice in the prompt. A headless run cannot answer a question.
- Make sure that the prompt agrees with the repository. If the prompt says that the code has
  a feature, the code must have it.
- Add checks that decide pass or fail without a model: `tool`, `reply`, `files`, `shell`.
  Use `judge` only if no other check can decide.
- Set `action` if the first relevant action is not a write, e.g. `git commit`.
- Do not use a scenario that can show a secret, e.g. a read of a token file.

Show the scenarios to the user. Get the confirmation before the first run.

## 2. Run

1. Get the confirmation of the user for each run. Give the number of runs. The tool writes
   copies beside the repository and deletes them at the end. This is a write outside the
   repository.
2. Run the baseline with the rule as it was: `run.sh eval --label <id>-base --rules <id>
   --ruleset <git-ref>`. For a new rule, use the commit before the rule.
3. Run the new rule: `run.sh eval --label <id>-new --rules <id> --ruleset worktree`.
4. Use the defaults of the tool: Sonnet, 3 runs, 4 in parallel. Use other models only if the
   user asks.

The runs use the usage limit of the plan of the user. If the tool reports
`usage_limit_reached`, stop and tell the user.

## 3. Report

Show the table of `run.sh report --label <label>` for both labels. Then give:

- the trigger rate: the runs that read the rule before the first action, for `direct` and
  `indirect`;
- the pass rate of each kind, and the difference to the baseline;
- the reads in `negative` runs;
- the launch tokens.

Read the transcript of each failed run before you report a cause. A failure can come from a
defect of the scenario.

## 4. If the rule fails

1. Propose one change of the core or the trigger. Get the confirmation of the user. Run
   again.
2. If the rule fails again, propose the class "always".
