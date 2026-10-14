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
        # Simulation-only load model. Current is an estimated value for
        # trends/alarms/PLC testing, not a measurement from real hardware.
        self.load_percent = 100.0
        self.nominal_current_a = 10.0

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
        # Separate the requested run command from the effective machine state.
        return int(self.running and not self.is_safety_blocked())

    def set_load_percent(self, value):
        self.load_percent = max(0.0, min(100.0, float(value)))

    def get_load_percent(self):
        return self.load_percent

    def get_current(self):
        """Return a deterministic simulated motor current in amperes."""
        if not self.running or self.is_safety_blocked() or self.speed <= 0:
            return 0.0
        speed_fraction = min(1.0, self.speed / self.MAX_SPEED)
        # Small magnetising current plus load-dependent operating current.
        return round(self.nominal_current_a * speed_fraction *
                     (0.08 + 0.92 * self.load_percent / 100.0), 3)

    # ------------------------------------------------------------------
    # Simulation
    # ------------------------------------------------------------------

    def advance_animation(self, dt_ms):
        if not self.running or self.is_safety_blocked():
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
            Signal("mode", self.get_mode, self.set_mode, str, "Manual/Auto mode"),
            Signal("fault", self.get_fault, self.set_fault, bool, "Machine fault"),
            Signal("emergency_stop", self.get_emergency_stop, self.set_emergency_stop, bool, "Emergency stop"),
            Signal("speed", self.get_speed, self.set_speed, float, "Motor speed"),
            Signal("running", self.get_running, self.set_running, bool, "Run command"),
            Signal("running_status", self.get_running_status, None, int, "Motor running status"),
            Signal("current", self.get_current, None, float, "Simulated motor current (A)"),
            Signal("direction", self.get_direction, self.set_direction, bool, "Forward direction command"),
        ]

    def get_plc_io_points(self):
        return {
            "speed": (self.get_speed, self.set_speed),
            "running": (self.get_running, self.set_running),
            "running_status": (self.get_running_status, None),
            "current": (self.get_current, None),
            "direction": (self.get_direction, self.set_direction),
                    "mode": (self.get_mode, self.set_mode),
            "fault": (self.get_fault, self.set_fault),
            "emergency_stop": (self.get_emergency_stop, self.set_emergency_stop),
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
            "current": self.get_current(),
            "load_percent": self.load_percent,
            "rotation_phase": self._rotation_phase,

            "_io_points": {
                point_name: setter is not None
                for point_name, (_getter, setter)
                in io_points.items()
            },
        }