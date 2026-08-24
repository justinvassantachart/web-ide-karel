"""Strict portable Karel world v1 contract and explicit legacy converters.

This module is dependency-free and deliberately separate from runtime/protocol
state. It mirrors the public TypeScript contract in ``src/world-contract.ts``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Literal

KAREL_WORLD_SCHEMA_NAME = "web-ide-karel/world"
KAREL_WORLD_SCHEMA_VERSION = 1
MAX_KAREL_WORLD_DIMENSION = 100
MAX_KAREL_WORLD_ITEMS = 10_000
MAX_KAREL_WORLD_NAME_LENGTH = 256
MAX_SAFE_INTEGER = 9_007_199_254_740_991

Direction = Literal["north", "east", "south", "west"]
_DIRECTIONS: tuple[Direction, ...] = ("north", "east", "south", "west")
_COLOR_PATTERN = re.compile(
    r"^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|"
    r"#[0-9a-fA-F]{8}|[a-zA-Z]{1,24})$"
)
_CONTROL_CHARACTER_PATTERN = re.compile(r"[\x00-\x1f\x7f]")
_COORDINATE_KEY_PATTERN = re.compile(r"^([1-9]\d*),([1-9]\d*)$")
_WALL_PATTERN = re.compile(r"^([1-9]\d*),([1-9]\d*),(north|east|south|west)$")


class KarelWorldContractError(ValueError):
    """Raised when a portable world or explicit conversion input is invalid."""


@dataclass(frozen=True)
class KarelWorldConversionWarning:
    code: Literal[
        "standalone-id-omitted",
        "infinite-beeper-bag-assumed",
        "unsupported-corner-colors-empty",
    ]
    message: str


@dataclass(frozen=True)
class KarelWorldConversionResult:
    document: dict[str, Any]
    canonical_preview: str
    warnings: tuple[KarelWorldConversionWarning, ...]


def _strict_object(
    value: Any,
    field: str,
    required: tuple[str, ...],
    optional: tuple[str, ...] = (),
) -> dict[str, Any]:
    if type(value) is not dict:
        raise KarelWorldContractError(f"{field} must be a plain object")
    allowed = set(required + optional)
    missing = object()
    unknown = next(
        (key for key in value if type(key) is not str or key not in allowed), missing
    )
    if unknown is not missing:
        raise KarelWorldContractError(f"{field} contains unknown field {unknown}")
    for key in required:
        if key not in value:
            raise KarelWorldContractError(f"{field} is missing required field {key}")
    return value


def _strict_dynamic_object(value: Any, field: str) -> dict[str, Any]:
    if type(value) is not dict or not all(type(key) is str for key in value):
        raise KarelWorldContractError(f"{field} must be a plain string-keyed object")
    return value


def _strict_array(value: Any, field: str) -> list[Any]:
    if type(value) is not list:
        raise KarelWorldContractError(f"{field} must be a plain array")
    if len(value) > MAX_KAREL_WORLD_ITEMS:
        raise KarelWorldContractError(
            f"{field} exceeds the {MAX_KAREL_WORLD_ITEMS}-item limit"
        )
    return value


def _integer(value: Any, field: str, minimum: int = 1) -> int:
    if (
        type(value) is not int
        or value < minimum
        or value > MAX_SAFE_INTEGER
    ):
        raise KarelWorldContractError(
            f"{field} must be a safe integer greater than or equal to {minimum}"
        )
    return value


def _decimal_integer(value: str, field: str) -> int:
    if len(value) > 16:
        raise KarelWorldContractError(f"{field} must be a safe integer")
    return _integer(int(value), field)


def _dimension(value: Any, field: str) -> int:
    parsed = _integer(value, field)
    if parsed > MAX_KAREL_WORLD_DIMENSION:
        raise KarelWorldContractError(
            f"{field} cannot exceed {MAX_KAREL_WORLD_DIMENSION}"
        )
    return parsed


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _name(value: Any, field: str) -> str:
    if (
        type(value) is not str
        or not value.strip()
        or _utf16_length(value) > MAX_KAREL_WORLD_NAME_LENGTH
        or _CONTROL_CHARACTER_PATTERN.search(value)
    ):
        raise KarelWorldContractError(
            f"{field} must be a non-empty control-free string of at most "
            f"{MAX_KAREL_WORLD_NAME_LENGTH} characters"
        )
    return value


def _direction(value: Any, field: str) -> Direction:
    if value not in _DIRECTIONS:
        raise KarelWorldContractError(
            f"{field} must be north, east, south, or west"
        )
    return value


def _color(value: Any, field: str) -> str:
    if type(value) is not str or not _COLOR_PATTERN.fullmatch(value):
        raise KarelWorldContractError(
            f"{field} must be a safe named or hexadecimal color"
        )
    return value.lower()


def _location(
    raw: dict[str, Any],
    field: str,
    columns: int,
    rows: int,
) -> dict[str, int]:
    avenue = _integer(raw["avenue"], f"{field}.avenue")
    street = _integer(raw["street"], f"{field}.street")
    if avenue > columns or street > rows:
        raise KarelWorldContractError(
            f"{field} is outside the {columns}x{rows} world"
        )
    return {"avenue": avenue, "street": street}


def _location_key(value: dict[str, Any]) -> str:
    return f'{value["street"]},{value["avenue"]}'


def _canonical_wall(
    value: dict[str, Any],
    columns: int,
    rows: int,
    field: str,
) -> dict[str, Any]:
    direction = value["direction"]
    if direction == "east":
        if value["avenue"] == columns:
            raise KarelWorldContractError(f"{field} describes an implicit boundary wall")
        return value
    if direction == "west":
        if value["avenue"] == 1:
            raise KarelWorldContractError(f"{field} describes an implicit boundary wall")
        return {
            "avenue": value["avenue"] - 1,
            "street": value["street"],
            "direction": "east",
        }
    if direction == "north":
        if value["street"] == rows:
            raise KarelWorldContractError(f"{field} describes an implicit boundary wall")
        return value
    if value["street"] == 1:
        raise KarelWorldContractError(f"{field} describes an implicit boundary wall")
    return {
        "avenue": value["avenue"],
        "street": value["street"] - 1,
        "direction": "north",
    }


def parse_karel_world_body_v1(value: Any) -> dict[str, Any]:
    """Strictly parse and canonicalize a v1 world body."""

    raw = _strict_object(
        value,
        "world",
        ("name", "columns", "rows", "karel", "beepers", "walls", "colors"),
    )
    columns = _dimension(raw["columns"], "world.columns")
    rows = _dimension(raw["rows"], "world.rows")

    raw_karel = _strict_object(
        raw["karel"],
        "world.karel",
        ("avenue", "street", "direction", "beepersInBag"),
    )
    bag_value = raw_karel["beepersInBag"]
    bag: int | str = (
        "infinite"
        if bag_value == "infinite"
        else _integer(bag_value, "world.karel.beepersInBag", 0)
    )
    karel = {
        **_location(raw_karel, "world.karel", columns, rows),
        "direction": _direction(raw_karel["direction"], "world.karel.direction"),
        "beepersInBag": bag,
    }

    beeper_keys: set[str] = set()
    beepers: list[dict[str, Any]] = []
    for index, value_item in enumerate(_strict_array(raw["beepers"], "world.beepers")):
        field = f"world.beepers[{index}]"
        item = _strict_object(value_item, field, ("avenue", "street", "count"))
        parsed = {
            **_location(item, field, columns, rows),
            "count": _integer(item["count"], f"{field}.count"),
        }
        key = _location_key(parsed)
        if key in beeper_keys:
            raise KarelWorldContractError(f"{field} duplicates beeper corner {key}")
        beeper_keys.add(key)
        beepers.append(parsed)
    beepers.sort(key=lambda item: (item["street"], item["avenue"]))

    wall_keys: set[str] = set()
    walls: list[dict[str, Any]] = []
    for index, value_item in enumerate(_strict_array(raw["walls"], "world.walls")):
        field = f"world.walls[{index}]"
        item = _strict_object(value_item, field, ("avenue", "street", "direction"))
        parsed = _canonical_wall(
            {
                **_location(item, field, columns, rows),
                "direction": _direction(item["direction"], f"{field}.direction"),
            },
            columns,
            rows,
            field,
        )
        key = f'{_location_key(parsed)},{parsed["direction"]}'
        if key in wall_keys:
            raise KarelWorldContractError(f"{field} duplicates wall {key}")
        wall_keys.add(key)
        walls.append(parsed)
    walls.sort(key=lambda item: (item["street"], item["avenue"], item["direction"]))

    color_keys: set[str] = set()
    colors: list[dict[str, Any]] = []
    for index, value_item in enumerate(_strict_array(raw["colors"], "world.colors")):
        field = f"world.colors[{index}]"
        item = _strict_object(value_item, field, ("avenue", "street", "color"))
        parsed = {
            **_location(item, field, columns, rows),
            "color": _color(item["color"], f"{field}.color"),
        }
        key = _location_key(parsed)
        if key in color_keys:
            raise KarelWorldContractError(f"{field} duplicates color corner {key}")
        color_keys.add(key)
        colors.append(parsed)
    colors.sort(key=lambda item: (item["street"], item["avenue"]))

    return {
        "name": _name(raw["name"], "world.name"),
        "columns": columns,
        "rows": rows,
        "karel": karel,
        "beepers": beepers,
        "walls": walls,
        "colors": colors,
    }


def parse_karel_world_document(value: Any) -> dict[str, Any]:
    """Strictly parse and canonicalize a portable Karel world v1 envelope."""

    raw = _strict_object(value, "document", ("schema", "version", "world"))
    if raw["schema"] != KAREL_WORLD_SCHEMA_NAME:
        raise KarelWorldContractError(
            f"document.schema must be {KAREL_WORLD_SCHEMA_NAME}"
        )
    if type(raw["version"]) is not int or raw["version"] != KAREL_WORLD_SCHEMA_VERSION:
        raise KarelWorldContractError("unsupported Karel world schema version")
    return {
        "schema": KAREL_WORLD_SCHEMA_NAME,
        "version": KAREL_WORLD_SCHEMA_VERSION,
        "world": parse_karel_world_body_v1(raw["world"]),
    }


def canonicalize_karel_world_document(value: Any) -> dict[str, Any]:
    return parse_karel_world_document(value)


def serialize_karel_world_document(value: Any) -> str:
    return json.dumps(
        parse_karel_world_document(value),
        ensure_ascii=False,
        separators=(",", ":"),
    ) + "\n"


def _conversion_result(
    document: dict[str, Any],
    warnings: tuple[KarelWorldConversionWarning, ...],
) -> KarelWorldConversionResult:
    return KarelWorldConversionResult(
        document=document,
        canonical_preview=serialize_karel_world_document(document),
        warnings=warnings,
    )


def convert_bare_karel_world_to_document(value: Any) -> KarelWorldConversionResult:
    """Explicitly convert the companion's former bare world shape into v1."""

    document = parse_karel_world_document(
        {
            "schema": KAREL_WORLD_SCHEMA_NAME,
            "version": KAREL_WORLD_SCHEMA_VERSION,
            "world": value,
        }
    )
    return _conversion_result(document, ())


