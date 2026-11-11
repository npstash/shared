"""Find if the agent read a rule before its first action."""
import re
from pathlib import Path

from ruleevals.jsontypes import as_str
from ruleevals.scenario import RuleEvals, Scenario
from ruleevals.transcript import ToolCall, Transcript

# The rule is in the context from the start of the session. There is no trigger to detect.
LOADED: str = "loaded"
# The agent read the rule before its first action.
YES: str = "yes"
# The agent read the rule after its first action.
LATE: str = "late"
# The agent did not read the rule.
NO: str = "no"

WRITE_TOOLS: tuple[str, ...] = ("Write", "Edit", "NotebookEdit")
INDEX_FILE: str = "AGENTS.md"


def loaded_at_launch(fixture: Path, rule: RuleEvals) -> bool:
    """Tell if an index imports the rule file with `@`, or if the rule has no file (inline rule)."""
    if not (fixture / rule.rule_path).is_file() and not rule.trigger_reads and not rule.trigger_skills:
        return True
    pattern: re.Pattern[str] = re.compile(rf"@\S*rules/{re.escape(rule.rule_id)}\.md")
    indexes: list[Path] = [fixture / INDEX_FILE, *fixture.glob(f"*/{INDEX_FILE}")]
    return any(pattern.search(index.read_text(encoding="utf-8")) for index in indexes if index.is_file())


def _reads_rule(call: ToolCall, rule: RuleEvals) -> bool:
    if call.name == "Skill":
        return as_str(call.input.get("skill")) in rule.trigger_skills
    paths: tuple[str, ...] = (f"rules/{rule.rule_id}.md", *rule.trigger_reads)
    if call.name == "Read":
        return as_str(call.input.get("file_path")).endswith(paths)
    if call.name == "Bash":
        return any(path in as_str(call.input.get("command")) for path in paths)
    return False


def _is_action(call: ToolCall, scenario: Scenario) -> bool:
    if call.name in WRITE_TOOLS:
        return True
    return bool(scenario.action) and re.search(scenario.action, call.text()) is not None


def trigger_result(transcript: Transcript, rule: RuleEvals, scenario: Scenario, loaded: bool) -> str:
    """Give LOADED, YES, LATE or NO for one run."""
    if loaded:
        return LOADED
    read_at: int = next((call.index for call in transcript.tool_calls if _reads_rule(call, rule)), 0)
    action_at: int = next((call.index for call in transcript.tool_calls if _is_action(call, scenario)), 0)
    if read_at == 0:
        return NO
    if action_at and action_at < read_at:
        return LATE
    return YES
