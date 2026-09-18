# core/components/push_button.py
"""Qt-free momentary pushbutton behavior, ported from the desktop app's
PushButtonItem (see push_button.py's PySide version): pressed becomes
True only while the web UI's mouse/pointer is held down on the button,
and always returns to False on release -- a momentary control, never a
toggle. Detected by the PLC as a read-only signal; the PLC never writes
to it (a real pushbutton is operator input, not a PLC output)."""

from core.sim_object import SimObject

COLOR_PALETTE = ("Red", "Green", "Blue", "Yellow", "Gray")
DEFAULT_COLOR_NAME = "Red"


class PushButtonBehavior(SimObject):
    TYPE = "push_button"

    DEFAULT_SIZE_W = 20.0
    DEFAULT_SIZE_H = 20.0

    MIN_ITEM_WIDTH = 12.0
    MIN_ITEM_HEIGHT = 12.0

    DEFAULT_COLOR_NAME = DEFAULT_COLOR_NAME

    def __init__(self, name, x=0.0, y=0.0, width=None, height=None):
        width = self.DEFAULT_SIZE_W if width is None else float(width)
        height = self.DEFAULT_SIZE_H if height is None else float(height)

        width = max(self.MIN_ITEM_WIDTH, width)
        height = max(self.MIN_ITEM_HEIGHT, height)

        super().__init__(name, x=x, y=y, width=width, height=height)

        # Runtime-only: reflects the web UI's mouse held down on this
        # button (set via set_pressed(), called through apply_property()
        # -- not apply_command(), since this isn't a PLC-writable point).
        self.pressed = False

        # Design-time
        self.color_name = self.DEFAULT_COLOR_NAME

    # ---------- Size ----------

    def set_width(self, value):
        self.width = max(self.MIN_ITEM_WIDTH, float(value))

    def get_width(self):
        return self.width

    def set_height(self, value):
        self.height = max(self.MIN_ITEM_HEIGHT, float(value))

    def get_height(self):
        return self.height

    # ---------- Color ----------

    def set_color_name(self, name):
        if name not in COLOR_PALETTE:
            name = self.DEFAULT_COLOR_NAME
        self.color_name = name

    def get_color_name(self):
        return self.color_name

    # ---------- Pressed state ----------

    def set_pressed(self, value):
        self.pressed = bool(int(value))

    def get_pressed(self):
        return self.pressed

    def get_not_pressed(self):
        return not self.pressed

    # ---------- Simulation ----------

    def advance_animation(self, dt_ms):
        # No independent animation -- pressed is driven entirely by
        # the web UI's pointer events (or set_pressed() called
        # externally, e.g. a future live-PLC feed).
        pass

    # ---------- PLC ----------

    def get_plc_io_points(self):
        return {
            "pressed_signal": (self.get_pressed, None),
            "released_signal": (self.get_not_pressed, None),
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

            "pressed": self.pressed,
            "pressed_signal": self.pressed,
            "released_signal": not self.pressed,
            "color": self.color_name,

            "_io_points": {
                point_name: setter is not None
                for point_name, (_getter, setter)
                in io_points.items()
            },
        }
