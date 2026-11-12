"""Command line of rule-evals. See README.md."""
import argparse
import subprocess
import sys
from pathlib import Path

from ruleevals.binary import AUTO, find_claude_binary
from ruleevals.evaluate import Evaluator, make_jobs
from ruleevals.fixture import WORKTREE, CopyFixtureMaker
from ruleevals.report import read_records, render_report
from ruleevals.runner import ClaudeCliJudge, ClaudeCliRunner
from ruleevals.scenario import RuleEvals, find_rule_evals

TOOL_DIR: Path = Path(__file__).resolve().parents[2]
RESULTS_DIR: Path = TOOL_DIR / ".local_assets" / "results"


def _repo_root() -> Path:
    """Give the top repository that contains the current folder."""
    top: str = subprocess.run(
        ["git", "rev-parse", "--show-superproject-working-tree", "--show-toplevel"],
        capture_output=True, text=True, check=True,
    ).stdout.splitlines()[0]  # fmt: skip
    return Path(top)


def _parser() -> argparse.ArgumentParser:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(prog="run.sh")
    commands = parser.add_subparsers(dest="command", required=True)
    evaluate: argparse.ArgumentParser = commands.add_parser("eval", help="run the scenarios")
    evaluate.add_argument("--label", required=True, help="name of the result folder")
    evaluate.add_argument("--rules", default="all", help="rule ids with commas, or all")
    evaluate.add_argument("--ruleset", default=WORKTREE, help=f"a git ref, or {WORKTREE}")
    evaluate.add_argument("--models", default="opus,sonnet")
    evaluate.add_argument("--runs", type=int, default=3)
    evaluate.add_argument("--parallel", type=int, default=4)
    evaluate.add_argument("--judge-model", default="opus")
    evaluate.add_argument("--kinds", default="all", help="scenario kinds with commas, or all")
    evaluate.add_argument("--claude-bin", default=AUTO, help=f"a path, or {AUTO}")
    evaluate.add_argument("--budget-usd", type=float, default=2.0, help="limit of one run")
    evaluate.add_argument("--timeout", type=int, default=900, help="seconds for one run")
    evaluate.add_argument("--repo", type=Path, default=None)
    evaluate.add_argument("--keep", action="store_true", help="do not delete the fixtures")
    report: argparse.ArgumentParser = commands.add_parser("report", help="print the report of a result folder")
    report.add_argument("--label", required=True)
    return parser


def _select(rules: list[RuleEvals], ids: str) -> list[RuleEvals]:
    if ids == "all":
        return rules
    wanted: list[str] = ids.split(",")
    missing: list[str] = [rule_id for rule_id in wanted if rule_id not in {rule.rule_id for rule in rules}]
    if missing:
        raise SystemExit(f"no evals.toml for: {', '.join(missing)}")
    return [rule for rule in rules if rule.rule_id in wanted]


def main(argv: list[str]) -> int:
    args: argparse.Namespace = _parser().parse_args(argv)
    label: str = args.label
    out_dir: Path = RESULTS_DIR / label
    if args.command == "report":
        print(render_report(read_records(out_dir / "results.jsonl")))
        return 0
    if out_dir.exists():
        raise SystemExit(f"{out_dir} exists; use another label")
    repo_arg: Path | None = args.repo
    repo: Path = repo_arg.resolve() if repo_arg else _repo_root()
    rules: list[RuleEvals] = _select(find_rule_evals(repo), args.rules)
    models: str = args.models
    claude_bin: str = args.claude_bin
    binary: str = find_claude_binary() if claude_bin == AUTO else claude_bin
    print(f"Claude Code: {binary}", flush=True)
    kinds: str = args.kinds
    timeout: int = args.timeout
    maker: CopyFixtureMaker = CopyFixtureMaker(repo)
    try:
        maker.prepare(args.ruleset)
        runner: ClaudeCliRunner = ClaudeCliRunner(binary, out_dir / "settings.json", args.budget_usd, timeout)
        judge: ClaudeCliJudge = ClaudeCliJudge(binary, args.judge_model, maker.home, timeout)
        evaluator: Evaluator = Evaluator(maker, runner, judge, out_dir, args.parallel)
        records = evaluator.run(make_jobs(rules, models.split(","), args.runs, None if kinds == "all" else kinds.split(",")))
    finally:
        if not args.keep:
            maker.cleanup()
    report_text: str = render_report(records)
    (out_dir / "report.md").write_text(report_text, encoding="utf-8")
    print(report_text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
