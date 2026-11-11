"""Types for JSON and TOML data."""
from typing import Union

JsonValue = Union[str, int, float, bool, None, list["JsonValue"], dict[str, "JsonValue"]]
JsonObject = dict[str, JsonValue]


def as_object(value: JsonValue) -> JsonObject:
    """Give the value if it is an object. Give an empty object if it is not."""
    return value if isinstance(value, dict) else {}


def as_list(value: JsonValue) -> list[JsonValue]:
    """Give the value if it is a list. Give an empty list if it is not."""
    return value if isinstance(value, list) else []


def as_str(value: JsonValue) -> str:
    """Give the value if it is a string. Give an empty string if it is not."""
    return value if isinstance(value, str) else ""


def as_int(value: JsonValue) -> int:
    """Give the value if it is an integer. Give 0 if it is not."""
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def as_float(value: JsonValue) -> float:
    """Give the value if it is a number. Give 0.0 if it is not."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    return float(value)
