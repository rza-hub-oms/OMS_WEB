"""Behavior model for the inductive proximity sensor."""

from core.sim_object import SimObject
from core.io import Signal


class InductiveSensorBehavior(SimObject):
    """Inductive sensor with radial proximity detection."""

    TYPE = "sensor"
    DETECTION_KIND = "inductive"

    DEFAULT_SIZE = 20.0
    MIN_ITEM_WIDTH = 8.0
    MIN_ITEM_HEIGHT = 8.0

    NORMALLY_OPEN = "NO"
    NORMALLY_CLOSED = "NC"
    DEFAULT_MODE = NORMALLY_OPEN
    DEFAULT_DETECTION_DISTANCE = 40.0
    MAX_DETECTION_DISTANCE = 2000.0

    def __init__(self, name, x=0.0, y=0.0, width=None, height=None):
        width = self.DEFAULT_SIZE if width is None else float(width)
        height = self.DEFAULT_SIZE if height is None else float(height)
        width = max(self.MIN_ITEM_WIDTH, width)
        height = max(self.MIN_ITEM_HEIGHT, height)
        super().__init__(name, x=x, y=y, width=width, height=height)

        self.detected = False
        self.input_override = None
        self.mode = self.DEFAULT_MODE
        self.rotation = 0.0
        self.detection_distance = self.DEFAULT_DETECTION_DISTANCE

    def set_width(self, value):
        self.width = max(self.MIN_ITEM_WIDTH, float(value))

    def get_width(self):
        return self.width

    def set_height(self, value):
        self.height = max(self.MIN_ITEM_HEIGHT, float(value))

    def get_height(self):
        return self.height

    def set_rotation_value(self, value):
        self.rotation = float(value) % 360.0

    def get_rotation_value(self):
        return self.rotation

    def set_detection_distance(self, value):
        self.detection_distance = max(0.0, min(self.MAX_DETECTION_DISTANCE, float(value)))

    def get_detection_distance(self):
        return self.detection_distance

    def get_beam_segment(self):
        """Legacy geometry retained for projects and integrations using sensor.py."""
        import math

        ang = math.radians(self.rotation)
        dx, dy = math.cos(ang), math.sin(ang)
        cx = self.x + self.width / 2.0
        cy = self.y + self.height / 2.0
        hw, hh = self.width / 2.0, self.height / 2.0
        half = min(
            hw / abs(dx) if abs(dx) > 1e-9 else float("inf"),
            hh / abs(dy) if abs(dy) > 1e-9 else float("inf"),
        )
        x0, y0 = cx + dx * half, cy + dy * half
        return (x0, y0, x0 + dx * self.detection_distance, y0 + dy * self.detection_distance)

    def set_mode(self, mode):
        if mode not in (self.NORMALLY_OPEN, self.NORMALLY_CLOSED):
            mode = self.DEFAULT_MODE
        self.mode = mode

    def get_mode(self):
        return self.mode

    def set_watch_target(self, tag_name):
        """Deprecated setting; detection uses scene geometry."""
        pass

    def set_detected(self, value):
        self.detected = bool(value)

    def set_input_override(self, value):
        if value is None or (isinstance(value, str) and value.strip().lower() in {"", "auto", "none", "null"}):
            self.input_override = None
        elif isinstance(value, str):
            self.input_override = value.strip().lower() in {"1", "true", "on", "yes"}
        else:
            self.input_override = bool(value)

    def get_input_override(self):
        return self.input_override

    def get_detected(self):
        physical_detected = self.detected if self.input_override is None else self.input_override
        if self.mode == self.NORMALLY_CLOSED:
            return not physical_detected
        return physical_detected

    def advance_animation(self, dt_ms):
        pass

    def get_io_signals(self):
        return [Signal("detected", self.get_detected, None, bool, "Sensor output")]

    def get_plc_io_points(self):
        return {"detected": (self.get_detected, None)}

    def to_dict(self):
        io_points = self.get_plc_io_points()
        return {
            "type": self.TYPE,
            "tag_name": self.tag_name,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "rotation": self.rotation,
            "detection_distance": self.detection_distance,
            "layer": self.layer,
            "detected": self.get_detected(),
            "mode": self.mode,
            "input_override": self.input_override,
            "_io_points": {
                point_name: setter is not None
                for point_name, (_getter, setter) in io_points.items()
            },
        }


# Compatibility name for existing imports and project integrations.
SensorBehavior = InductiveSensorBehavior
