# core/sim_object.py

from core.io import Signal


class SimObject:
    """Base class for all simulated PLC-connected components. Qt-free —
    holds only identity + geometry needed by any component type."""

    def __init__(self, name: str, x: float = 0.0, y: float = 0.0,
                 width: float = 0.0, height: float = 0.0):
        self.tag_name = name
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.layer = 0

        # Common machine-object operational state.  These fields are
        # deliberately kept in the model layer so Simulation, PLC mapping,
        # alarms and Runtime can consume the same state later.
        self.mode = "auto"
        self.fault = False
        self.emergency_stop = False

    # Position -- shared by every component type, used by the
    # Properties panel's X/Y fields.
    def set_x(self, value: float) -> None:
        self.x = float(value)

    def get_x(self) -> float:
        return self.x

    def set_y(self, value: float) -> None:
        self.y = float(value)

    def get_y(self) -> float:
        return self.y

    # Stacking order -- shared by every component type, used by the
    # Properties panel's Layer field and rendered as CSS z-index.
    # Higher draws on top.
    def set_layer(self, value: float) -> None:
        self.layer = int(float(value))

    def get_layer(self) -> int:
        return self.layer

    def set_mode(self, value) -> None:
        value = str(value).lower()
        self.mode = value if value in ("auto", "manual") else "auto"

    def get_mode(self) -> str:
        return self.mode

    def set_fault(self, value) -> None:
        self.fault = bool(int(value)) if not isinstance(value, bool) else value

    def get_fault(self) -> bool:
        return self.fault

    def set_emergency_stop(self, value) -> None:
        self.emergency_stop = bool(int(value)) if not isinstance(value, bool) else value

    def get_emergency_stop(self) -> bool:
        return self.emergency_stop

    def is_safety_blocked(self) -> bool:
        return bool(self.fault or self.emergency_stop)

    def advance_animation(self, dt_ms: float) -> None:
        raise NotImplementedError

    def get_io_signals(self) -> list[Signal]:
        """Typed signal descriptors. Components can override this; the
        compatibility method below is kept for existing PLC adapters."""
        return [
            Signal(name, getter, setter, datatype=type(getter()))
            for name, (getter, setter) in self.get_plc_io_points().items()
        ]

    def get_plc_io_points(self) -> dict:
        """Return {point_name: (getter, setter_or_None)}."""
        raise NotImplementedError

    def to_dict(self) -> dict:
        """Serialize current state for the web frontend."""
        state = {"tag_name": self.tag_name, "layer": self.layer, "mode": self.mode, "fault": self.fault, "emergency_stop": self.emergency_stop}
        io_points = self.get_plc_io_points()
        for point_name, (getter, _setter) in io_points.items():
            state[point_name] = getter()

        # Point metadata for the PLC Mapping panel: which fields above
        # are actual PLC-facing I/O points (as opposed to design-time
        # fields like width/height added by subclasses), and each
        # one's direction -- mirrors mapping_dialog.py's
        # `is_plc_to_oms = setter is not None` rule. Recomputed from
        # get_plc_io_points() every tick (not cached), so it always
        # reflects live state -- e.g. CylinderBehavior's point set
        # changes with valve_type.
        state["_io_points"] = {
            point_name: setter is not None
            for point_name, (_getter, setter) in io_points.items()
        }
        return state