"""The checks of a scenario."""
import re
import subprocess
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from ruleevals.runner import Judge
from ruleevals.scenario import CheckSpec
from ruleevals.transcript import Transcript

SHELL_TIMEOUT_S: int = 120


@dataclass(frozen=True)
class RunContext:
    """One finished run."""

    prompt: str
    transcript: Transcript
    fixture: Path


class Check(ABC):
    """One pass/fail check of a finished run."""

    @abstractmethod
    def passed(self, context: RunContext) -> bool:
        """Give True if the run passes the check."""


class ToolCheck(Check):
    """A regular expression over the tool calls: name and JSON input."""

    def __init__(self, spec: CheckSpec) -> None:
        self._pattern: re.Pattern[str] = re.compile(spec.value)
        self._expect_some: bool = spec.expect == "some"

    def passed(self, context: RunContext) -> bool:
        found: bool = any(self._pattern.search(call.text()) for call in context.transcript.tool_calls)
        return found == self._expect_some


class ReplyCheck(Check):
    """A regular expression over the final reply of the agent. It ignores the case; `^` matches each line."""

    def __init__(self, spec: CheckSpec) -> None:
        self._pattern: re.Pattern[str] = re.compile(spec.value, re.IGNORECASE | re.MULTILINE)
        self._expect_some: bool = spec.expect == "some"

    def passed(self, context: RunContext) -> bool:
        return (self._pattern.search(context.transcript.final_text) is not None) == self._expect_some


class FilesCheck(Check):
    """A glob in the fixture after the run."""

    def __init__(self, spec: CheckSpec) -> None:
        self._glob: str = spec.value
        self._expect_exists: bool = spec.expect == "exists"

    def passed(self, context: RunContext) -> bool:
        return any(context.fixture.glob(self._glob)) == self._expect_exists


class ShellCheck(Check):
    """A command in the fixture after the run. The exit code 0 is a pass."""

    def __init__(self, spec: CheckSpec) -> None:
        self._command: str = spec.value

    def passed(self, context: RunContext) -> bool:
        done: subprocess.CompletedProcess[bytes] = subprocess.run(
            self._command, shell=True, cwd=context.fixture, capture_output=True,
            timeout=SHELL_TIMEOUT_S, check=False,
        )  # fmt: skip
        return done.returncode == 0


class JudgeCheck(Check):
    """A yes/no question that a judge model answers."""

    def __init__(self, spec: CheckSpec, judge: Judge) -> None:
        self._question: str = spec.value
        self._expect_yes: bool = spec.expect == "yes"
        self._judge: Judge = judge

    def passed(self, context: RunContext) -> bool:
        return self._judge.ask(self._question, context.prompt, context.transcript.digest()) == self._expect_yes


def build_check(spec: CheckSpec, judge: Judge) -> Check:
    """Make the check of a spec."""
    if spec.type == "tool":
        return ToolCheck(spec)
    if spec.type == "reply":
        return ReplyCheck(spec)
    if spec.type == "files":
        return FilesCheck(spec)
    if spec.type == "shell":
        return ShellCheck(spec)
    return JudgeCheck(spec, judge)
