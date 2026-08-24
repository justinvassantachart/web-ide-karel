"""Fail closed when Karel's host-side contract tests use unsupported Python."""

from __future__ import annotations

import sys


MINIMUM = (3, 10)


if sys.version_info < MINIMUM:
    actual = ".".join(str(value) for value in sys.version_info[:3])
    required = ".".join(str(value) for value in MINIMUM)
    raise SystemExit(
        f"Python {required} or newer is required for Karel validation; found {actual}"
    )

print(
    "Karel validation Python:",
    ".".join(str(value) for value in sys.version_info[:3]),
)
