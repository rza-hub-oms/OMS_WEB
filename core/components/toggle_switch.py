# core/components/toggle_switch.py
"""Qt-free port of ui/toggle_switch.py's ToggleSwitchItem.

Two-state, latching like EmergencyPushButtonBehavior (not momentary
like PushButtonBehavior): stays in whichever state it was last set to
until clicked again. Read-only PLC signals: the switch is operator
input, the PLC never writes to it.
"""

from core.sim_object import SimObject


class ToggleSwitchBehavior(SimObject):
    TYPE = "toggle_switch"

    DEFAULT_SIZE_W = 50.0
    DEFAULT_SIZE_H = 24.0

    MIN_ITEM_WIDTH = 20.0
    MIN_ITEM_HEIGHT = 10.0

    def __init__(self, name, x=0.0, y=0.0, width=None, height=None):
        width = self.DEFAULT_SIZE_W if width is None else float(width)
        height = self.DEFAULT_SIZE_H if height is None else float(height)

        width = max(self.MIN_ITEM_WIDTH, width)
        height = max(self.MIN_ITEM_HEIGHT, height)

        super().__init__(name, x=x, y=y, width=width, height=height)

        # Runtime-only, latching -- always resets to Off on creation,
        # same convention as pressed/running/extended elsewhere. Set
        # via set_on(), called through apply_property() (Properties
        # panel dispatch, and the web UI's click handler below) -- not
        # apply_command(), since this isn't a PLC-writable point.
        self.on = False

    # ---------- Size ----------

    def set_width(self, value):
        self.width = max(self.MIN_ITEM_WIDTH, float(value))

    def get_width(self):
        return self.width

    def set_height(self, value):
        self.height = max(self.MIN_ITEM_HEIGHT, float(value))

    def get_height(self):
        return self.height

    # ---------- On/Off state ----------

    def set_on(self, value):
        self.on = bool(int(value))

    def get_on(self):
        return self.on

    def get_off(self):
        return not self.on

    def toggle(self):
        self.set_on(not self.on)

    # ---------- Simulation ----------

    def advance_animation(self, dt_ms):
        # Driven entirely by set_on()/toggle() from the web UI click.
        pass

    # ---------- PLC ----------

    def get_plc_io_points(self):
        return {
            "on_signal": (self.get_on, None),
            "off_signal": (self.get_off, None),
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

            "on": self.on,
            "on_signal": self.get_on(),
            "off_signal": self.get_off(),

            "_io_points": {
                point_name: setter is not None
                for point_name, (_getter, setter)
                in io_points.items()
            },
        }