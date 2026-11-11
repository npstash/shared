"""The scenarios of a rule: the file `<container>/rules/<id>/evals.toml`."""
import tomllib
from dataclasses import dataclass
from pathlib import Path

from ruleevals.jsontypes import JsonObject, JsonValue, as_list, as_object, as_str

KINDS: tuple[str, ...] = ("direct", "indirect", "pressure", "negative", "override")
# The key that holds the value of each check type, and the permitted values of `expect`.
CHECK_KEYS: dict[str, str] = {
    "tool": "pattern", "reply": "pattern", "files": "glob", "shell": "command", "judge": "question",
}  # fmt: skip
CHECK_EXPECT: dict[str, tuple[str, ...]] = {
    "tool": ("none", "some"),
    "reply": ("some", "none"),
    "files": ("exists", "absent"),
    "shell": ("pass",),
    "judge": ("yes", "no"),
}
EVALS_FILE: str = "evals.toml"


class ScenarioError(ValueError):
    """An `evals.toml` file is not correct."""


@dataclass(frozen=True)
class CheckSpec:
    """One check of a scenario."""

    type: str
    value: str
    expect: str

    def label(self) -> str:
        return f"{self.type}:{self.expect}:{self.value}"


@dataclass(frozen=True)
class Scenario:
    """One prompt with its checks."""

    name: str
    kind: str
    prompt: str
    setup: tuple[str, ...]
    action: str
    env: tuple[tuple[str, str], ...]
    checks: tuple[CheckSpec, ...]


@dataclass(frozen=True)
class RuleEvals:
    """The scenarios of one rule."""

    rule_id: str
    rule_path: str
    trigger_reads: tuple[str, ...]
    trigger_skills: tuple[str, ...]
    scenarios: tuple[Scenario, ...]


def _strings(value: JsonValue) -> tuple[str, ...]:
    return tuple(as_str(item) for item in as_list(value))


def _check(data: JsonObject, where: str) -> CheckSpec:
    check_type: str = as_str(data.get("type"))
    if check_type not in CHECK_KEYS:
        raise ScenarioError(f"{where}: unknown check type '{check_type}'")
    value: str = as_str(data.get(CHECK_KEYS[check_type]))
    if not value:
        raise ScenarioError(f"{where}: check '{check_type}' needs '{CHECK_KEYS[check_type]}'")
    permitted: tuple[str, ...] = CHECK_EXPECT[check_type]
    expect: str = as_str(data.get("expect")) or (permitted[0] if check_type in ("shell", "judge", "reply") else "")
    if expect not in permitted:
        raise ScenarioError(f"{where}: check '{check_type}' needs expect = {' or '.join(permitted)}")
    return CheckSpec(check_type, value, expect)


def _scenario(data: JsonObject, index: int, where: str) -> Scenario:
    kind: str = as_str(data.get("kind"))
    if kind not in KINDS:
        raise ScenarioError(f"{where}: unknown kind '{kind}'")
    prompt: str = as_str(data.get("prompt")).strip()
    if not prompt:
        raise ScenarioError(f"{where}: scenario {index} has no prompt")
    env: JsonObject = as_object(data.get("env"))
    checks: tuple[CheckSpec, ...] = tuple(_check(as_object(item), where) for item in as_list(data.get("check")))
    return Scenario(
        name=as_str(data.get("name")) or f"{kind}-{index}",
        kind=kind,
        prompt=prompt,
        setup=_strings(data.get("setup")),
        action=as_str(data.get("action")),
        env=tuple((key, as_str(value)) for key, value in env.items()),
        checks=checks,
    )


def load_rule_evals(path: Path, rule_id: str, rule_path: str) -> RuleEvals:
    """Read one `evals.toml` file."""
    with path.open("rb") as file:
        data: JsonObject = tomllib.load(file)
    scenarios: tuple[Scenario, ...] = tuple(
        _scenario(as_object(item), index, str(path)) for index, item in enumerate(as_list(data.get("scenario")), 1)
    )
    if not scenarios:
        raise ScenarioError(f"{path}: no scenario")
    return RuleEvals(
        rule_id=rule_id,
        rule_path=rule_path,
        trigger_reads=_strings(data.get("trigger_reads")),
        trigger_skills=_strings(data.get("trigger_skills")),
        scenarios=scenarios,
    )


def find_rule_evals(repo: Path) -> list[RuleEvals]:
    """Find the `evals.toml` file of each rule in each container of the repository."""
    found: list[RuleEvals] = []
    for path in sorted(repo.glob(f"*/rules/**/{EVALS_FILE}")):
        parts: tuple[str, ...] = path.relative_to(repo).parts
        rule_id: str = "/".join(parts[2:-1])
        found.append(load_rule_evals(path, rule_id, f"{parts[0]}/rules/{rule_id}.md"))
    return found
