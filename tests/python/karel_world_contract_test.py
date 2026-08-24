import copy
import json
import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "python"))

import karel_world_contract as contract  # noqa: E402

CASES = json.loads(
    (REPOSITORY_ROOT / "tests/fixtures/world-contract-cases.json").read_text(
        encoding="utf-8"
    )
)


class KarelWorldContractTests(unittest.TestCase):
    def canonical_input(self):
        return copy.deepcopy(CASES["canonicalization"]["input"])

    def test_canonicalization_and_serialization_match_shared_fixture(self):
        expected = CASES["canonicalization"]["expected"]
        parsed = contract.parse_karel_world_document(self.canonical_input())
        self.assertEqual(parsed, expected)
        self.assertEqual(contract.canonicalize_karel_world_document(parsed), parsed)
        self.assertEqual(
            contract.serialize_karel_world_document(parsed),
            json.dumps(expected, ensure_ascii=False, separators=(",", ":")) + "\n",
        )

    def test_explicit_bare_and_standalone_converters_match_shared_fixture(self):
        bare = contract.convert_bare_karel_world_to_document(
            CASES["canonicalization"]["input"]["world"]
        )
        self.assertEqual(bare.document, CASES["canonicalization"]["expected"])
        self.assertEqual(bare.warnings, ())

        standalone = contract.convert_standalone_karel_world_to_document(
            CASES["standaloneConversion"]["input"]
        )
        self.assertEqual(
            standalone.document, CASES["standaloneConversion"]["expected"]
        )
        self.assertEqual(
            [warning.code for warning in standalone.warnings],
            CASES["standaloneConversion"]["warningCodes"],
        )
        self.assertEqual(
            standalone.canonical_preview,
            json.dumps(
                CASES["standaloneConversion"]["expected"],
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n",
        )

    def test_rejects_unknown_missing_unsupported_and_nested_fields(self):
        unknown = self.canonical_input()
        unknown["extra"] = True
        with self.assertRaisesRegex(contract.KarelWorldContractError, "unknown field extra"):
            contract.parse_karel_world_document(unknown)

        missing = self.canonical_input()
        del missing["version"]
        with self.assertRaisesRegex(contract.KarelWorldContractError, "required field version"):
            contract.parse_karel_world_document(missing)

        unsupported = self.canonical_input()
        unsupported["version"] = 2
        with self.assertRaisesRegex(contract.KarelWorldContractError, "unsupported"):
            contract.parse_karel_world_document(unsupported)

        nested = self.canonical_input()
        nested["world"]["karel"]["extra"] = True
        with self.assertRaisesRegex(contract.KarelWorldContractError, "unknown field extra"):
            contract.parse_karel_world_document(nested)

    def test_rejects_subclassed_containers_and_boolean_integers(self):
        class DictSubclass(dict):
            pass

        class ListSubclass(list):
            pass

        with self.assertRaisesRegex(contract.KarelWorldContractError, "plain object"):
            contract.parse_karel_world_document(DictSubclass(self.canonical_input()))

        subclassed_array = self.canonical_input()
        subclassed_array["world"]["beepers"] = ListSubclass()
        with self.assertRaisesRegex(contract.KarelWorldContractError, "plain array"):
            contract.parse_karel_world_document(subclassed_array)

        boolean_coordinate = self.canonical_input()
        boolean_coordinate["world"]["karel"]["avenue"] = True
        with self.assertRaisesRegex(contract.KarelWorldContractError, "safe integer"):
            contract.parse_karel_world_document(boolean_coordinate)

    def test_rejects_invalid_bounds_directions_counts_and_colors(self):
        invalid_values = (
            ("columns", 101, "cannot exceed"),
            ("columns", 0, "safe integer"),
        )
        for field, value, message in invalid_values:
            with self.subTest(field=field, value=value):
                invalid = self.canonical_input()
                invalid["world"][field] = value
                with self.assertRaisesRegex(contract.KarelWorldContractError, message):
                    contract.parse_karel_world_document(invalid)

        outside = self.canonical_input()
        outside["world"]["karel"]["avenue"] = 6
        with self.assertRaisesRegex(contract.KarelWorldContractError, "outside"):
            contract.parse_karel_world_document(outside)

        invalid_direction = self.canonical_input()
        invalid_direction["world"]["karel"]["direction"] = "up"
        with self.assertRaisesRegex(contract.KarelWorldContractError, "north, east"):
            contract.parse_karel_world_document(invalid_direction)

        invalid_count = self.canonical_input()
        invalid_count["world"]["beepers"][0]["count"] = 0
        with self.assertRaisesRegex(contract.KarelWorldContractError, "safe integer"):
            contract.parse_karel_world_document(invalid_count)

        invalid_color = self.canonical_input()
        invalid_color["world"]["colors"][0]["color"] = "url(https://example.test)"
        with self.assertRaisesRegex(contract.KarelWorldContractError, "safe named"):
            contract.parse_karel_world_document(invalid_color)

    def test_rejects_boundaries_and_semantic_duplicates(self):
        boundary = self.canonical_input()
        boundary["world"]["walls"] = [
            {"avenue": 5, "street": 2, "direction": "east"}
        ]
        with self.assertRaisesRegex(contract.KarelWorldContractError, "implicit boundary"):
            contract.parse_karel_world_document(boundary)

        duplicate_wall = self.canonical_input()
        duplicate_wall["world"]["walls"] = [
            {"avenue": 2, "street": 1, "direction": "east"},
            {"avenue": 3, "street": 1, "direction": "west"},
        ]
        with self.assertRaisesRegex(contract.KarelWorldContractError, "duplicates wall"):
            contract.parse_karel_world_document(duplicate_wall)

        duplicate_beeper = self.canonical_input()
        duplicate_beeper["world"]["beepers"] = [
            {"avenue": 1, "street": 1, "count": 1},
            {"avenue": 1, "street": 1, "count": 2},
        ]
        with self.assertRaisesRegex(contract.KarelWorldContractError, "duplicates beeper"):
            contract.parse_karel_world_document(duplicate_beeper)

        duplicate_color = self.canonical_input()
        duplicate_color["world"]["colors"] = [
            {"avenue": 1, "street": 1, "color": "blue"},
            {"avenue": 1, "street": 1, "color": "#fff"},
        ]
        with self.assertRaisesRegex(contract.KarelWorldContractError, "duplicates color"):
            contract.parse_karel_world_document(duplicate_color)

    def test_rejects_ambiguous_or_malformed_standalone_input(self):
        unknown = copy.deepcopy(CASES["standaloneConversion"]["input"])
        unknown["extra"] = True
        with self.assertRaisesRegex(contract.KarelWorldContractError, "unknown field extra"):
            contract.convert_standalone_karel_world_to_document(unknown)

        invalid_wall = copy.deepcopy(CASES["standaloneConversion"]["input"])
        invalid_wall["walls"] = ["1,2,up"]
        with self.assertRaisesRegex(contract.KarelWorldContractError, "direction"):
            contract.convert_standalone_karel_world_to_document(invalid_wall)

        invalid_beeper = copy.deepcopy(CASES["standaloneConversion"]["input"])
        invalid_beeper["beepers"] = {"1:2": 1}
        with self.assertRaisesRegex(contract.KarelWorldContractError, "street,avenue"):
            contract.convert_standalone_karel_world_to_document(invalid_beeper)


if __name__ == "__main__":
    unittest.main()
