# core/components/tower_light.py
"""Qt-free port of ui/tower_light.py's TowerLightItem.

A 4-lamp signal tower with fixed-color lamps (red/blue/green/yellow,
stacked top to bottom), each independently on/off. Unlike
PushButtonBehavior/EmergencyPushButtonBehavior/ToggleSwitchBehavior,
each lamp HAS a setter -- this is a PLC output (the PLC drives the
lamps), not operator input, so lamps are settable both via
apply_command() (PLC writes / the web UI clicking a lamp) and via
apply_property(). Desktop only exposed per-lamp toggling through a
right-click context menu; the web UI exposes it as a left-click on
each lamp segment instead (see renderTowerLight() in app.js).
"""

from core.sim_object import SimObject

LAMP_ORDER = ("red", "blue", "green", "yellow")


class TowerLightBehavior(SimObject):
    TYPE = "tower_light"

    DEFAULT_SIZE_W = 24.0
    DEFAULT_SIZE_H = 90.0

    MIN_ITEM_WIDTH = 10.0
    MIN_ITEM_HEIGHT = 30.0

    def __init__(self, name, x=0.0, y=0.0, width=None, height=None):
        width = self.DEFAULT_SIZE_W if width is None else float(width)
        height = self.DEFAULT_SIZE_H if height is None else float(height)

        width = max(self.MIN_ITEM_WIDTH, width)
        height = max(self.MIN_ITEM_HEIGHT, height)

        super().__init__(name, x=x, y=y, width=width, height=height)

        # Runtime-only -- always resets to all-off on creation, same
        # convention as running/extended/pressed/on elsewhere.
        self.lamp_states = {name: False for name in LAMP_ORDER}

    # ---------- Size ----------

    def set_width(self, value):
        self.width = max(self.MIN_ITEM_WIDTH, float(value))

    def get_width(self):
        return self.width

    def set_height(self, value):
        self.height = max(self.MIN_ITEM_HEIGHT, float(value))

    def get_height(self):
        return self.height

    # ---------- Lamp states ----------

    def set_lamp(self, color_name, value):
        if color_name not in LAMP_ORDER:
            return
        self.lamp_states[color_name] = bool(int(value))

    def get_lamp(self, color_name):
        return bool(self.lamp_states.get(color_name, False))

    def toggle_lamp(self, color_name):
        self.set_lamp(color_name, not self.lamp_states.get(color_name, False))

    def set_red(self, value):
        self.set_lamp("red", value)

    def get_red(self):
        return self.get_lamp("red")

    def set_blue(self, value):
        self.set_lamp("blue", value)

    def get_blue(self):
        return self.get_lamp("blue")

    def set_green(self, value):
        self.set_lamp("green", value)

    def get_green(self):
        return self.get_lamp("green")

    def set_yellow(self, value):
        self.set_lamp("yellow", value)

    def get_yellow(self):
        return self.get_lamp("yellow")

    # ---------- Simulation ----------

    def advance_animation(self, dt_ms):
        # No independent animation -- lamps are driven by PLC writes
        # (apply_command) or the web UI's per-lamp click.
        pass

    # ---------- PLC ----------

    def get_plc_io_points(self):
        return {
            "red": (self.get_red, self.set_red),
            "green": (self.get_green, self.set_green),
            "blue": (self.get_blue, self.set_blue),
            "yellow": (self.get_yellow, self.set_yellow),
        }

    # ---------- Serialization ----------

    def to_dict(self):
        io_points = self.get_plc_io_points()

        state = {
            "type": self.TYPE,
            "tag_name": self.tag_name,

            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "layer": self.layer,

            "_io_points": {
                point_name: setter is not None
                for point_name, (_getter, setter)
                in io_points.items()
            },
        }

        for color_name in LAMP_ORDER:
            state[color_name] = self.lamp_states[color_name]

        return state