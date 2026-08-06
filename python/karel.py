"""A small, dependency-free Karel runtime for browser-hosted Python sessions.

The module communicates world snapshots through an ANSI OSC frame. Terminal
emulators ignore the private OSC command, while Web IDE's Karel companion can
decode it from the ordinary stdout event stream. User stdout is not captured or
rewritten.
"""

from __future__ import annotations

import base64
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal, Mapping, TextIO

Direction = Literal["north", "east", "south", "west"]
Color = str

PROTOCOL_NAME = "web-ide-karel"
PROTOCOL_VERSION = 1
PROTOCOL_OSC_CODE = 777
PROTOCOL_OSC_PREFIX = f"\x1b]{PROTOCOL_OSC_CODE};{PROTOCOL_NAME};"
PROTOCOL_OSC_END = "\x07"

_DIRECTIONS: tuple[Direction, ...] = ("north", "east", "south", "west")
_DELTAS: dict[Direction, tuple[int, int]] = {
    "north": (0, 1),
    "east": (1, 0),
    "south": (0, -1),
    "west": (-1, 0),
}
_OPPOSITE: dict[Direction, Direction] = {
    "north": "south",
    "east": "west",
    "south": "north",
    "west": "east",
}
_COLOR_PATTERN = re.compile(r"^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,24})$")
_MAX_WORLD_DIMENSION = 100
_MAX_WORLD_ITEMS = 10_000


class KarelError(RuntimeError):
    """Base class for errors caused by an invalid Karel action."""


class KarelWorldError(KarelError):
    """Raised when a world file is malformed."""


class KarelBlockedError(KarelError):
    """Raised when Karel tries to move through a wall or world boundary."""


class NoBeeperError(KarelError):
    """Raised when Karel tries to pick up a beeper from an empty corner."""


class EmptyBeeperBagError(KarelError):
    """Raised when Karel tries to put down a beeper with an empty bag."""


@dataclass(frozen=True)
class Wall:
    avenue: int
    street: int
    direction: Direction


@dataclass
class KarelState:
    avenue: int
    street: int
    direction: Direction
    beepers_in_bag: int | None