def convert_standalone_karel_world_to_document(
    value: Any,
) -> KarelWorldConversionResult:
    """Explicitly convert the documented standalone r/c/cols format into v1."""

    raw = _strict_object(
        value,
        "standaloneWorld",
        ("name", "rows", "cols", "karel", "walls", "beepers"),
        ("id",),
    )
    rows = _dimension(raw["rows"], "standaloneWorld.rows")
    columns = _dimension(raw["cols"], "standaloneWorld.cols")
    robot = _strict_object(
        raw["karel"], "standaloneWorld.karel", ("r", "c", "dir")
    )
    raw_beepers = _strict_dynamic_object(
        raw["beepers"], "standaloneWorld.beepers"
    )
    if len(raw_beepers) > MAX_KAREL_WORLD_ITEMS:
        raise KarelWorldContractError(
            "standaloneWorld.beepers exceeds the "
            f"{MAX_KAREL_WORLD_ITEMS}-item limit"
        )
    beepers: list[dict[str, Any]] = []
    for key, count_value in raw_beepers.items():
        match = _COORDINATE_KEY_PATTERN.fullmatch(key)
        if not match:
            raise KarelWorldContractError(
                f"standaloneWorld.beepers key {key} must use the street,avenue format"
            )
        beepers.append(
            {
                "street": _decimal_integer(
                    match[1], f"standaloneWorld.beepers.{key}.street"
                ),
                "avenue": _decimal_integer(
                    match[2], f"standaloneWorld.beepers.{key}.avenue"
                ),
                "count": _integer(count_value, f"standaloneWorld.beepers.{key}"),
            }
        )

    walls: list[dict[str, Any]] = []
    for index, wall_value in enumerate(
        _strict_array(raw["walls"], "standaloneWorld.walls")
    ):
        if type(wall_value) is not str:
            raise KarelWorldContractError(
                f"standaloneWorld.walls[{index}] must be a string"
            )
        match = _WALL_PATTERN.fullmatch(wall_value)
        if not match:
            raise KarelWorldContractError(
                f"standaloneWorld.walls[{index}] must use street,avenue,direction"
            )
        walls.append(
            {
                "street": _decimal_integer(
                    match[1], f"standaloneWorld.walls[{index}].street"
                ),
                "avenue": _decimal_integer(
                    match[2], f"standaloneWorld.walls[{index}].avenue"
                ),
                "direction": _direction(
                    match[3], f"standaloneWorld.walls[{index}].direction"
                ),
            }
        )

    document = parse_karel_world_document(
        {
            "schema": KAREL_WORLD_SCHEMA_NAME,
            "version": KAREL_WORLD_SCHEMA_VERSION,
            "world": {
                "name": _name(raw["name"], "standaloneWorld.name"),
                "columns": columns,
                "rows": rows,
                "karel": {
                    "avenue": _integer(robot["c"], "standaloneWorld.karel.c"),
                    "street": _integer(robot["r"], "standaloneWorld.karel.r"),
                    "direction": _direction(robot["dir"], "standaloneWorld.karel.dir"),
                    "beepersInBag": "infinite",
                },
                "beepers": beepers,
                "walls": walls,
                "colors": [],
            },
        }
    )
    warnings: list[KarelWorldConversionWarning] = []
    if "id" in raw:
        _name(raw["id"], "standaloneWorld.id")
        warnings.append(
            KarelWorldConversionWarning(
                code="standalone-id-omitted",
                message="The standalone world id is host metadata and was not included.",
            )
        )
    warnings.extend(
        (
            KarelWorldConversionWarning(
                code="infinite-beeper-bag-assumed",
                message=(
                    "The standalone format has no bag count; its unlimited bag was preserved."
                ),
            ),
            KarelWorldConversionWarning(
                code="unsupported-corner-colors-empty",
                message=(
                    "The standalone format has no corner colors; colors were set to empty."
                ),
            ),
        )
    )
    return _conversion_result(document, tuple(warnings))
