from core.sim_object import SimObject
from core.io import Signal


class IndexTableBehavior(SimObject):
    """Round rotary indexing table (clocking table).

    Rotates in equal steps of 360/stations degrees. While running it
    dwells for ``dwell_ms``, then rotates one step in ``move_ms``, and
    repeats. ``index`` (rising edge) advances a single step while
    stopped. ``step`` is the current station (1..stations).
    """

    TYPE = "index_table"

    DEFAULT_SIZE_W = 140.0
    DEFAULT_SIZE_H = 140.0
    MIN_ITEM_SIZE = 60.0

    MIN_STATIONS = 2
    MAX_STATIONS = 24

    def __init__(self, name, x=0.0, y=0.0, width=None, height=None):
        width = self.DEFAULT_SIZE_W if width is None else float(width)
        height = self.DEFAULT_SIZE_H if height is None else float(height)
        # Keep it round: use the larger side for both.
        size = max(self.MIN_ITEM_SIZE, width, height) if width != height else max(self.MIN_ITEM_SIZE, width)
        super().__init__(name, x, y, size, size)

        self.stations = 6
        self.dwell_ms = 1000.0
        self.move_ms = 500.0
        self.running = False
        self.rotation = 0.0
        self._step = 0            # 0-based current station
        self._moving = False
        self._timer_ms = 0.0
        self._index_cmd = False
        self.cycle_count = 0      # completed full revolutions
        self.step_count = 0       # total steps taken

    # ---------- Geometry ----------
    def set_width(self, value):
        self.width = self.height = max(self.MIN_ITEM_SIZE, float(value))

    def set_height(self, value):
        self.width = self.height = max(self.MIN_ITEM_SIZE, float(value))

    def set_rotation_value(self, value):
        self.rotation = float(value) % 360.0

    # ---------- Settings ----------
    def set_stations(self, value):
        n = int(float(value))
        self.stations = max(self.MIN_STATIONS, min(self.MAX_STATIONS, n))
        self._step %= self.stations

    def get_stations(self):
        return self.stations

    def set_dwell_ms(self, value):
        self.dwell_ms = max(0.0, float(value))

    def set_move_ms(self, value):
        self.move_ms = max(50.0, float(value))

    # ---------- Commands ----------
    def set_running(self, value):
        if isinstance(value, str):
            value = value.strip().lower() in {"true", "1", "on", "running", "start"}
        self.running = bool(value) if isinstance(value, bool) else bool(int(value))

    def get_running(self):
        return self.running

    def set_index(self, value):
        """Single-step command: rising edge advances one station."""
        if isinstance(value, str):
            value = value.strip().lower() in {"true", "1", "on"}
        value = bool(value) if isinstance(value, bool) else bool(int(value))
        if value and not self._index_cmd and not self._moving and not self.is_safety_blocked():
            self._begin_move()
        self._index_cmd = value

    def get_index(self):
        return self._index_cmd

    def set_step(self, value):
        """Set current station (1-based, used by project load / manual homing)."""
        self._step = (int(float(value)) - 1) % self.stations
        self._moving = False
        self._timer_ms = 0.0

    def get_step(self):
        return self._step + 1

    def get_moving(self):
        return self._moving

    def get_in_position(self):
        return not self._moving

    def get_running_status(self):
        return int(self.running and not self.is_safety_blocked())

    def get_cycle_count(self):
        return self.cycle_count

    # ---------- Simulation ----------
    def _begin_move(self):
        self._moving = True
        self._timer_ms = 0.0

    def advance_animation(self, dt_ms):
        if self.is_safety_blocked():
            return
        dt = float(dt_ms)
        if self._moving:
            self._timer_ms += dt
            if self._timer_ms >= self.move_ms:
                self._moving = False
                self._timer_ms = 0.0
                self._index_cmd = False  # one-shot: re-armed for next click
                self._step = (self._step + 1) % self.stations
                self.step_count += 1
                if self._step == 0:
                    self.cycle_count += 1
        elif self.running:
            self._timer_ms += dt
            if self._timer_ms >= self.dwell_ms:
                self._begin_move()

    @property
    def angle(self):
        seg = 360.0 / self.stations
        progress = min(1.0, self._timer_ms / self.move_ms) if self._moving else 0.0
        return (self._step + progress) * seg

    # ---------- PLC I/O ----------
    def get_io_signals(self):
        return [
            Signal("mode", self.get_mode, self.set_mode, str, "Manual/Auto mode"),
            Signal("fault", self.get_fault, self.set_fault, bool, "Machine fault"),
            Signal("emergency_stop", self.get_emergency_stop, self.set_emergency_stop, bool, "Emergency stop"),
            Signal("running", self.get_running, self.set_running, bool, "Start/stop clocking"),
            Signal("index", self.get_index, self.set_index, bool, "Single step (rising edge)"),
            Signal("running_status", self.get_running_status, None, int, "Table running status"),
            Signal("step", self.get_step, None, int, "Current station (1..N)"),
            Signal("moving", self.get_moving, None, bool, "Table is rotating"),
            Signal("in_position", self.get_in_position, None, bool, "Table stopped at a station"),
            Signal("cycle_count", self.get_cycle_count, None, int, "Completed revolutions"),
        ]

    def get_plc_io_points(self):
        return {
            "running": (self.get_running, self.set_running),
            "index": (self.get_index, self.set_index),
            "running_status": (self.get_running_status, None),
            "step": (self.get_step, None),
            "moving": (self.get_moving, None),
            "in_position": (self.get_in_position, None),
            "cycle_count": (self.get_cycle_count, None),
            "mode": (self.get_mode, self.set_mode),
            "fault": (self.get_fault, self.set_fault),
            "emergency_stop": (self.get_emergency_stop, self.set_emergency_stop),
        }

    # ---------- Serialization ----------
    def to_dict(self):
        io_points = self.get_plc_io_points()
        return {
            "type": self.TYPE,
            "tag_name": self.tag_name,
            "x": self.x, "y": self.y,
            "width": self.width, "height": self.height,
            "rotation": self.rotation,
            "layer": self.layer,
            "mode": self.mode, "fault": self.fault, "emergency_stop": self.emergency_stop,
            "stations": self.stations,
            "dwell_ms": self.dwell_ms,
            "move_ms": self.move_ms,
            "running": self.running,
            "running_status": self.get_running_status(),
            "index": self._index_cmd,
            "step": self.get_step(),
            "moving": self._moving,
            "in_position": self.get_in_position(),
            "cycle_count": self.cycle_count,
            "angle": self.angle,
            "_io_points": {k: s is not None for k, (_g, s) in io_points.items()},
        }
