"""Production counters and OEE foundation for OMS.

Production is driven by central OMS tags. A configured boolean production
trigger counts a rising edge as one produced part; an optional reject trigger
counts rising edges as rejects. Runtime statistics are session/project state,
while the configuration is serializable with the project.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from time import time
from typing import Any


@dataclass
class ProductionConfig:
    production_trigger: str = ""
    reject_trigger: str = ""
    running_tag: str = ""
    ideal_cycle_s: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ProductionTracker:
    def __init__(self):
        self.config = ProductionConfig()
        self.total_count = 0
        self.reject_count = 0
        self.running_seconds = 0.0
        self.elapsed_seconds = 0.0
        self.last_production_timestamp: float | None = None
        self.last_cycle_s: float | None = None
        self.average_cycle_s: float | None = None
        self._previous_production = False
        self._previous_reject = False
        self._cycle_samples: list[float] = []
        self.started_at = time()

    def configure(self, config: dict | ProductionConfig | None) -> None:
        if isinstance(config, ProductionConfig):
            self.config = config
        else:
            data = config or {}
            try:
                ideal = max(0.0, float(data.get("ideal_cycle_s", 0.0) or 0.0))
            except (TypeError, ValueError):
                ideal = 0.0
            self.config = ProductionConfig(
                production_trigger=str(data.get("production_trigger", "") or "").strip(),
                reject_trigger=str(data.get("reject_trigger", "") or "").strip(),
                running_tag=str(data.get("running_tag", "") or "").strip(),
                ideal_cycle_s=ideal,
            )
        self.reset()

    def reset(self) -> None:
        self.total_count = 0
        self.reject_count = 0
        self.running_seconds = 0.0
        self.elapsed_seconds = 0.0
        self.last_production_timestamp = None
        self.last_cycle_s = None
        self.average_cycle_s = None
        self._previous_production = False
        self._previous_reject = False
        self._cycle_samples = []
        self.started_at = time()

    @staticmethod
    def _rising(value: Any, previous: bool) -> tuple[bool, bool]:
        current = bool(value)
        return current, current and not previous

    def tick(self, read, dt_seconds: float, active: bool = True) -> None:
        dt = max(0.0, float(dt_seconds))
        if not active:
            self._previous_production = False
            self._previous_reject = False
            return
        self.elapsed_seconds += dt

        running = True
        if self.config.running_tag:
            try:
                running = bool(read(self.config.running_tag))
            except (KeyError, TypeError, ValueError):
                running = False
        if running:
            self.running_seconds += dt

        if self.config.production_trigger:
            try:
                current, rising = self._rising(read(self.config.production_trigger), self._previous_production)
            except (KeyError, TypeError, ValueError):
                current, rising = False, False
            self._previous_production = current
            if rising:
                now = time()
                self.total_count += 1
                if self.last_production_timestamp is not None:
                    cycle = max(0.0, now - self.last_production_timestamp)
                    self.last_cycle_s = cycle
                    self._cycle_samples.append(cycle)
                    if len(self._cycle_samples) > 100:
                        self._cycle_samples.pop(0)
                    self.average_cycle_s = sum(self._cycle_samples) / len(self._cycle_samples)
                self.last_production_timestamp = now
        else:
            self._previous_production = False

        if self.config.reject_trigger:
            try:
                current, rising = self._rising(read(self.config.reject_trigger), self._previous_reject)
            except (KeyError, TypeError, ValueError):
                current, rising = False, False
            self._previous_reject = current
            if rising:
                self.reject_count += 1
        else:
            self._previous_reject = False

    @property
    def good_count(self) -> int:
        return max(0, self.total_count - self.reject_count)

    def snapshot(self) -> dict[str, Any]:
        elapsed = self.elapsed_seconds
        running = self.running_seconds
        availability = (running / elapsed) if elapsed > 0 else 0.0
        quality = (self.good_count / self.total_count) if self.total_count > 0 else 0.0
        performance = 0.0
        if self.config.ideal_cycle_s > 0 and running > 0 and self.total_count > 0:
            performance = min(1.0, (self.config.ideal_cycle_s * self.total_count) / running)
        oee = availability * performance * quality if self.config.ideal_cycle_s > 0 else 0.0
        return {
            "config": self.config.to_dict(),
            "total_count": self.total_count,
            "good_count": self.good_count,
            "reject_count": self.reject_count,
            "cycle_time_s": self.last_cycle_s,
            "average_cycle_s": self.average_cycle_s,
            "elapsed_seconds": elapsed,
            "running_seconds": running,
            "availability": availability,
            "performance": performance,
            "quality": quality,
            "oee": oee,
            "configured": bool(self.config.production_trigger),
        }
