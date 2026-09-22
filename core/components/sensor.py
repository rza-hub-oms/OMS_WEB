from core.sim_object import SimObject
from core.io import Signal


class SensorBehavior(SimObject):
    TYPE = "sensor"

    DEFAULT_SIZE = 20.0
    MIN_ITEM_WIDTH = 8.0
    MIN_ITEM_HEIGHT = 8.0

    NORMALLY_OPEN = "NO"
    NORMALLY_CLOSED = "NC"
    DEFAULT_MODE = NORMALLY_OPEN

    def __init__(
        self,
        name,
        x=0.0,
        y=0.0,
        width=None,
        height=None,
    ):
        width = self.DEFAULT_SIZE if width is None else float(width)
        height = self.DEFAULT_SIZE if height is None else float(height)

        width = max(self.MIN_ITEM_WIDTH, width)
        height = max(self.MIN_ITEM_HEIGHT, height)

        super().__init__(
            name,
            x=x,
            y=y,
            width=width,
            height=height,
        )

        # Runtime state
        self.detected = False

        # Design-time configuration
        self.mode = self.DEFAULT_MODE
        self.watch_tag = None

    # ---------- Size ----------

    def set_width(self, value):
        self.width = max(
            self.MIN_ITEM_WIDTH,
            float(value),
        )

    def get_width(self):
        return self.width

    def set_height(self, value):
        self.height = max(
            self.MIN_ITEM_HEIGHT,
            float(value),
        )

    def get_height(self):
        return self.height

    # ---------- Detection mode ----------

    def set_mode(self, mode):
        if mode not in (
            self.NORMALLY_OPEN,
            self.NORMALLY_CLOSED,
        ):
            mode = self.DEFAULT_MODE

        self.mode = mode

    def get_mode(self):
        return self.mode

    def set_watch_target(self, tag_name):
        self.watch_tag = tag_name if tag_name else None

    def get_watch_target(self):
        return self.watch_tag

    # ---------- Runtime detection ----------

    def set_detected(self, value):
        self.detected = bool(value)

    def get_detected(self):
        """
        PLC-visible sensor output.

        NO:
            0 = nothing detected
            1 = object detected

        NC:
            1 = nothing detected
            0 = object detected
        """
        if self.mode == self.NORMALLY_CLOSED:
            return not self.detected

        return self.detected

    # ---------- Simulation ----------

    def advance_animation(self, dt_ms):
        # Sensor has no independent animation.
        # Detection is calculated centrally by Scene.
        pass

    # ---------- PLC ----------

    def get_io_signals(self):
        return [Signal("detected", self.get_detected, None, bool, "Sensor output") ]

    def get_plc_io_points(self):
        return {
            "detected": (
                self.get_detected,
                None,
            ),
        }

    # ---------- Serialization ----------

    def to_dict(self):
        io_points = self.get_plc_io_points()

        return {
            "type": self.TYPE,
            "tag_name": self.tag_name,

            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "layer": self.layer,

            "detected": self.get_detected(),
            "mode": self.mode,
            "watch_tag": self.watch_tag,

            "_io_points": {
                point_name: setter is not None
                for point_name, (_getter, setter)
                in io_points.items()
            },
        }