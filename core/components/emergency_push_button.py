# core/components/emergency_push_button.py
"""Qt-free port of ui/emergency_push_button.py's EmergencyPushButtonItem.

Unlike PushButtonBehavior, this is a LATCHING control: pressed stays
True after the pointer is released, and only flips back on a second
click -- mirrors the Qt version's mousePressEvent toggle (its
mouseReleaseEvent is commented out there too). Read-only PLC signal:
a real e-stop is operator input, the PLC never writes to it.
"""

from core.sim_object import SimObject


class EmergencyPushButtonBehavior(SimObject):
    TYPE = "emergency_push_button"

    DEFAULT_SIZE_W = 24.0
    DEFAULT_SIZE_H = 24.0

    MIN_ITEM_WIDTH = 14.0
    MIN_ITEM_HEIGHT = 14.0

    def __init__(self, name, x=0.0, y=0.0, width=None, height=None):
        width = self.DEFAULT_SIZE_W if width is None else float(width)
        height = self.DEFAULT_SIZE_H if height is None else float(height)

        width = max(self.MIN_ITEM_WIDTH, width)
        height = max(self.MIN_ITEM_HEIGHT, height)

        super().__init__(name, x=x, y=y, width=width, height=height)

        # Runtime-only, latching. Set via set_pressed(), called through
        # apply_property() (Properties panel dispatch) -- not
        # apply_command(), since this isn't a PLC-writable point.
        self.pressed = False

    # ---------- Size ----------

    def set_width(self, value):
        self.width = max(self.MIN_ITEM_WIDTH, float(value))

    def get_width(self):
        return self.width

    def set_height(self, value):
        self.height = max(self.MIN_ITEM_HEIGHT, float(value))

    def get_height(self):
        return self.height

    # ---------- Pressed state ----------

    def set_pressed(self, value):
        self.pressed = bool(int(value))

    def get_pressed(self):
        return self.pressed

    def get_not_pressed(self):
        return not self.pressed

    # ---------- Simulation ----------

    def advance_animation(self, dt_ms):
        # Driven entirely by set_pressed() from the web UI click.
        pass

    # ---------- PLC ----------

    def get_plc_io_points(self):
        return {
            "emergency_signal": (self.get_not_pressed, None),
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
            "emergency_signal": self.get_not_pressed(),

            "_io_points": {
                point_name: setter is not None
                for point_name, (_getter, setter)
                in io_points.items()
            },
        }