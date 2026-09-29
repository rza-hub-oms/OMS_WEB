"""Bounded historical recorder for OMS tag trends."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from time import time
from typing import Any


@dataclass
class TrendSample:
    timestamp: float
    values: dict[str, float]

    def to_dict(self) -> dict[str, Any]:
        return {"timestamp": self.timestamp, "values": dict(self.values)}


class TrendRecorder:
    def __init__(self, max_samples: int = 3600, interval_s: float = 1.0):
        self.max_samples = max_samples
        self.interval_s = interval_s
        self.running = False
        self.selected: list[str] = []
        self.samples: deque[TrendSample] = deque(maxlen=max_samples)
        self._elapsed = 0.0

    def configure(self, names: list[str]) -> None:
        self.selected = list(dict.fromkeys(str(n).strip() for n in names if str(n).strip()))
        self.clear()

    def clear(self) -> None:
        self.samples.clear()
        self._elapsed = 0.0

    def set_interval(self, seconds: float) -> None:
        self.interval_s = max(0.05, float(seconds))
        self._elapsed = 0.0

    def sample(self, read, dt_seconds: float) -> bool:
        if not self.running or not self.selected:
            return False
        self._elapsed += max(0.0, float(dt_seconds))
        if self.interval_s > 0:
            if self._elapsed < self.interval_s:
                return False
            self._elapsed %= self.interval_s
        else:
            self._elapsed = 0.0
        values: dict[str, float] = {}
        for name in self.selected:
            try:
                value = read(name)
                if isinstance(value, bool):
                    continue
                if isinstance(value, (int, float)):
                    values[name] = float(value)
            except (KeyError, TypeError, ValueError):
                continue
        if not values:
            return False
        self.samples.append(TrendSample(time(), values))
        return True

    def snapshot(self) -> dict[str, Any]:
        return {
            "selected": list(self.selected),
            "interval_s": self.interval_s,
            "running": self.running,
            "samples": [sample.to_dict() for sample in self.samples],
        }