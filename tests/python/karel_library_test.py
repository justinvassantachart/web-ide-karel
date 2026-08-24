import base64
import io
import json
import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "python"))

import karel  # noqa: E402


def world(**karel_overrides):
    robot = {
        "avenue": 1,
        "street": 1,
        "direction": "east",
        "beepersInBag": 1,
        **karel_overrides,
    }
    return {
        "name": "Test World",
        "columns": 3,
        "rows": 2,
        "karel": robot,
        "beepers": [],
        "walls": [],
        "colors": [],
    }


def decode_frames(output):
    frames = []
    for item in output.split(karel.PROTOCOL_OSC_PREFIX)[1:]:
        encoded, _remaining = item.split(karel.PROTOCOL_OSC_END, 1)
        frames.append(json.loads(base64.urlsafe_b64decode(encoded).decode("utf-8")))
    return frames


class KarelWorldTests(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        karel._set_protocol_stream_for_testing(self.output)

    def tearDown(self):
        karel._set_protocol_limits_for_testing()
        karel._set_protocol_stream_for_testing(sys.stdout)

    def test_movement_turning_and_state_frames(self):
        karel.set_world(world())
        karel.move()
        karel.turn_left()

        state = karel.get_world().karel
        self.assertEqual((state.avenue, state.street, state.direction), (2, 1, "north"))
        frames = decode_frames(self.output.getvalue())
        self.assertEqual([frame["action"] for frame in frames], ["load", "move", "turn_left"])
        self.assertEqual([frame["sequence"] for frame in frames], [0, 1, 2])
        self.assertEqual({frame["version"] for frame in frames}, {2})
        self.assertEqual(len({frame["runId"] for frame in frames}), 1)
        self.assertEqual(frames[1]["source"]["path"], "tests/python/karel_library_test.py")

    def test_native_turn_right_is_one_clockwise_action(self):
        karel.set_world(world(direction="north"))
        karel.turn_right()

        self.assertEqual(karel.get_world().karel.direction, "east")
        frames = decode_frames(self.output.getvalue())
        self.assertEqual([frame["action"] for frame in frames], ["load", "turn_right"])

    def test_move_and_turn_cover_every_orientation(self):
        expected_moves = {
            "north": (2, 3),
            "east": (3, 2),
            "south": (2, 1),
            "west": (1, 2),
        }
        expected_left = {
            "north": "west",
            "east": "north",
            "south": "east",
            "west": "south",
        }
        expected_right = {
            "north": "east",
            "east": "south",
            "south": "west",
            "west": "north",
        }
        for direction in expected_moves:
            with self.subTest(direction=direction):
                value = world(avenue=2, street=2, direction=direction)
                value["columns"] = 3
                value["rows"] = 3
                karel.set_world(value)
                karel.move()
                state = karel.get_world().karel
                self.assertEqual((state.avenue, state.street), expected_moves[direction])

                karel.set_world(value)
                karel.turn_left()
                self.assertEqual(karel.get_world().karel.direction, expected_left[direction])

                karel.set_world(value)
                karel.turn_right()
                self.assertEqual(karel.get_world().karel.direction, expected_right[direction])

    def test_wall_described_from_neighbor_blocks_both_sides(self):
        value = world()
        value["walls"] = [{"avenue": 2, "street": 1, "direction": "west"}]
        karel.set_world(value)

        self.assertTrue(karel.front_is_blocked())
        with self.assertRaises(karel.KarelBlockedError):
            karel.move()

    def test_relative_and_boundary_predicates_cover_every_orientation(self):
        directions = ("north", "east", "south", "west")
        for index, direction in enumerate(directions):
            with self.subTest(direction=direction):
                value = world(avenue=2, street=2, direction=direction)
                value["columns"] = 3
                value["rows"] = 3
                value["walls"] = [
                    {"avenue": 2, "street": 2, "direction": direction},
                    {
                        "avenue": 2,
                        "street": 2,
                        "direction": directions[(index - 1) % 4],
                    },
                    {
                        "avenue": 2,
                        "street": 2,
                        "direction": directions[(index + 1) % 4],
                    },
                ]
                karel.set_world(value)
                self.assertFalse(karel.front_is_clear())
                self.assertTrue(karel.front_is_blocked())
                self.assertFalse(karel.left_is_clear())
                self.assertTrue(karel.left_is_blocked())
                self.assertFalse(karel.right_is_clear())
                self.assertTrue(karel.right_is_blocked())

                value["walls"] = []
                karel.set_world(value)
                self.assertTrue(karel.front_is_clear())
                self.assertFalse(karel.front_is_blocked())
                self.assertTrue(karel.left_is_clear())
                self.assertFalse(karel.left_is_blocked())
                self.assertTrue(karel.right_is_clear())
                self.assertFalse(karel.right_is_blocked())

        boundaries = {
            "north": {"avenue": 2, "street": 2},
            "east": {"avenue": 3, "street": 1},
            "south": {"avenue": 2, "street": 1},
            "west": {"avenue": 1, "street": 1},
        }
        for direction, location in boundaries.items():
            with self.subTest(boundary=direction):
                value = world(direction=direction, **location)
                karel.set_world(value)
                self.assertTrue(karel.front_is_blocked())
                with self.assertRaisesRegex(karel.KarelBlockedError, "front is blocked"):
                    karel.move()

    def test_beeper_bag_and_corner_operations(self):
        value = world()
        value["beepers"] = [{"avenue": 1, "street": 1, "count": 1}]
        karel.set_world(value)

        self.assertTrue(karel.beepers_present())
        karel.pick_beeper()
        self.assertFalse(karel.beepers_present())
        self.assertEqual(karel.get_world().karel.beepers_in_bag, 2)
        karel.put_beeper()
        self.assertTrue(karel.beepers_present())
        self.assertEqual(karel.get_world().karel.beepers_in_bag, 1)

    def test_finite_and_infinite_bags_and_typed_beeper_errors(self):
        karel.set_world(world(beepersInBag=0))
        self.assertFalse(karel.beepers_in_bag())
        self.assertTrue(karel.no_beepers_in_bag())
        with self.assertRaisesRegex(karel.EmptyBeeperBagError, "bag is empty"):
            karel.put_beeper()
        with self.assertRaisesRegex(karel.NoBeeperError, "corner is empty"):
            karel.pick_beeper()

        unlimited = world(beepersInBag="infinite")
        karel.set_world(unlimited)
        self.assertTrue(karel.beepers_in_bag())
        self.assertFalse(karel.no_beepers_in_bag())
        karel.put_beeper()
        karel.put_beeper()
        self.assertIsNone(karel.get_world().karel.beepers_in_bag)
        self.assertEqual(karel.get_world().beepers[(1, 1)], 2)

    def test_beeper_presence_tracks_the_current_corner_and_pile_count(self):
        value = world(beepersInBag=0)
        value["beepers"] = [{"avenue": 2, "street": 1, "count": 2}]
        karel.set_world(value)
        self.assertFalse(karel.beepers_present())
        self.assertTrue(karel.no_beepers_present())
        karel.move()
        self.assertTrue(karel.beepers_present())
        self.assertFalse(karel.no_beepers_present())
        karel.pick_beeper()
        self.assertEqual(karel.get_world().beepers[(2, 1)], 1)
        karel.pick_beeper()
        self.assertFalse(karel.beepers_present())
        self.assertNotIn((2, 1), karel.get_world().beepers)

    def test_paint_and_direction_predicates(self):
        karel.set_world(world())
        self.assertTrue(karel.facing_east())
        self.assertTrue(karel.not_facing_north())
        karel.paint_corner("blue")
        self.assertTrue(karel.corner_color_is("blue"))

    def test_all_direction_and_inverse_predicates(self):
        positive = {
            "north": karel.facing_north,
            "east": karel.facing_east,
            "south": karel.facing_south,
            "west": karel.facing_west,
        }
        inverse = {
            "north": karel.not_facing_north,
            "east": karel.not_facing_east,
            "south": karel.not_facing_south,
            "west": karel.not_facing_west,
        }
        for direction in positive:
            with self.subTest(direction=direction):
                karel.set_world(world(direction=direction))
                for candidate in positive:
                    self.assertEqual(positive[candidate](), candidate == direction)
                    self.assertEqual(inverse[candidate](), candidate != direction)

    def test_painted_colors_persist_in_frames_and_active_values_fail_typed(self):
        karel.set_world(world())
        karel.paint_corner("#A0B1C2")
        self.assertTrue(karel.corner_color_is("#A0B1C2"))
        frame = decode_frames(self.output.getvalue())[-1]
        self.assertEqual(frame["action"], "paint_corner")
        self.assertEqual(
            frame["world"]["colors"],
            [{"avenue": 1, "street": 1, "color": "#A0B1C2"}],
        )
        with self.assertRaisesRegex(karel.KarelError, "named color"):
            karel.paint_corner("url(https://example.test)")

    def test_run_karel_emits_complete(self):
        karel.run_karel(karel.move, world())
        frames = decode_frames(self.output.getvalue())
        self.assertEqual(frames[-1]["type"], "terminal")
        self.assertEqual(frames[-1]["outcome"], "completed")
        self.assertEqual(frames[-1]["world"]["karel"]["avenue"], 2)

    def test_run_karel_emits_error_and_reraises(self):
        value = world()
        value["columns"] = 1
        with self.assertRaises(karel.KarelBlockedError):
            karel.run_karel(karel.move, value)

        frames = decode_frames(self.output.getvalue())
        self.assertEqual(frames[-1]["type"], "terminal")
        self.assertEqual(frames[-1]["outcome"], "runtime-error")
        self.assertEqual(frames[-1]["errorType"], "KarelBlockedError")

    def test_protocol_event_limit_settles_once_and_stops_actions(self):
        karel._set_protocol_limits_for_testing(max_events=3)
        karel.set_world(world())
        karel.move()
        with self.assertRaisesRegex(karel.KarelLimitError, "protocol events"):
            karel.turn_left()

        frames = decode_frames(self.output.getvalue())
        self.assertEqual([frame["sequence"] for frame in frames], [0, 1, 2])
        self.assertEqual(frames[-1]["type"], "terminal")
        self.assertEqual(frames[-1]["outcome"], "limit-exceeded")
        self.assertEqual(frames[-1]["reason"], "event-limit")

    def test_protocol_character_limit_settles_once_with_a_bounded_reason(self):
        karel._set_protocol_limits_for_testing(max_characters=2_000)
        karel.set_world(world())
        with self.assertRaisesRegex(karel.KarelLimitError, "character limit"):
            karel.paint_corner("abcdefghijklmnopqrstuvwx")

        frames = decode_frames(self.output.getvalue())
        terminal = [frame for frame in frames if frame["type"] == "terminal"]
        self.assertEqual(len(terminal), 1)
        self.assertEqual(terminal[0]["outcome"], "limit-exceeded")
        self.assertEqual(terminal[0]["reason"], "protocol-byte-limit")

    def test_world_validation_rejects_invalid_coordinates(self):
        value = world(avenue=4)
        with self.assertRaisesRegex(karel.KarelWorldError, "outside"):
            karel.KarelWorld.from_dict(value)

    def test_world_dimension_limit_matches_the_typescript_decoder(self):
        boundary = world()
        boundary["columns"] = 100
        boundary["rows"] = 100
        parsed = karel.KarelWorld.from_dict(boundary)
        self.assertEqual((parsed.columns, parsed.rows), (100, 100))

        oversized = world()
        oversized["columns"] = 101
        with self.assertRaisesRegex(karel.KarelWorldError, "cannot exceed 100x100"):
            karel.KarelWorld.from_dict(oversized)

    def test_world_item_limit_matches_the_typescript_decoder(self):
        boundary = world()
        boundary["beepers"] = [
            {"avenue": 1, "street": 1, "count": 1}
        ] * 10_000
        parsed = karel.KarelWorld.from_dict(boundary)
        self.assertEqual(parsed.beepers[(1, 1)], 10_000)

        oversized_items = {
            "beepers": {"avenue": 1, "street": 1, "count": 1},
            "walls": {"avenue": 1, "street": 1, "direction": "north"},
            "colors": {"avenue": 1, "street": 1, "color": "blue"},
        }
        for field, item in oversized_items.items():
            with self.subTest(field=field):
                oversized = world()
                oversized[field] = [item] * 10_001
                with self.assertRaisesRegex(karel.KarelWorldError, "10000-item limit"):
                    karel.KarelWorld.from_dict(oversized)


if __name__ == "__main__":
    unittest.main()
