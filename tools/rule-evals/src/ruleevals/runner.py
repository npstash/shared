"""Run an agent on a prompt, and ask a judge model a question."""
import json
import os
import subprocess
from abc import ABC, abstractmethod
from collections.abc import Mapping
from pathlib import Path

from ruleevals.jsontypes import JsonObject, JsonValue, as_object, as_str

# The sandbox lets the shell commands of the agent write only into the fixture, and blocks the network.
# The file tools are outside the sandbox: the permission keys limit them.
RUN_SETTINGS: JsonObject = {
    "sandbox": {
        "enabled": True,
        "failIfUnavailable": True,
        "allowUnsandboxedCommands": False,
        "network": {"allowedDomains": [], "strictAllowlist": True},
    },
    "permissions": {"blockWritesOutsideWorkingDirectories": True, "allow": ["Edit", "Write"]},
    "autoMemoryEnabled": False,
}
# Variables of a parent agent session. They must not reach the run.
DROPPED_ENV: tuple[str, ...] = ("CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE", "CLAUDE_CODE_SSE_PORT")
JUDGE_SYSTEM: str = (
    "You evaluate a transcript of a coding agent. Answer the question about the transcript. "
    "Write YES or NO as the first word. Then write one sentence with the reason."
)


def parse_answer(text: str) -> bool:
    """Give True for an answer that starts with YES. Ignore Markdown marks before the word."""
    answer: str = text.upper().lstrip(" *_#>`\n\t")
    if not answer.startswith(("YES", "NO")):
        raise RuntimeError(f"the judge gave no YES or NO: {answer[:200]}")
    return answer.startswith("YES")


class AgentRunner(ABC):
    """Runs an agent in a fixture."""

    @abstractmethod
    def run(self, prompt: str, model: str, cwd: Path, env: Mapping[str, str]) -> list[str]:
        """Run the agent. Give the stream-json lines of the run."""


class Judge(ABC):
    """Answers a yes/no question about a run."""

    @abstractmethod
    def ask(self, question: str, prompt: str, digest: str) -> bool:
        """Give True for the answer yes."""


def _base_env(extra: Mapping[str, str]) -> dict[str, str]:
    env: dict[str, str] = {key: value for key, value in os.environ.items() if key not in DROPPED_ENV}
    env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
    env.update(extra)
    return env


class ClaudeCliRunner(AgentRunner):
    """Runs `claude -p` in the sandbox, with no permission prompts."""

    def __init__(self, binary: str, settings_file: Path, budget_usd: float, timeout_s: int) -> None:
        self._binary: str = binary
        self._settings_file: Path = settings_file
        self._budget_usd: float = budget_usd
        self._timeout_s: int = timeout_s
        settings_file.parent.mkdir(parents=True, exist_ok=True)
        settings_file.write_text(json.dumps(RUN_SETTINGS), encoding="utf-8")

    def run(self, prompt: str, model: str, cwd: Path, env: Mapping[str, str]) -> list[str]:
        command: list[str] = [
            self._binary, "-p", prompt, "--model", model,
            "--permission-mode", "dontAsk", "--permission-prompts", "none",
            "--setting-sources", "project", "--strict-mcp-config",
            "--settings", str(self._settings_file),
            "--output-format", "stream-json", "--verbose", "--no-session-persistence",
            "--max-budget-usd", str(self._budget_usd),
        ]  # fmt: skip
        try:
            done: subprocess.CompletedProcess[str] = subprocess.run(
                command, cwd=cwd, env=_base_env(env), stdin=subprocess.DEVNULL,
                capture_output=True, text=True, timeout=self._timeout_s, check=False,
            )  # fmt: skip
        except subprocess.TimeoutExpired:
            return []
        return done.stdout.splitlines()


class ClaudeCliJudge(Judge):
    """Asks a model with no tools and no project context."""

    def __init__(self, binary: str, model: str, cwd: Path, timeout_s: int) -> None:
        self._binary: str = binary
        self._model: str = model
        self._cwd: Path = cwd
        self._timeout_s: int = timeout_s

    def ask(self, question: str, prompt: str, digest: str) -> bool:
        text: str = f"USER PROMPT TO THE AGENT:\n{prompt}\n\n{digest}\n\nQUESTION: {question}"
        command: list[str] = [
            self._binary, "-p", text, "--model", self._model, "--tools", "",
            "--system-prompt", JUDGE_SYSTEM, "--setting-sources", "project", "--strict-mcp-config",
            "--disable-slash-commands", "--output-format", "json", "--no-session-persistence",
        ]  # fmt: skip
        done: subprocess.CompletedProcess[str] = subprocess.run(
            command, cwd=self._cwd, env=_base_env({}), stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=self._timeout_s, check=False,
        )  # fmt: skip
        try:
            value: JsonValue = json.loads(done.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"the judge gave no JSON: {done.stdout[:200]} {done.stderr[:200]}") from error
        return parse_answer(as_str(as_object(value).get("result")))
