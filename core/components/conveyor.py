# core/components/conveyor.py
from core.sim_object import SimObject

MIN_WIDTH = 30  # matches ui/simulation_view.py's MIN_WIDTH in the original app


class ConveyorBehavior(SimObject):
    """Qt-free conveyor logic extracted from ConveyorItem. Dropped:
    paint(), mouse/context-menu handlers, label code, and _anim_phase
    (purely visual — drove arrow/roller drawing only)."""

    ANIM_SPEED_SCALE = 0.4

    MIN_THICKNESS = 4
    MAX_THICKNESS = 200

    MIN_BOX_SIZE = 5
    MAX_BOX_SIZE = 200
    DEFAULT_BOX_WIDTH = 30
    DEFAULT_BOX_HEIGHT = 24

    MIN_BOX_COUNT = 1
    DEFAULT_BOX_COUNT = 1

    BOX_HEIGHT_MARGIN = 2

    def __init__(self, name, x=0.0, y=0.0, width=300.0, height=70.0,
                 box_width=None):
        super().__init__(name, x, y, width, height)

        self.rotation = 0.0
        self.direction_forward = True
        self.speed = 50.0
        self.running = False

        self.box_width = box_width or self.DEFAULT_BOX_WIDTH
        self.box_height = min(self.DEFAULT_BOX_HEIGHT, self._max_box_height())
        self.box_count = self.DEFAULT_BOX_COUNT
        self.box_positions = [0.0]
        self._spawn_accumulator = 0.0

    # ---------- Geometry (design-time, Properties panel) ----------

    def set_width(self, value: float):
        self.width = max(MIN_WIDTH, float(value))
        self._reclamp_box_count()

    def get_width(self) -> float:
        return self.width

    def set_height(self, value: float):
        """Set conveyor height and ensure the box stays strictly smaller than it."""
        self.height = max(self.MIN_THICKNESS, min(self.MAX_THICKNESS, float(value)))
        max_box_height = self._max_box_height()
        if self.box_height > max_box_height:
            self.box_height = max_box_height

    def get_height(self) -> float:
        return self.height

    def set_rotation_value(self, value: float):
        self.rotation = float(value) % 360.0

    def get_rotation_value(self) -> float:
        return self.rotation

    # ---------- Speed / Running / Direction (PLC-facing I/O) ----------

    def set_speed(self, value: float):
        self.speed = float(value)

    def get_speed(self) -> float:
        return self.speed

    def set_running(self, value):
        self.running = bool(int(value))

    def get_running(self) -> bool:
        return self.running

    def get_running_status(self) -> int:
        return int(self.running)

    def set_direction(self, value: int):
        self.direction_forward = bool(int(value))

    def get_direction(self) -> bool:
        return self.direction_forward

    # ---------- Traveling box(es) (design-time, Properties panel) ----------

    def set_box_width(self, value: float):
        self.box_width = max(self.MIN_BOX_SIZE, min(self.MAX_BOX_SIZE, float(value)))
        self._reclamp_box_count()

    def get_box_width(self) -> float:
        return self.box_width

    def set_box_height(self, value: float):
        """Set box height, never allowing it to reach or exceed the
        conveyor's own height."""
        max_height = min(self.MAX_BOX_SIZE, self._max_box_height())
        min_height = min(self.MIN_BOX_SIZE, max_height)  # relax the floor
                                                            # if the conveyor
                                                            # itself is very thin
        self.box_height = max(min_height, min(max_height, float(value)))

    def get_box_height(self) -> float:
        return self.box_height

    def set_box_count(self, value):
        """How many boxes should be on the belt at once. 1 = a single
        box that respawns the instant it reaches the end. Clamped so
        boxes can never overlap -- see _max_box_count()."""
        clamped = max(self.MIN_BOX_COUNT, min(self._max_box_count(), int(float(value))))

        if clamped != self.box_count:
            self.box_count = clamped
            # Restart from a clean, evenly-spaced state so a changed
            # count takes effect right away instead of waiting for
            # whatever boxes already exist to cycle out.
            self.box_positions = [0.0]
            self._spawn_accumulator = 0.0

    def get_box_count(self) -> int:
        return self.box_count

    def _max_box_count(self) -> int:
        """The most boxes that can fit on the belt at once without
        overlapping, given the current travel distance and box
        width."""
        travel = max(0.0, self.width - self.box_width)
        if travel <= 0 or self.box_width <= 0:
            return self.MIN_BOX_COUNT
        return max(self.MIN_BOX_COUNT, int(travel // self.box_width))

    def get_max_box_count(self) -> int:
        """Public accessor for the Properties panel."""
        return self._max_box_count()

    def _reclamp_box_count(self):
        """Called whenever width or box_width change, since they
        determine the max box_count that avoids overlap."""
        max_count = self._max_box_count()
        if getattr(self, "box_count", self.MIN_BOX_COUNT) > max_count:
            self.box_count = max_count

    def _max_box_height(self):
        """The tallest a box is allowed to be, given the current conveyor
        height — always strictly less than the conveyor itself."""
        return max(1.0, self.get_height() - self.BOX_HEIGHT_MARGIN)

    def get_max_box_height(self) -> float:
        """Public accessor for the Properties panel."""
        return self._max_box_height()

    # ---------- Belt animation ----------

    def advance_animation(self, dt_ms):
        """Same box-position math as ConveyorItem.advance_animation,
        minus self.update() (repaint hint) and _anim_phase. NOTE: the
        original relied on the caller (SimulationView) to only invoke
        this for running conveyors — I added an explicit `running`
        check here since the web Scene loop will likely tick every
        component unconditionally each frame."""
        if not self.running:
            return

        dt_sec = dt_ms / 1000.0
        direction = 1.0 if self.direction_forward else -1.0
        step = self.speed * self.ANIM_SPEED_SCALE * dt_sec * direction

        travel = max(0.0, self.width - self.box_width)
        spawn_pos = 0.0 if self.direction_forward else travel

        if travel <= 0:
            self.box_positions = [0.0]
            self._spawn_accumulator = 0.0
            return

        advanced = []
        for pos in self.box_positions:
            pos += step
            if self.direction_forward:
                if pos < travel:
                    advanced.append(pos)
            else:
                if pos > 0.0:
                    advanced.append(pos)
        self.box_positions = advanced

        # Spacing isn't stored directly -- it's derived from box_count
        # so that many boxes stay evenly spread across the travel
        # distance, and recomputed every tick so it keeps tracking
        # box_count even if width/box_width change live.
        spacing = travel / self.box_count

        self._spawn_accumulator += abs(step)
        while self._spawn_accumulator >= spacing:
            self._spawn_accumulator -= spacing
            self.box_positions.append(spawn_pos)

        # Safety net: floating-point drift should never leave the belt
        # fully empty for a tick.
        if not self.box_positions:
            self.box_positions = [spawn_pos]
            self._spawn_accumulator = 0.0

    # ---------- PLC I/O mapping (copied verbatim) ----------

    def get_plc_io_points(self):
        return {
            "speed": (self.get_speed, self.set_speed),
            "running": (self.get_running, self.set_running),
            "running_status": (self.get_running_status, None),
            "direction": (self.get_direction, self.set_direction),
        }

    # ---------- Web frontend serialization ----------

    def to_dict(self):
        state = super().to_dict()
        state.update({
            "type": "conveyor",
            "x": self.x,
            "y": self.y,
            "rotation": self.rotation,
            "direction_forward": self.direction_forward,
            "box_positions": list(self.box_positions),
            "box_width": self.box_width,
            "box_height": self.box_height,
            "box_count": self.box_count,
            "width": self.width,
            "height": self.height,
            "max_box_height": self.get_max_box_height(),
            "max_box_count": self.get_max_box_count(),
        })
        return state