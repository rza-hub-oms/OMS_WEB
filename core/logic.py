"""Deterministic simulation control-logic engine.

Rules run only in Simulation mode. Besides level conditions, rules can use
rising/falling edges and an on-delay (TON-style) before the true output is
applied. Runtime remains controlled exclusively by the live PLC.
"""
from __future__ import annotations


class LogicEngine:
    OPERATORS = {"truthy", "equals", "not_equals", "rising", "falling"}

    def __init__(self, scene):
        self.scene = scene
        self._previous_values = {}
        self._timers_ms = {}

    def reset(self):
        self._previous_values.clear()
        self._timers_ms.clear()

    def _read(self, tag_name, point_name):
        obj = self.scene.objects.get(tag_name)
        if obj is None:
            return None, False
        point = obj.get_plc_io_points().get(point_name)
        if point is None:
            return None, False
        getter, _setter = point
        if getter is None:
            return None, False
        return getter(), True

    def _read_tag(self, tag_name):
        """Resolve a rule source that points at a central OMS tag (an
        internal/derived tag with an expression, or any other tag) by
        name instead of a raw component.io_point pair."""
        tag = self.scene.tags.get(tag_name)
        if tag is None:
            return None, False
        try:
            return self.scene.tags.read(tag_name), True
        except KeyError:
            return None, False

    @staticmethod
    def _coerce(value, actual):
        if isinstance(actual, bool):
            if isinstance(value, str):
                return value.strip().lower() in {"1", "true", "on", "yes"}
            return bool(value)
        if isinstance(actual, int) and not isinstance(actual, bool):
            try:
                return int(value)
            except (TypeError, ValueError):
                return value
        if isinstance(actual, float):
            try:
                return float(value)
            except (TypeError, ValueError):
                return value
        return value

    def _condition(self, actual, rule, previous):
        operator = rule.get("operator", "truthy")
        if operator not in self.OPERATORS:
            return False
        if operator == "truthy":
            return bool(actual)
        if operator == "rising":
            return bool(actual) and not bool(previous)
        if operator == "falling":
            return bool(previous) and not bool(actual)
        expected = self._coerce(rule.get("value"), actual)
        if operator == "equals":
            return actual == expected
        return actual != expected

    def apply(self, rules, dt_ms=0.0):
        """Apply enabled rules once. Returns indexes whose true output applied.

        ``delay_ms`` is an on-delay: a matching level condition must remain
        true for the configured duration before ``true_value`` is written.
        Edge operators are pulses and therefore ignore the timer.
        """
        applied = []
        seen = set()

        for index, rule in enumerate(rules or []):
            if not rule.get("enabled", True):
                continue

            source = rule.get("source") or {}
            destination = rule.get("destination") or {}
            tag_name = source.get("tag_name")
            if tag_name:
                key = (index, "tag", tag_name)
                actual, ok = self._read_tag(tag_name)
            else:
                key = (index, source.get("object_tag"), source.get("io_point"))
                actual, ok = self._read(source.get("object_tag"), source.get("io_point"))
            if not ok:
                self._previous_values.pop(key, None)
                self._timers_ms.pop(key, None)
                continue

            previous = self._previous_values.get(key)
            self._previous_values[key] = actual
            condition = self._condition(actual, rule, previous)

            operator = rule.get("operator", "truthy")
            delay_ms = 0.0
            try:
                delay_ms = max(0.0, float(rule.get("delay_ms", 0) or 0))
            except (TypeError, ValueError):
                delay_ms = 0.0

            if operator in {"rising", "falling"}:
                active = condition
            elif condition and delay_ms > 0:
                elapsed = self._timers_ms.get(key, 0.0) + max(0.0, float(dt_ms))
                self._timers_ms[key] = elapsed
                active = elapsed >= delay_ms
            else:
                if not condition:
                    self._timers_ms.pop(key, None)
                else:
                    self._timers_ms.pop(key, None)
                active = condition

            dest_obj = self.scene.objects.get(destination.get("object_tag"))
            if dest_obj is None:
                continue
            dest_point = dest_obj.get_plc_io_points().get(destination.get("io_point"))
            if dest_point is None or dest_point[1] is None:
                continue

            value = rule.get("true_value", True) if active else rule.get("false_value", False)
            dest_getter = dest_point[0]
            if dest_getter is not None:
                value = self._coerce(value, dest_getter())
            try:
                dest_point[1](value)
            except (TypeError, ValueError):
                continue

            if active:
                applied.append(index)
            seen.add(key)

        # Drop stale runtime state after rules are deleted/reordered.
        valid_keys = set()
        for i, r in enumerate(rules or []):
            s = r.get("source") or {}
            if s.get("tag_name"):
                valid_keys.add((i, "tag", s.get("tag_name")))
            else:
                valid_keys.add((i, s.get("object_tag"), s.get("io_point")))
        for key in list(self._previous_values):
            if key not in valid_keys:
                self._previous_values.pop(key, None)
                self._timers_ms.pop(key, None)
        return applied