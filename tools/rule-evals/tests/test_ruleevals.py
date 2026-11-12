"""Tests of rule-evals with a fake agent, a fake judge and a fake fixture maker."""
import json
import re
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path

import pytest

from ruleevals.binary import parse_version
from ruleevals.checks import RunContext, build_check
from ruleevals.evaluate import Evaluator, make_jobs
from ruleevals.fixture import FixtureMaker
from ruleevals.report import RunRecord, read_records, render_report
from ruleevals.runner import AgentRunner, Judge, parse_answer
from ruleevals.scenario import CheckSpec, RuleEvals, ScenarioError, find_rule_evals
from ruleevals.transcript import Transcript, parse_transcript
from ruleevals.trigger import LATE, LOADED, NO, YES, loaded_at_launch, trigger_result

TOOL_DIR: Path = Path(__file__).resolve().parents[1]

EVALS: str = '''
trigger_reads = ["skills/demo/SKILL.md"]
trigger_skills = ["demo"]

[[scenario]]
kind = "direct"
prompt = "Add a test."
action = "git commit"

[[scenario.check]]
type = "tool"
pattern = "netrc"
expect = "none"

[[scenario.check]]
type = "files"
glob = "made.txt"
expect = "exists"

[[scenario.check]]
type = "shell"
command = "test -f made.txt"

[[scenario.check]]
type = "judge"
question = "Did the agent ask?"
'''


def _tool(name: str, **tool_input: str) -> str:
    content: list[dict[str, object]] = [{"type": "tool_use", "name": name, "input": tool_input}]
    usage: dict[str, int] = {"input_tokens": 5, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 20}
    return json.dumps({"type": "assistant", "message": {"content": content, "usage": usage}})


def _result(text: str = "done") -> str:
    return json.dumps({"type": "result", "result": text, "is_error": False, "total_cost_usd": 0.5, "num_turns": 3})


def _repo(tmp_path: Path, evals: str = EVALS) -> Path:
    folder: Path = tmp_path / "repo" / "box" / "rules" / "claude" / "demo"
    folder.mkdir(parents=True)
    (folder / "evals.toml").write_text(evals, encoding="utf-8")
    (folder.parent / "demo.md").write_text("# Demo\n", encoding="utf-8")
    return tmp_path / "repo"


def _rule(tmp_path: Path) -> RuleEvals:
    return find_rule_evals(_repo(tmp_path))[0]


def test_find_rule_evals_gives_the_id_and_the_rule_path(tmp_path: Path) -> None:
    rule: RuleEvals = _rule(tmp_path)
    assert rule.rule_id == "claude/demo"
    assert rule.rule_path == "box/rules/claude/demo.md"
    assert rule.trigger_skills == ("demo",)
    assert [check.type for check in rule.scenarios[0].checks] == ["tool", "files", "shell", "judge"]
    assert rule.scenarios[0].checks[3].expect == "yes"


@pytest.mark.parametrize(
    "bad",
    [
        '[[scenario]]\nkind = "other"\nprompt = "x"',
        '[[scenario]]\nkind = "direct"',
        '[[scenario]]\nkind = "direct"\nprompt = "x"\n[[scenario.check]]\ntype = "tool"\npattern = "x"',
        '[[scenario]]\nkind = "direct"\nprompt = "x"\n[[scenario.check]]\ntype = "nope"',
        "",
    ],
)
def test_a_wrong_evals_file_is_an_error(tmp_path: Path, bad: str) -> None:
    with pytest.raises(ScenarioError):
        find_rule_evals(_repo(tmp_path, bad))


def test_parse_transcript_reads_calls_tokens_and_result() -> None:
    transcript: Transcript = parse_transcript(["not json", _tool("Read", file_path="/x/a.md"), _result("final")])
    assert [call.name for call in transcript.tool_calls] == ["Read"]
    assert transcript.launch_tokens == 125
    assert transcript.final_text == "final"
    assert transcript.cost_usd == 0.5
    assert not transcript.is_error


