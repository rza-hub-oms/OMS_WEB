# core/components/label.py
"""Qt-free port of ui/label.py's LabelItem.

Visual-only design-time annotation -- no PLC I/O, no simulation
behavior. Text, font (family/size/bold/italic), and background color
are all editable from the Properties panel via apply_property().
"""

from core.sim_object import SimObject


class LabelBehavior(SimObject):
    TYPE = "label"

    DEFAULT_SIZE_W = 120.0
    DEFAULT_SIZE_H = 40.0

    MIN_ITEM_WIDTH = 20.0
    MIN_ITEM_HEIGHT = 16.0

    DEFAULT_TEXT = "Label"
    DEFAULT_FONT_FAMILY = "Arial"
    DEFAULT_FONT_SIZE = 10
    DEFAULT_BACKGROUND_COLOR = "#2c313a"

    def __init__(self, name, x=0.0, y=0.0, width=None, height=None):
        width = self.DEFAULT_SIZE_W if width is None else float(width)
        height = self.DEFAULT_SIZE_H if height is None else float(height)

        width = max(self.MIN_ITEM_WIDTH, width)
        height = max(self.MIN_ITEM_HEIGHT, height)

        super().__init__(name, x=x, y=y, width=width, height=height)

        self.text = self.DEFAULT_TEXT
        self.font_family = self.DEFAULT_FONT_FAMILY
        self.font_size = self.DEFAULT_FONT_SIZE
        self.bold = False
        self.italic = False
        self.background_color = self.DEFAULT_BACKGROUND_COLOR

    # ---------- Size ----------

    def set_width(self, value):
        self.width = max(self.MIN_ITEM_WIDTH, float(value))

    def get_width(self):
        return self.width

    def set_height(self, value):
        self.height = max(self.MIN_ITEM_HEIGHT, float(value))

    def get_height(self):
        return self.height

    # ---------- Text ----------

    def set_text(self, text):
        self.text = str(text)

    def get_text(self):
        return self.text

    # ---------- Font ----------

    def set_font_family(self, family):
        family = str(family)
        if family:
            self.font_family = family

    def get_font_family(self):
        return self.font_family

    def set_font_size(self, size):
        try:
            size = max(1, int(float(size)))
        except (TypeError, ValueError):
            return
        self.font_size = size

    def get_font_size(self):
        return self.font_size

    def set_bold(self, value):
        self.bold = bool(int(value))

    def get_bold(self):
        return self.bold

    def set_italic(self, value):
        self.italic = bool(int(value))

    def get_italic(self):
        return self.italic

    # ---------- Background color ----------

    def set_background_color(self, color):
        color = str(color).strip()
        if color:
            self.background_color = color

    def get_background_color(self):
        return self.background_color

    # ---------- Simulation ----------

    def advance_animation(self, dt_ms):
        # Visual-only, design-time annotation -- nothing to simulate.
        pass

    # ---------- PLC ----------

    def get_plc_io_points(self):
        """Labels are visual-only and expose no PLC I/O."""
        return {}

    # ---------- Serialization ----------

    def to_dict(self):
        return {
            "type": self.TYPE,
            "tag_name": self.tag_name,

            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "layer": self.layer,

            "text": self.text,
            "font_family": self.font_family,
            "font_size": self.font_size,
            "bold": self.bold,
            "italic": self.italic,
            "background_color": self.background_color,

            "_io_points": {},
        }