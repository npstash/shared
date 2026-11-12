"""The records of the runs and the report."""
import json
from dataclasses import asdict, dataclass
from pathlib import Path

from ruleevals.jsontypes import JsonObject, JsonValue, as_float, as_int, as_list, as_object, as_str
from ruleevals.trigger import LATE, LOADED, NO, YES


@dataclass(frozen=True)
class RunRecord:
    """The result of one run."""

    rule: str
    scenario: str
    kind: str
    model: str
    run: int
    trigger: str
    passed: bool
    failed_checks: tuple[str, ...]
    launch_tokens: int
    cost_usd: float
    error: str

    def to_json(self) -> str:
        return json.dumps(asdict(self))


def record_from_json(line: str) -> RunRecord:
    value: JsonValue = json.loads(line)
    data: JsonObject = as_object(value)
    return RunRecord(
        rule=as_str(data.get("rule")),
        scenario=as_str(data.get("scenario")),
        kind=as_str(data.get("kind")),
        model=as_str(data.get("model")),
        run=as_int(data.get("run")),
        trigger=as_str(data.get("trigger")),
        passed=data.get("passed") is True,
        failed_checks=tuple(as_str(item) for item in as_list(data.get("failed_checks"))),
        launch_tokens=as_int(data.get("launch_tokens")),
        cost_usd=as_float(data.get("cost_usd")),
        error=as_str(data.get("error")),
    )


def read_records(path: Path) -> list[RunRecord]:
    return [record_from_json(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _trigger_cell(records: list[RunRecord]) -> str:
    """Give the trigger of a group. For a negative scenario, a read of the rule is an unnecessary load."""
    values: list[str] = [record.trigger for record in records]
    if all(value == LOADED for value in values):
        return LOADED
    cell: str = f"{values.count(YES)}/{len(values)}"
    if values.count(LATE):
        cell += f" (+{values.count(LATE)} late)"
    return cell


def render_report(records: list[RunRecord]) -> str:
    """Give a Markdown table with one line for each rule, scenario and model."""
    groups: dict[tuple[str, str, str, str], list[RunRecord]] = {}
    for record in records:
        groups.setdefault((record.rule, record.scenario, record.kind, record.model), []).append(record)
    lines: list[str] = [
        "| Rule | Scenario | Model | Rule read | Passed | Errors | Launch tokens | Failed checks |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for (rule, scenario, _kind, model), group in sorted(groups.items()):
        good: list[RunRecord] = [record for record in group if not record.error]
        failed: list[str] = sorted({check for record in good for check in record.failed_checks})
        tokens: int = round(sum(record.launch_tokens for record in good) / len(good)) if good else 0
        lines.append(
            f"| {rule} | {scenario} | {model} | {_trigger_cell(good) if good else '-'} | "
            f"{sum(record.passed for record in good)}/{len(good)} | {len(group) - len(good)} | {tokens} | "
            f"{'<br>'.join(failed)} |"
        )
    lines.append("")
    lines.append(f"Runs: {len(records)}. Cost at list price: {sum(record.cost_usd for record in records):.2f} USD.")
    lines.append(f"Legend: '{LOADED}' = the rule is in the context from the start; '{NO}' reads count as 0.")
    return "\n".join(lines) + "\n"
