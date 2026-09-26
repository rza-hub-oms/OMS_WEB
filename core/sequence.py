"""Deterministic step/transition sequence controller for simulation.

Sequences are deliberately small and data-driven so they can be saved in .oms
projects and later mapped to PLC recipes. Runtime never executes them.
"""
from __future__ import annotations


class SequenceEngine:
    OPERATORS = {"truthy", "equals", "not_equals", "rising", "falling"}

    def __init__(self, scene):
        self.scene = scene
        self.reset()

    def reset(self):
        self._states = {}
        self._previous = {}
        self._elapsed = {}
        self._faults = {}
        self.last_status = []

    def _read(self, point):
        point = point or {}
        obj = self.scene.objects.get(point.get("object_tag"))
        if obj is None:
            return None, False
        io = obj.get_plc_io_points().get(point.get("io_point"))
        if io is None or io[0] is None:
            return None, False
        return io[0](), True

    @staticmethod
    def _coerce(value, actual):
        if isinstance(actual, bool):
            if isinstance(value, str):
                return value.strip().lower() in {"1", "true", "on", "yes"}
            return bool(value)
        if isinstance(actual, int) and not isinstance(actual, bool):
            try: return int(value)
            except (TypeError, ValueError): return value
        if isinstance(actual, float):
            try: return float(value)
            except (TypeError, ValueError): return value
        return value

    def _condition(self, condition):
        condition = condition or {}
        actual, ok = self._read(condition)
        if not ok:
            return False
        key = (condition.get("object_tag"), condition.get("io_point"))
        previous = self._previous.get(key)
        self._previous[key] = actual
        op = condition.get("operator", "truthy")
        if op == "truthy": return bool(actual)
        if op == "rising": return bool(actual) and not bool(previous)
        if op == "falling": return bool(previous) and not bool(actual)
        expected = self._coerce(condition.get("value"), actual)
        if op == "equals": return actual == expected
        if op == "not_equals": return actual != expected
        return False

    def _write(self, action):
        destination = action.get("destination") or {}
        obj = self.scene.objects.get(destination.get("object_tag"))
        if obj is None:
            return False
        io = obj.get_plc_io_points().get(destination.get("io_point"))
        if io is None or io[1] is None:
            return False
        value = action.get("value")
        if io[0] is not None:
            value = self._coerce(value, io[0]())
        try:
            io[1](value)
            return True
        except (TypeError, ValueError):
            return False

    def _enter(self, seq_id, index, step):
        self._states[seq_id] = index
        self._elapsed[seq_id] = 0.0
        for action in step.get("actions") or []:
            self._write(action)

    def apply(self, sequences, dt_ms=0.0):
        status = []
        for seq_index, sequence in enumerate(sequences or []):
            seq_id = str(sequence.get("id") or f"sequence_{seq_index + 1}")
            steps = sequence.get("steps") or []
            if not sequence.get("enabled", True) or not steps:
                continue
            state = self._states.get(seq_id, -1)
            if state == -1:
                if sequence.get("auto_start", True) or self._condition(sequence.get("start_condition")):
                    self._enter(seq_id, 0, steps[0])
                    state = 0
                else:
                    status.append(self._status(seq_id, sequence, -1, "idle"))
                    continue

            state = self._states.get(seq_id, state)
            step = steps[state] if 0 <= state < len(steps) else None
            if step is None:
                self._states[seq_id] = -1
                continue
            self._elapsed[seq_id] = self._elapsed.get(seq_id, 0.0) + max(0.0, float(dt_ms))

            # Evaluate the transition exactly once per tick. This is important
            # for edge operators: calling a rising/falling condition twice
            # would consume the edge on the first call.
            transition = self._condition(step.get("transition"))
            timeout_ms = float(step.get("timeout_ms", 0) or 0)
            if timeout_ms > 0 and self._elapsed[seq_id] >= timeout_ms and not transition:
                behavior = step.get("on_timeout", "fault")
                if behavior == "advance" and state + 1 < len(steps):
                    self._enter(seq_id, state + 1, steps[state + 1])
                    state += 1
                elif behavior == "stop":
                    self._states[seq_id] = -1
                    status.append(self._status(seq_id, sequence, -1, "stopped"))
                    continue
                else:
                    self._faults[seq_id] = f"Timeout in step {state + 1}"
                    status.append(self._status(seq_id, sequence, state, "fault"))
                    continue

            if transition:
                if state + 1 < len(steps):
                    self._enter(seq_id, state + 1, steps[state + 1])
                    state += 1
                elif sequence.get("cycle", "once") == "continuous":
                    self._enter(seq_id, 0, steps[0])
                    state = 0
                else:
                    self._states[seq_id] = -1
                    status.append(self._status(seq_id, sequence, -1, "complete"))
                    continue
            status.append(self._status(seq_id, sequence, state, "running"))
        self.last_status = status
        return status

    def current_status(self, sequences):
        rows = []
        for i, seq in enumerate(sequences or []):
            seq_id = str(seq.get("id") or f"sequence_{i + 1}")
            state = self._states.get(seq_id, -1)
            state_name = "running" if state >= 0 else ("fault" if seq_id in self._faults else "idle")
            rows.append(self._status(seq_id, seq, state, state_name))
        return rows

    def start(self, sequence_id):
        self._states[str(sequence_id)] = -1
        self._faults.pop(str(sequence_id), None)

    def stop(self, sequence_id=None):
        if sequence_id is None:
            self.reset()
        else:
            self._states[str(sequence_id)] = -1

    def _status(self, seq_id, sequence, state, state_name):
        steps = sequence.get("steps") or []
        return {
            "id": seq_id,
            "name": sequence.get("name") or seq_id,
            "state": state,
            "step": (steps[state].get("name") if 0 <= state < len(steps) else None),
            "elapsed_ms": round(self._elapsed.get(seq_id, 0.0), 1),
            "status": state_name,
            "fault": self._faults.get(seq_id),
        }
