from core.sim_object import SimObject
from core.io import Signal


class MotorBehavior(SimObject):
    """Qt-free industrial motor simulation behavior."""

    TYPE = "motor"

    DEFAULT_SIZE_W = 100.0
    DEFAULT_SIZE_H = 55.0

    MIN_ITEM_WIDTH = 60.0
    MIN_ITEM_HEIGHT = 40.0

    MIN_SPEED = 0.0
    MAX_SPEED = 10000.0
    DEFAULT_SPEED = 0.0

    def __init__(self, name, x=0.0, y=0.0, width=None, height=None):
        width = self.DEFAULT_SIZE_W if width is None else float(width)
        height = self.DEFAULT_SIZE_H if height is None else float(height)

        width = max(self.MIN_ITEM_WIDTH, width)
        height = max(self.MIN_ITEM_HEIGHT, height)

        super().__init__(name, x, y, width, height)

        self.rotation = 0.0
        self.speed = self.DEFAULT_SPEED
        self.running = False
        self.direction_forward = True

        self._rotation_phase = 0.0

    # ------------------------------------------------------------------
    # Geometry
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Motor properties
    # ------------------------------------------------------------------

    def set_speed(self, value):
        self.speed = max(
            self.MIN_SPEED,
            min(self.MAX_SPEED, float(value)),
        )

    def get_speed(self):
        return self.speed

    def set_direction_forward(self, forward):
        self.direction_forward = bool(forward)

    def toggle_direction(self):
        self.set_direction_forward(not self.direction_forward)

    def set_direction(self, value):
        if isinstance(value, str):
            value = value.strip().lower()

            if value in {"forward", "fwd", "true", "1", "on", "cw"}:
                self.direction_forward = True
                return

            if value in {"reverse", "rev", "false", "0", "off", "ccw"}:
                self.direction_forward = False
                return

        self.direction_forward = bool(int(value))

    def get_direction(self):
        return self.direction_forward

    def set_running(self, value):
        if isinstance(value, str):
            value = value.strip().lower()

            if value in {"true", "1", "on", "running", "start"}:
                self.running = True
                return

            if value in {"false", "0", "off", "stopped", "stop"}:
                self.running = False
                return

        self.running = bool(int(value))

    def get_running(self):
        return self.running

    def get_running_status(self):
        return int(self.running)

    # ------------------------------------------------------------------
    # Simulation
    # ------------------------------------------------------------------

    def advance_animation(self, dt_ms):
        if not self.running:
            return

        dt_sec = float(dt_ms) / 1000.0
        direction = 1.0 if self.direction_forward else -1.0

        self._rotation_phase += (
            self.speed * 0.35 * dt_sec * direction
        )

        self._rotation_phase %= 360.0

    @property
    def rotation_phase(self):
        return self._rotation_phase

    # ------------------------------------------------------------------
    # PLC I/O
    # ------------------------------------------------------------------

    def get_io_signals(self):
        return [
            Signal("speed", self.get_speed, self.set_speed, float, "Motor speed"),
            Signal("running", self.get_running, self.set_running, bool, "Run command"),
            Signal("running_status", self.get_running_status, None, int, "Motor running status"),
            Signal("direction", self.get_direction, self.set_direction, bool, "Forward direction command"),
        ]

    def get_plc_io_points(self):
        return {
            "speed": (self.get_speed, self.set_speed),
            "running": (self.get_running, self.set_running),
            "running_status": (self.get_running_status, None),
            "direction": (self.get_direction, self.set_direction),
        }

    # ------------------------------------------------------------------
    # Serialization
    # ------------------------------------------------------------------

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
            "layer": self.layer,

            "speed": self.speed,
            "running": self.running,
            "direction": self.direction_forward,
            "direction_forward": self.direction_forward,

            "running_status": self.get_running_status(),
            "rotation_phase": self._rotation_phase,

            "_io_points": {
                point_name: setter is not None
                for point_name, (_getter, setter)
                in io_points.items()
            },
        }