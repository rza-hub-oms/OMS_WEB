"""Alarm engine built on the central OMS tag system.

Alarm definitions are project data; runtime state/history is kept in memory.
Expressions use the same safe tag expression language as derived tags, so an
alarm never evaluates arbitrary Python code.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any

from core.tags import TagExpressionError


@dataclass
class AlarmRuntime:
    active: bool = False
    acknowledged: bool = False
    activated_at: str | None = None
    cleared_at: str | None = None
    last_error: str = ""


class AlarmEngine:
    SEVERITIES = ("info", "warning", "critical")

    def __init__(self, scene, history_limit: int = 500):
        self.scene = scene
        self.history_limit = history_limit
        self.definitions: list[dict] = []
        self.runtime: dict[str, AlarmRuntime] = {}
        self.history: list[dict] = []

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds")

    @staticmethod
    def _normalise(definition: dict, index: int) -> dict:
        alarm_id = str(definition.get("id") or f"alarm_{index + 1}")
        return {
            "id": alarm_id,
            "name": str(definition.get("name") or alarm_id),
            "severity": str(definition.get("severity") or "warning").lower()
            if str(definition.get("severity") or "warning").lower() in AlarmEngine.SEVERITIES
            else "warning",
            "expression": str(definition.get("expression") or "").strip(),
            "description": str(definition.get("description") or ""),
            "enabled": bool(definition.get("enabled", True)),
            "latched": bool(definition.get("latched", False)),
        }

    def set_definitions(self, definitions) -> None:
        rows = []
        seen = set()
        for i, row in enumerate(definitions or []):
            if not isinstance(row, dict):
                continue
            item = self._normalise(row, i)
            if item["id"] in seen:
                continue
            seen.add(item["id"])
            rows.append(item)
            self.runtime.setdefault(item["id"], AlarmRuntime())
        self.definitions = rows
        self.runtime = {a["id"]: self.runtime.get(a["id"], AlarmRuntime()) for a in rows}

    def reset(self, clear_history: bool = False) -> None:
        for alarm_id in list(self.runtime):
            self.runtime[alarm_id] = AlarmRuntime()
        if clear_history:
            self.history.clear()

    def delete(self, alarm_id: str) -> bool:
        before = len(self.definitions)
        self.definitions = [a for a in self.definitions if a["id"] != alarm_id]
        self.runtime.pop(alarm_id, None)
        return len(self.definitions) != before

    def acknowledge(self, alarm_id: str) -> bool:
        state = self.runtime.get(alarm_id)
        if state is None or not state.active:
            return False
        state.acknowledged = True
        definition = next((item for item in self.definitions if item["id"] == alarm_id), None)
        if definition is not None:
            self._history_event(definition, "acknowledged", self._now())
        # A latched alarm clears only after its condition is gone and it has
        # been acknowledged. Non-latched alarms also keep their history entry
        # but clear automatically when their condition becomes false.
        return True

    def evaluate(self) -> list[dict]:
        now = self._now()
        for definition in self.definitions:
            alarm_id = definition["id"]
            state = self.runtime.setdefault(alarm_id, AlarmRuntime())
            if not definition["enabled"] or not definition["expression"]:
                condition = False
                state.last_error = ""
            else:
                try:
                    condition = bool(self.scene.tags.evaluate_expression(definition["expression"]))
                    state.last_error = ""
                except (TagExpressionError, KeyError, TypeError, ValueError, ZeroDivisionError, OverflowError) as exc:
                    condition = False
                    state.last_error = str(exc)

            if condition and not state.active:
                state.active = True
                state.acknowledged = False
                state.activated_at = now
                state.cleared_at = None
                self._history_event(definition, "active", now)
            elif not condition and state.active:
                if not definition["latched"] or state.acknowledged:
                    state.active = False
                    state.cleared_at = now
                    self._history_event(definition, "cleared", now)

        return self.active()

    def _history_event(self, definition: dict, event: str, timestamp: str) -> None:
        self.history.insert(0, {
            "timestamp": timestamp,
            "id": definition["id"],
            "name": definition["name"],
            "severity": definition["severity"],
            "event": event,
        })
        del self.history[self.history_limit:]

    def active(self) -> list[dict]:
        result = []
        by_id = {a["id"]: a for a in self.definitions}
        for alarm_id, state in self.runtime.items():
            if not state.active or alarm_id not in by_id:
                continue
            item = dict(by_id[alarm_id])
            item.update({
                "active": True,
                "acknowledged": state.acknowledged,
                "activated_at": state.activated_at,
                "cleared_at": state.cleared_at,
                "last_error": state.last_error,
            })
            result.append(item)
        order = {"critical": 0, "warning": 1, "info": 2}
        return sorted(result, key=lambda a: (order.get(a["severity"], 9), a.get("activated_at") or ""))

    def snapshot(self) -> dict:
        definitions = []
        for definition in self.definitions:
            item = dict(definition)
            state = self.runtime.get(definition["id"], AlarmRuntime())
            item.update({
                "active": state.active,
                "acknowledged": state.acknowledged,
                "activated_at": state.activated_at,
                "cleared_at": state.cleared_at,
                "last_error": state.last_error,
            })
            definitions.append(item)
        return {
            "definitions": definitions,
            "active": self.active(),
            "history": list(self.history),
            "active_count": len(self.active()),
        }
