"""Read the stream-json output of a headless agent run."""
import json
from collections.abc import Iterable
from dataclasses import dataclass

from ruleevals.jsontypes import JsonObject, JsonValue, as_float, as_int, as_list, as_object, as_str

DIGEST_CALL_CHARS: int = 400
DIGEST_TEXT_CHARS: int = 6000


@dataclass(frozen=True)
class ToolCall:
    """One tool call of the agent, in the sequence of the run."""

    index: int
    name: str
    input: JsonObject

    def text(self) -> str:
        return f"{self.name} {json.dumps(self.input, sort_keys=True)}"


@dataclass(frozen=True)
class Transcript:
    """The data of one run that the checks and the report use."""

    tool_calls: tuple[ToolCall, ...]
    final_text: str
    launch_tokens: int
    cost_usd: float
    num_turns: int
    is_error: bool

    def digest(self) -> str:
        """Give a short text of the run for a judge."""
        calls: list[str] = [f"{call.index}. {call.text()[:DIGEST_CALL_CHARS]}" for call in self.tool_calls]
        return "TOOL CALLS:\n" + "\n".join(calls) + "\n\nFINAL REPLY:\n" + self.final_text[:DIGEST_TEXT_CHARS]


def _usage_tokens(usage: JsonObject) -> int:
    keys: tuple[str, ...] = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
    return sum(as_int(usage.get(key)) for key in keys)


def parse_transcript(lines: Iterable[str]) -> Transcript:
    """Parse the lines. Ignore each line that is not a JSON object."""
    calls: list[ToolCall] = []
    final_text: str = ""
    launch_tokens: int = 0
    cost_usd: float = 0.0
    num_turns: int = 0
    is_error: bool = True
    for line in lines:
        try:
            value: JsonValue = json.loads(line)
        except json.JSONDecodeError:
            continue
        event: JsonObject = as_object(value)
        kind: str = as_str(event.get("type"))
        if kind == "assistant":
            message: JsonObject = as_object(event.get("message"))
            if launch_tokens == 0:
                launch_tokens = _usage_tokens(as_object(message.get("usage")))
            for item in as_list(message.get("content")):
                block: JsonObject = as_object(item)
                if as_str(block.get("type")) == "tool_use":
                    calls.append(ToolCall(len(calls) + 1, as_str(block.get("name")), as_object(block.get("input"))))
                elif as_str(block.get("type")) == "text":
                    final_text = as_str(block.get("text"))
        elif kind == "result":
            final_text = as_str(event.get("result")) or final_text
            cost_usd = as_float(event.get("total_cost_usd"))
            num_turns = as_int(event.get("num_turns"))
            is_error = event.get("is_error") is not False
    return Transcript(tuple(calls), final_text, launch_tokens, cost_usd, num_turns, is_error)