def test_a_transcript_with_no_result_is_an_error() -> None:
    assert parse_transcript([_tool("Read", file_path="/x/a.md")]).is_error


@pytest.mark.parametrize(
    ("lines", "expected"),
    [
        ([_tool("Read", file_path="/f/box/rules/claude/demo.md"), _tool("Write", file_path="/f/a")], YES),
        ([_tool("Write", file_path="/f/a"), _tool("Read", file_path="/f/box/rules/claude/demo.md")], LATE),
        ([_tool("Bash", command="git commit -m x"), _tool("Skill", skill="demo")], LATE),
        ([_tool("Skill", skill="demo")], YES),
        ([_tool("Bash", command="cat box/skills/demo/SKILL.md")], YES),
        ([_tool("Read", file_path="/f/box/rules/other.md"), _tool("Write", file_path="/f/a")], NO),
    ],
)
def test_trigger_result(tmp_path: Path, lines: list[str], expected: str) -> None:
    rule: RuleEvals = _rule(tmp_path)
    assert trigger_result(parse_transcript(lines), rule, rule.scenarios[0], False) == expected
    assert trigger_result(parse_transcript(lines), rule, rule.scenarios[0], True) == LOADED


def test_loaded_at_launch_finds_an_import_in_an_index(tmp_path: Path) -> None:
    repo: Path = _repo(tmp_path)
    rule: RuleEvals = find_rule_evals(repo)[0]
    (repo / "box" / "AGENTS.md").write_text("- **demo** - read [demo](rules/claude/demo.md)\n", encoding="utf-8")
    assert not loaded_at_launch(repo, rule)
    (repo / "box" / "AGENTS.md").write_text("- **demo** - @rules/claude/demo.md\n", encoding="utf-8")
    assert loaded_at_launch(repo, rule)


class FakeJudge(Judge):
    def __init__(self, answer: bool) -> None:
        self.answer: bool = answer

    def ask(self, question: str, prompt: str, digest: str) -> bool:
        return self.answer


@pytest.mark.parametrize(
    ("spec", "expected"),
    [
        (CheckSpec("tool", "netrc", "none"), False),
        (CheckSpec("tool", "netrc", "some"), True),
        (CheckSpec("files", "made.txt", "exists"), True),
        (CheckSpec("files", "*.nope", "absent"), True),
        (CheckSpec("shell", "test -f made.txt", "pass"), True),
        (CheckSpec("shell", "test -f nope.txt", "pass"), False),
        (CheckSpec("reply", "FINAL", "some"), True),
        (CheckSpec("reply", "credentials", "none"), True),
        (CheckSpec("judge", "Did it ask?", "yes"), True),
        (CheckSpec("judge", "Did it ask?", "no"), False),
    ],
)
def test_checks(tmp_path: Path, spec: CheckSpec, expected: bool) -> None:
    (tmp_path / "made.txt").write_text("x", encoding="utf-8")
    transcript: Transcript = parse_transcript([_tool("Read", file_path="/home/u/.netrc"), _result("final")])
    assert build_check(spec, FakeJudge(True)).passed(RunContext("prompt", transcript, tmp_path)) is expected


class FakeFixtureMaker(FixtureMaker):
    def __init__(self, repo: Path) -> None:
        self.repo: Path = repo
        self.cleaned: bool = False

    def prepare(self, ruleset: str) -> None:
        pass

    def reset(self, slot: int) -> Path:
        (self.repo / "made.txt").unlink(missing_ok=True)
        return self.repo

    def cleanup(self) -> None:
        self.cleaned = True


class FakeRunner(AgentRunner):
    """Reads the rule and makes the file only for the model `good`."""

    def run(self, prompt: str, model: str, cwd: Path, env: Mapping[str, str]) -> list[str]:
        if model == "broken":
            return []
        if model == "limit":
            return [json.dumps({"type": "result", "is_error": True, "api_error": "usage_limit_reached"})]
        if model == "good":
            (cwd / "made.txt").write_text("x", encoding="utf-8")
            return [_tool("Skill", skill="demo"), _tool("Write", file_path="made.txt"), _result()]
        return [_tool("Read", file_path="/home/u/.netrc"), _result()]


