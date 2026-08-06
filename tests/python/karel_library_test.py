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

    def test_wall_described_from_neighbor_blocks_both_sides(self):
        value = world()
        value["walls"] = [{"avenue": 2, "street": 1, "direction": "west"}]
        karel.set_world(value)

        self.assertTrue(karel.front_is_blocked())
        with self.assertRaises(karel.KarelBlockedError):
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

    def test_paint_and_direction_predicates(self):
        karel.set_world(world())
        self.assertTrue(karel.facing_east())
        self.assertTrue(karel.not_facing_north())
        karel.paint_corner("blue")
        self.assertTrue(karel.corner_color_is("blue"))

    def test_run_karel_emits_complete(self):
        karel.run_karel(karel.move, world())
        frames = decode_frames(self.output.getvalue())
        self.assertEqual(frames[-1]["type"], "complete")
        self.assertEqual(frames[-1]["world"]["karel"]["avenue"], 2)

    def test_run_karel_emits_error_and_reraises(self):
        value = world()
        value["columns"] = 1
        with self.assertRaises(karel.KarelBlockedError):
            karel.run_karel(karel.move, value)

        frames = decode_frames(self.output.getvalue())
        self.assertEqual(frames[-1]["type"], "error")
        self.assertEqual(frames[-1]["errorType"], "KarelBlockedError")

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
