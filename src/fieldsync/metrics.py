"""Tiny Prometheus text-format registry (no dependency, thread-safe)."""

from __future__ import annotations

import threading
from collections import defaultdict
from collections.abc import Callable


class Metrics:
    def __init__(self) -> None:
        self._c: dict[tuple[str, tuple[tuple[str, str], ...]], float] = defaultdict(float)
        self._gauges: dict[str, Callable[[], float]] = {}
        self._lock = threading.Lock()

    def inc(self, name: str, n: float = 1, **labels: str) -> None:
        with self._lock:
            self._c[(name, tuple(sorted(labels.items())))] += n

    def gauge(self, name: str, fn: Callable[[], float]) -> None:
        self._gauges[name] = fn

    def value(self, name: str, **labels: str) -> float:
        return self._c.get((name, tuple(sorted(labels.items()))), 0.0)

    def render(self) -> str:
        lines: list[str] = []
        with self._lock:
            for (name, labels), v in sorted(self._c.items()):
                lab = ",".join(f'{k}="{val}"' for k, val in labels)
                lines.append(f"{name}{{{lab}}} {v}" if lab else f"{name} {v}")
        for name, fn in sorted(self._gauges.items()):
            try:
                lines.append(f"{name} {fn()}")
            except Exception:
                lines.append(f"{name} NaN")
        return "\n".join(lines) + "\n"