@dataclass
class KarelWorld:
    name: str
    columns: int
    rows: int
    karel: KarelState
    beepers: dict[tuple[int, int], int]
    walls: set[Wall]
    colors: dict[tuple[int, int], Color]

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "KarelWorld":
        columns = _positive_int(raw.get("columns"), "columns")
        rows = _positive_int(raw.get("rows"), "rows")
        if columns > _MAX_WORLD_DIMENSION or rows > _MAX_WORLD_DIMENSION:
            raise KarelWorldError(
                "world dimensions cannot exceed "
                f"{_MAX_WORLD_DIMENSION}x{_MAX_WORLD_DIMENSION}"
            )
        name_value = raw.get("name", "Karel World")
        if not isinstance(name_value, str) or not name_value.strip():
            raise KarelWorldError("name must be a non-empty string")

        raw_karel = raw.get("karel")
        if not isinstance(raw_karel, Mapping):
            raise KarelWorldError("karel must be an object")
        avenue = _positive_int(raw_karel.get("avenue"), "karel.avenue")
        street = _positive_int(raw_karel.get("street"), "karel.street")
        _assert_corner(avenue, street, columns, rows, "karel")
        direction = _direction(raw_karel.get("direction"), "karel.direction")
        bag_value = raw_karel.get("beepersInBag", "infinite")
        if bag_value == "infinite":
            beepers_in_bag: int | None = None
        elif isinstance(bag_value, int) and not isinstance(bag_value, bool) and bag_value >= 0:
            beepers_in_bag = bag_value
        else:
            raise KarelWorldError(
                'karel.beepersInBag must be a non-negative integer or "infinite"'
            )

        beepers: dict[tuple[int, int], int] = {}
        for index, value in enumerate(_object_list(raw.get("beepers", []), "beepers")):
            beeper_avenue = _positive_int(value.get("avenue"), f"beepers[{index}].avenue")
            beeper_street = _positive_int(value.get("street"), f"beepers[{index}].street")
            _assert_corner(
                beeper_avenue,
                beeper_street,
                columns,
                rows,
                f"beepers[{index}]",
            )
            count = _positive_int(value.get("count"), f"beepers[{index}].count")
            corner = (beeper_avenue, beeper_street)
            beepers[corner] = beepers.get(corner, 0) + count

        walls: set[Wall] = set()
        for index, value in enumerate(_object_list(raw.get("walls", []), "walls")):
            wall_avenue = _positive_int(value.get("avenue"), f"walls[{index}].avenue")
            wall_street = _positive_int(value.get("street"), f"walls[{index}].street")
            _assert_corner(
                wall_avenue,
                wall_street,
                columns,
                rows,
                f"walls[{index}]",
            )
            wall_direction = _direction(value.get("direction"), f"walls[{index}].direction")
            walls.add(Wall(wall_avenue, wall_street, wall_direction))

        colors: dict[tuple[int, int], Color] = {}
        for index, value in enumerate(_object_list(raw.get("colors", []), "colors")):
            color_avenue = _positive_int(value.get("avenue"), f"colors[{index}].avenue")
            color_street = _positive_int(value.get("street"), f"colors[{index}].street")
            _assert_corner(
                color_avenue,
                color_street,
                columns,
                rows,
                f"colors[{index}]",
            )
            corner_color = _color(value.get("color"), f"colors[{index}].color")
            colors[(color_avenue, color_street)] = corner_color

        return cls(
            name=name_value,
            columns=columns,
            rows=rows,
            karel=KarelState(avenue, street, direction, beepers_in_bag),
            beepers=beepers,
            walls=walls,
            colors=colors,
        )

    @classmethod
    def load(cls, path: str | Path) -> "KarelWorld":
        world_path = Path(path)
        try:
            raw = json.loads(world_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise KarelWorldError(f"Could not load Karel world {world_path}: {error}") from error
        if not isinstance(raw, Mapping):
            raise KarelWorldError("A Karel world must be a JSON object")
        return cls.from_dict(raw)

    def is_blocked(self, avenue: int, street: int, direction: Direction) -> bool:
        delta_avenue, delta_street = _DELTAS[direction]
        next_avenue = avenue + delta_avenue
        next_street = street + delta_street
        if not (1 <= next_avenue <= self.columns and 1 <= next_street <= self.rows):
            return True
        return (
            Wall(avenue, street, direction) in self.walls
            or Wall(next_avenue, next_street, _OPPOSITE[direction]) in self.walls
        )

    def to_dict(self) -> dict[str, Any]:
        bag: int | str = (
            "infinite" if self.karel.beepers_in_bag is None else self.karel.beepers_in_bag
        )
        return {
            "name": self.name,
            "columns": self.columns,
            "rows": self.rows,
            "karel": {
                "avenue": self.karel.avenue,
                "street": self.karel.street,
                "direction": self.karel.direction,
                "beepersInBag": bag,
            },
            "beepers": [
                {"avenue": avenue, "street": street, "count": count}
                for (avenue, street), count in sorted(self.beepers.items())
                if count > 0
            ],
            "walls": [
                {
                    "avenue": wall.avenue,
                    "street": wall.street,
                    "direction": wall.direction,
                }
                for wall in sorted(
                    self.walls,
                    key=lambda item: (item.street, item.avenue, item.direction),
                )
            ],
            "colors": [
                {"avenue": avenue, "street": street, "color": color}
                for (avenue, street), color in sorted(self.colors.items())
            ],
        }


_world: KarelWorld | None = None
_sequence = 0
_protocol_stream: TextIO = sys.stdout


def _positive_int(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise KarelWorldError(f"{field} must be a positive integer")
    return value


def _direction(value: Any, field: str) -> Direction:
    if value not in _DIRECTIONS:
        raise KarelWorldError(f"{field} must be one of {', '.join(_DIRECTIONS)}")
    return value


def _color(value: Any, field: str) -> Color:
    if not isinstance(value, str) or not _COLOR_PATTERN.fullmatch(value):
        raise KarelWorldError(
            f"{field} must be a named color or a 3- to 8-digit hexadecimal color"
        )
    return value


def _object_list(value: Any, field: str) -> list[Mapping[str, Any]]:
    if not isinstance(value, list):
        raise KarelWorldError(f"{field} must be an array")
    if len(value) > _MAX_WORLD_ITEMS:
        raise KarelWorldError(f"{field} exceeds the {_MAX_WORLD_ITEMS}-item limit")
    if not all(isinstance(item, Mapping) for item in value):
        raise KarelWorldError(f"every item in {field} must be an object")
    return value


def _assert_corner(
    avenue: int,
    street: int,
    columns: int,
    rows: int,
    field: str,
) -> None:
    if avenue > columns or street > rows:
        raise KarelWorldError(
            f"{field} corner ({avenue}, {street}) is outside the {columns}x{rows} world"
        )


def _default_world_path() -> Path:
    candidates = (
        Path("karel_world.json"),
        Path("worlds/default.json"),
        Path(__file__).resolve().with_name("worlds") / "default.json",
        Path(__file__).resolve().parent.parent / "worlds" / "default.json",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def _emit(event_type: str, **payload: Any) -> None:
    global _sequence
    frame = {
        "protocol": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "type": event_type,
        "sequence": _sequence,
        **payload,
    }
    _sequence += 1
    encoded = base64.urlsafe_b64encode(
        json.dumps(frame, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).decode("ascii")
    _protocol_stream.write(f"{PROTOCOL_OSC_PREFIX}{encoded}{PROTOCOL_OSC_END}")
    _protocol_stream.flush()


def _emit_state(action: str) -> None:
    _emit("state", action=action, world=_require_world().to_dict())


def _require_world() -> KarelWorld:
    if _world is None:
        raise KarelError("Karel has no world. Call run_karel(main) or set_world(...) first.")
    return _world


def set_world(world: str | Path | Mapping[str, Any] | KarelWorld) -> None:
    """Replace the current world and publish its initial state."""

    global _world, _sequence
    if isinstance(world, KarelWorld):
        next_world = world
    elif isinstance(world, (str, Path)):
        next_world = KarelWorld.load(world)
    elif isinstance(world, Mapping):
        next_world = KarelWorld.from_dict(world)
    else:
        raise KarelWorldError("world must be a path, mapping, or KarelWorld")
    _world = next_world
    _sequence = 0
    _emit_state("load")


def get_world() -> KarelWorld:
    """Return the active mutable world for advanced exercises and tests."""

    return _require_world()


def move() -> None:
    world = _require_world()
    state = world.karel
    if world.is_blocked(state.avenue, state.street, state.direction):
        raise KarelBlockedError("Karel cannot move: the front is blocked")
    delta_avenue, delta_street = _DELTAS[state.direction]
    state.avenue += delta_avenue
    state.street += delta_street
    _emit_state("move")


def turn_left() -> None:
    state = _require_world().karel
    state.direction = _DIRECTIONS[(_DIRECTIONS.index(state.direction) - 1) % 4]
    _emit_state("turn_left")


def pick_beeper() -> None:
    world = _require_world()
    corner = (world.karel.avenue, world.karel.street)
    count = world.beepers.get(corner, 0)
    if count <= 0:
        raise NoBeeperError("Karel cannot pick a beeper: this corner is empty")
    if count == 1:
        world.beepers.pop(corner, None)
    else:
        world.beepers[corner] = count - 1
    if world.karel.beepers_in_bag is not None:
        world.karel.beepers_in_bag += 1
    _emit_state("pick_beeper")


def put_beeper() -> None:
    world = _require_world()
    if world.karel.beepers_in_bag == 0:
        raise EmptyBeeperBagError("Karel cannot put a beeper: the beeper bag is empty")
    corner = (world.karel.avenue, world.karel.street)
    world.beepers[corner] = world.beepers.get(corner, 0) + 1
    if world.karel.beepers_in_bag is not None:
        world.karel.beepers_in_bag -= 1
    _emit_state("put_beeper")


def paint_corner(color: Color) -> None:
    try:
        safe_color = _color(color, "paint_corner(color)")
    except KarelWorldError as error:
        raise KarelError(str(error)) from error
    world = _require_world()
    world.colors[(world.karel.avenue, world.karel.street)] = safe_color
    _emit_state("paint_corner")


def corner_color_is(color: Color) -> bool:
    world = _require_world()
    return world.colors.get((world.karel.avenue, world.karel.street)) == color


def front_is_clear() -> bool:
    world = _require_world()
    state = world.karel
    return not world.is_blocked(state.avenue, state.street, state.direction)


def front_is_blocked() -> bool:
    return not front_is_clear()


def _relative_is_clear(turns_right: int) -> bool:
    world = _require_world()
    state = world.karel
    direction = _DIRECTIONS[(_DIRECTIONS.index(state.direction) + turns_right) % 4]
    return not world.is_blocked(state.avenue, state.street, direction)


def left_is_clear() -> bool:
    return _relative_is_clear(-1)


def left_is_blocked() -> bool:
    return not left_is_clear()


def right_is_clear() -> bool:
    return _relative_is_clear(1)


def right_is_blocked() -> bool:
    return not right_is_clear()


def beepers_present() -> bool:
    world = _require_world()
    return world.beepers.get((world.karel.avenue, world.karel.street), 0) > 0


def no_beepers_present() -> bool:
    return not beepers_present()


def beepers_in_bag() -> bool:
    bag = _require_world().karel.beepers_in_bag
    return bag is None or bag > 0


def no_beepers_in_bag() -> bool:
    return not beepers_in_bag()


def facing_north() -> bool:
    return _require_world().karel.direction == "north"


def facing_east() -> bool:
    return _require_world().karel.direction == "east"


def facing_south() -> bool:
    return _require_world().karel.direction == "south"


def facing_west() -> bool:
    return _require_world().karel.direction == "west"


def not_facing_north() -> bool:
    return not facing_north()


def not_facing_east() -> bool:
    return not facing_east()


def not_facing_south() -> bool:
    return not facing_south()


def not_facing_west() -> bool:
    return not facing_west()


def run_karel(
    program: Callable[[], Any],
    world: str | Path | Mapping[str, Any] | KarelWorld | None = None,
) -> Any:
    """Load a world, execute ``program``, and publish completion or failure.

    A typical ``main.py`` ends with ``run_karel(main)``. Passing a mapping or a
    path makes the same Python library reusable with host-supplied worlds.
    """

    if not callable(program):
        raise TypeError("run_karel(program) requires a callable")
    set_world(_default_world_path() if world is None else world)
    try:
        result = program()
    except BaseException as error:
        _emit(
            "error",
            message=str(error) or error.__class__.__name__,
            errorType=error.__class__.__name__,
        )
        raise
    _emit("complete", world=_require_world().to_dict())
    return result


def _set_protocol_stream_for_testing(stream: TextIO) -> None:
    """Internal test seam; student programs should not call this function."""

    global _protocol_stream
    _protocol_stream = stream


__all__ = [
    "Color",
    "Direction",
    "EmptyBeeperBagError",
    "KarelBlockedError",
    "KarelError",
    "KarelState",
    "KarelWorld",
    "KarelWorldError",
    "NoBeeperError",
    "PROTOCOL_NAME",
    "PROTOCOL_VERSION",
    "beepers_in_bag",
    "beepers_present",
    "corner_color_is",
    "facing_east",
    "facing_north",
    "facing_south",
    "facing_west",
    "front_is_blocked",
    "front_is_clear",
    "get_world",
    "left_is_blocked",
    "left_is_clear",
    "move",
    "no_beepers_in_bag",
    "no_beepers_present",
    "not_facing_east",
    "not_facing_north",
    "not_facing_south",
    "not_facing_west",
    "paint_corner",
    "pick_beeper",
    "put_beeper",
    "right_is_blocked",
    "right_is_clear",
    "run_karel",
    "set_world",
    "turn_left",
]