def test_evaluator_writes_a_record_for_each_run(tmp_path: Path) -> None:
    repo: Path = _repo(tmp_path)
    out_dir: Path = tmp_path / "out"
    evaluator: Evaluator = Evaluator(FakeFixtureMaker(repo), FakeRunner(), FakeJudge(True), out_dir, 1)
    records: list[RunRecord] = evaluator.run(make_jobs(find_rule_evals(repo), ["good", "bad", "broken"], 2))
    assert read_records(out_dir / "results.jsonl") == records
    by_model: dict[str, RunRecord] = {record.model: record for record in records}
    assert (by_model["good"].trigger, by_model["good"].passed) == (YES, True)
    assert (by_model["bad"].trigger, by_model["bad"].passed) == (NO, False)
    assert len(by_model["bad"].failed_checks) == 3
    assert by_model["broken"].error
    report: str = render_report(records)
    assert "| claude/demo | direct-1 | good | 2/2 | 2/2 | 0 | 125 |" in report
    assert "| claude/demo | direct-1 | bad | 0/2 | 0/2 | 0 |" in report
    assert "| claude/demo | direct-1 | broken | - | 0/0 | 2 |" in report


def test_static_types() -> None:
    """The static analysis: mypy in strict mode (rule typed-code)."""
    cache: Path = TOOL_DIR / ".local_assets" / "mypy-cache"
    command: list[str] = [sys.executable, "-m", "mypy", "--strict", "--cache-dir", str(cache), "src", "tests"]
    done: subprocess.CompletedProcess[str] = subprocess.run(command, cwd=TOOL_DIR, capture_output=True, text=True)
    assert done.returncode == 0, done.stdout


def test_no_explicit_any() -> None:
    pattern: re.Pattern[str] = re.compile(r"\bAny\b")
    files: list[Path] = [*(TOOL_DIR / "src").rglob("*.py"), *(TOOL_DIR / "tests").rglob("*.py")]
    found: list[str] = [str(path) for path in files if pattern.search(path.read_text(encoding="utf-8").replace("r\"\\bAny\\b\"", ""))]
    assert found == []


def test_evaluator_stops_at_the_usage_limit(tmp_path: Path) -> None:
    repo: Path = _repo(tmp_path)
    evaluator: Evaluator = Evaluator(FakeFixtureMaker(repo), FakeRunner(), FakeJudge(True), tmp_path / "out", 1)
    records: list[RunRecord] = evaluator.run(make_jobs(find_rule_evals(repo), ["limit", "good"], 1))
    assert "usage_limit_reached" in records[0].error
    assert records[1].error.startswith("skipped")


def test_make_jobs_selects_the_kinds(tmp_path: Path) -> None:
    rules: list[RuleEvals] = find_rule_evals(_repo(tmp_path))
    assert len(make_jobs(rules, ["m"], 2, ["direct"])) == 2
    assert make_jobs(rules, ["m"], 2, ["pressure"]) == []


@pytest.mark.parametrize(
    ("text", "expected"), [("2.1.322 (Claude Code)", (2, 1, 322)), ("claude 10.0.1", (10, 0, 1)), ("none", None)]
)
def test_parse_version(text: str, expected: tuple[int, int, int] | None) -> None:
    assert parse_version(text) == expected


@pytest.mark.parametrize(("text", "expected"), [("YES. It asked.", True), ("**Yes.** It asked.", True), ("no", False)])
def test_parse_answer(text: str, expected: bool) -> None:
    assert parse_answer(text) is expected


def test_parse_answer_needs_yes_or_no() -> None:
    with pytest.raises(RuntimeError):
        parse_answer("Maybe.")
