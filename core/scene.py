# core/scene.py
"""
Scene: holds every simulated component and advances them together each
tick. This replaces the Qt QGraphicsScene as the "source of truth" for
component state, so the web backend (and later, plc_sync.py) can work
against a plain Python object instead of a live Qt widget tree.

Simulation cycle matches the original Qt app's ANIMATION_INTERVAL_MS
(see project_structure.txt): 50 ms.
"""

from core.components.conveyor import ConveyorBehavior
from core.components.cylinder import CylinderBehavior
from core.components.motor import MotorBehavior
from core.components.sensor import SensorBehavior
from core.components.push_button import PushButtonBehavior
from core.components.emergency_push_button import EmergencyPushButtonBehavior
from core.components.toggle_switch import ToggleSwitchBehavior
from core.components.tower_light import TowerLightBehavior
from core.components.label import LabelBehavior

# Maps a serialized "type" string to its behavior class. Extend this as
# more components are ported (toggle_switch, tower_light, etc.).
COMPONENT_REGISTRY = {
    "conveyor": ConveyorBehavior,
    "cylinder": CylinderBehavior,
    "motor": MotorBehavior,
    "sensor": SensorBehavior,
    "push_button": PushButtonBehavior,
    "emergency_push_button": EmergencyPushButtonBehavior,
    "toggle_switch": ToggleSwitchBehavior,
    "tower_light": TowerLightBehavior,
    "label": LabelBehavior,
}

TICK_MS = 50
MAX_DT_S = 0.25


def _push_box_off_conveyor(cylinder: "CylinderBehavior", target: "ConveyorBehavior") -> None:
    """Remove a conveyor box when the cylinder rod tip actually
    overlaps the box.

    Uses the cylinder's actual world-space rod tip, including rotation,
    rather than just comparing footprint x-position, so a visible
    collision is not missed.
    """
    tip_x, tip_y = cylinder.get_rod_tip_position()

    # Give the tip a small contact radius so the 50 ms simulation
    # tick cannot skip a visually obvious hit.
    contact_radius = max(4.0, min(12.0, target.box_width * 0.15))

    kept = []
    for pos in target.box_positions:
        box_left = target.x + pos
        box_right = box_left + target.box_width
        box_top = target.y
        box_bottom = target.y + target.height

        is_hit = (
            tip_x + contact_radius >= box_left
            and tip_x - contact_radius <= box_right
            and tip_y + contact_radius >= box_top
            and tip_y - contact_radius <= box_bottom
        )
        if not is_hit:
            kept.append(pos)

    target.box_positions = kept


# Maps a target component's class to the function that defines what a
# fully-extended cylinder does to it. To give the cylinder a new kind
# of physical relation (e.g. pressing a sensor or a push button), write
# a handler with the same signature -- handler(cylinder, target) -- and
# add it here. Nothing else (the UI dropdown, the tick loop, the
# component-select field) needs to change: the dropdown already offers
# every component type, and the tick loop already looks the target's
# class up in this dict.
CYLINDER_RELATION_HANDLERS = {
    ConveyorBehavior: _push_box_off_conveyor,
}


class Scene:
    """Holds a dict of {tag_name: SimObject} and ticks them all."""

    def __init__(self):
        self.objects = {}
        self._type_counters = {}  # e.g. {"conveyor": 2} -> next name Conveyor_3

        # [{"object_tag": ..., "io_point": ..., "plc_node": ...}, ...]
        # -- the web equivalent of the original SimulationView.plc_mapping,
        # read/written by the PLC Mapping panel and consumed by
        # plc.plc_sync.PlcSyncBase._resolve_mapped_points().
        self.plc_mapping = []

        # {"backend": "s7", "params": {"ip": "...", "rack": 0, "slot": 1}}
        # or {} if never configured. Set by api/websocket.py's
        # _plc_connect() and persisted so Save Project remembers the
        # connection settings (not the live connection itself).
        self.plc_connection = {}

        self._cylinder_previously_extended = {}  

    def add(self, obj) -> None:
        """Add a component to the scene, keyed by its tag_name."""
        self.objects[obj.tag_name] = obj

    def remove(self, tag_name: str) -> bool:
        """Remove a component and return whether it existed."""
        if tag_name not in self.objects:
            return False
        del self.objects[tag_name]
        # Keep PLC mappings consistent when a component is deleted.
        self.plc_mapping = [
            mapping for mapping in self.plc_mapping
            if mapping.get("object_tag") != tag_name
        ]
        return True

    def get(self, tag_name: str):
        return self.objects.get(tag_name)

    def create_component(self, component_type: str, x: float, y: float):
        """Create a new component instance of the given type at (x, y),
        with an auto-generated unique tag name (e.g. "Conveyor_2"),
        mirroring the original Qt app's add_conveyor()-style naming.
        Returns the new object, or None if component_type is unknown."""
        behavior_cls = COMPONENT_REGISTRY.get(component_type)
        if behavior_cls is None:
            return None

        self._type_counters[component_type] = self._type_counters.get(component_type, 0) + 1
        tag_name = f"{component_type.capitalize()}_{self._type_counters[component_type]}"

        obj = behavior_cls(tag_name, x=x, y=y)
        self.add(obj)
        return obj

    def is_emergency_stopped(self) -> bool:
        """True while any EmergencyPushButtonBehavior is latched
        pressed -- the web equivalent of sim_view.emergency_stop()
        freezing the desktop app's animation timer."""
        return any(
            isinstance(obj, EmergencyPushButtonBehavior) and obj.pressed
            for obj in self.objects.values()
        )

    def stop_all_actuators(self) -> None:
        for obj in self.objects.values():
            if isinstance(obj, (ConveyorBehavior, MotorBehavior)):
                obj.set_running(False)

    def reset_simulation_state(self) -> None:
        """Clears every component from the scene -- used by the "Reset
        View" button. Equivalent to Clear View, but done as one
        backend call instead of one delete_component message per
        component."""
        self.objects.clear()
        self._type_counters.clear()
        self._cylinder_previously_extended.clear()
        self.plc_mapping.clear()

    def tick(self, dt_seconds: float = TICK_MS / 1000.0, simulate: bool = True) -> None:
        """Advance every component by one simulation step, then update
        sensor detection against the now-current box positions.

        simulate=False freezes the scene (used for DESIGN mode, where
        components must sit still while being placed/edited). SIMULATION
        and RUNTIME both pass simulate=True -- the difference between
        those two modes is *where commands come from* (operator clicks
        vs. a live PLC via plc_sync), not whether physics runs."""
        if not simulate:
            return

        # The loop uses a monotonic clock, so the simulation is based on
        # real elapsed time rather than assuming the event loop woke up
        # exactly every 50 ms. Cap a long stall so a temporary debugger
        # pause cannot teleport components across the machine.
        dt_seconds = max(0.0, min(float(dt_seconds), MAX_DT_S))
        dt_ms = dt_seconds * 1000.0

        if self.is_emergency_stopped():
            # Everything else freezes, but a single-valve (single-
            # solenoid, spring-return) cylinder loses its holding
            # signal on E-Stop and springs back to retracted. Dual-
            # valve cylinders need an active signal either way, so
            # they just hold position like everything else.
            for obj in self.objects.values():
                if (
                    isinstance(obj, CylinderBehavior)
                    and obj.valve_type == CylinderBehavior.VALVE_SINGLE
                ):
                    obj.set_extended(False)
                    obj.advance_animation(dt_ms)
                elif isinstance(obj, (ConveyorBehavior, MotorBehavior)):
                    # E-Stop cuts drive power immediately -- without
                    # this, `running` stays True and the belt/status
                    # CSS keeps animating client-side even though the
                    # backend is frozen.
                    obj.set_running(False)
            return

        for obj in self.objects.values():
            obj.advance_animation(dt_ms)

        self._update_sensors()
        self._handle_cylinder_relations()

    def _handle_cylinder_relations(self) -> None:
        """Runs each fully-extended cylinder's physical relation (see
        CYLINDER_RELATION_HANDLERS) against its target component, if
        any. Which handler runs depends only on the target's type, so
        a cylinder can be pointed at any component; if no handler is
        registered for that type yet, nothing happens.
        """
        for obj in self.objects.values():
            if not isinstance(obj, CylinderBehavior):
                continue

            # Only interact while the cylinder is commanded to extend.
            if obj.valve_type == obj.VALVE_DUAL:
                extending = obj.extend_command and not obj.retract_command
            else:
                extending = obj.extended

            if not extending or not obj.target_tag or obj.progress < 1.0:
                continue

            target = self.objects.get(obj.target_tag)
            if target is None:
                continue

            handler = CYLINDER_RELATION_HANDLERS.get(type(target))
            if handler is not None:
                handler(obj, target)
                            
    def _update_sensors(self) -> None:
        """Update sensor detection for conveyors and cylinders.

        Conveyor sensors detect moving boxes as before.

        Cylinder sensors detect the cylinder's physical detectable zones.
        In particular, the piston zone moves with cylinder progress, so
        placing a sensor over the rear/front piston position gives a
        retracted/extended limit-switch style signal.
        """
        for obj in self.objects.values():
            if not isinstance(obj, SensorBehavior):
                continue

            target = self.objects.get(obj.watch_tag)
            if target is None:
                obj.set_detected(False)
                continue

            # Conveyor detection: sensor overlaps a moving box.
            if isinstance(target, ConveyorBehavior):
                box_positions = getattr(target, "box_positions", None)
                if not box_positions:
                    obj.set_detected(False)
                    continue

                box_width = getattr(target, "box_width", 0.0)
                conveyor_top = target.y
                conveyor_bottom = target.y + target.height

                vertical_overlap = (
                    conveyor_top < obj.y + obj.height
                    and conveyor_bottom > obj.y
                )

                detected = False
                if vertical_overlap:
                    for pos in box_positions:
                        box_left = target.x + pos
                        box_right = box_left + box_width

                        if (
                            box_left < obj.x + obj.width
                            and box_right > obj.x
                        ):
                            detected = True
                            break

                obj.set_detected(detected)
                continue

            # Cylinder detection: overlap the sensor with either of the
            # cylinder's physical detectable zones.  The piston zone is
            # position-dependent, which makes this work as a limit switch.
            if isinstance(target, CylinderBehavior):
                detected = False

                for zone in target.get_detectable_zone_bounds():
                    if (
                        zone["x"] < obj.x + obj.width
                        and zone["x"] + zone["width"] > obj.x
                        and zone["y"] < obj.y + obj.height
                        and zone["y"] + zone["height"] > obj.y
                    ):
                        detected = True
                        break

                obj.set_detected(detected)
                continue

            # Unknown/non-detectable target type.
            obj.set_detected(False)

    def to_dict(self) -> dict:
        """Serialize every component's current state, keyed by tag_name.
        This is what gets pushed to the browser over WebSocket each tick."""
        return {name: obj.to_dict() for name, obj in self.objects.items()}

    def signal_catalog(self) -> list:
        """Return the typed signal catalog used by the PLC mapping UI."""
        rows = []
        for tag_name in sorted(self.objects):
            obj = self.objects[tag_name]
            signals = obj.get_io_signals()
            for signal in sorted(signals, key=lambda s: s.name):
                rows.append({
                    "object_tag": tag_name,
                    "io_point": signal.name,
                    "direction": signal.direction,
                    "datatype": signal.datatype.__name__ if signal.datatype else None,
                    "description": signal.description,
                })
        return rows

    def io_points_catalog(self) -> list:
        """Every (object_tag, io_point, direction) triple currently in
        the scene, sorted the same way MappingPanel._scan_scene() did
        (by object tag, then point name) -- the web Mapping panel's
        "Rescan Scene" reads this to (re)build its rows."""
        return [
            {
                "object_tag": row["object_tag"],
                "io_point": row["io_point"],
                "direction": row["direction"],
            }
            for row in self.signal_catalog()
        ]

    @staticmethod
    def _coerce_value(text):
        """Same coercion as the original MappingPanel._coerce_value:
        try int, then float, then fall back to the raw string."""
        try:
            return int(text)
        except (TypeError, ValueError):
            pass
        try:
            return float(text)
        except (TypeError, ValueError):
            pass
        return text

    def force_value(self, tag_name: str, io_point: str, value) -> bool:
        """Directly drives an OMS I/O point's setter, bypassing any PLC
        connection -- the web equivalent of the Mapping panel's
        per-row Force Value field, used to test a component without a
        live PLC. Only works for points that have a setter (PLC ->
        OMS direction); OMS -> PLC (read-only/getter-only) points
        can't be forced, matching the original's _apply_force()."""
        obj = self.objects.get(tag_name)
        if obj is None:
            return False

        io_points = obj.get_plc_io_points()
        point = io_points.get(io_point)
        if point is None:
            return False

        _getter, setter = point
        if setter is None:
            return False

        try:
            setter(self._coerce_value(value))
        except (TypeError, ValueError):
            return False
        return True

    def apply_command(self, tag_name: str, point_name: str, value) -> bool:
        """Apply an incoming command (e.g. from the web UI or a PLC write)
        to one component's I/O point. Returns True if applied, False if
        the object/point/setter doesn't exist."""
        obj = self.objects.get(tag_name)
        if obj is None:
            return False

        io_points = obj.get_plc_io_points()
        point = io_points.get(point_name)
        if point is None:
            return False

        _getter, setter = point
        if setter is None:
            return False  # read-only point

        setter(value)
        return True

    def apply_property(self, tag_name: str, prop_name: str, value) -> bool:
        """Apply a design-time edit from the Properties panel (e.g. Width,
        Rotation, Box Spacing) -- unlike apply_command(), this is not
        restricted to the PLC-facing points in get_plc_io_points(); it
        dispatches directly to any set_<prop_name> method the object
        defines, mirroring how the original Properties panel called
        set_width()/set_rotation_value()/etc. directly.

        "name" is handled specially since tag_name is also this dict's
        key -- renaming has to move the entry, not just mutate a field."""
        obj = self.objects.get(tag_name)
        if obj is None:
            return False

        if prop_name == "name":
            new_name = str(value).strip()
            if not new_name or new_name == obj.tag_name or new_name in self.objects:
                return False

            old_name = obj.tag_name

            del self.objects[old_name]
            obj.tag_name = new_name
            self.objects[new_name] = obj

            for mapping in self.plc_mapping:
                if mapping.get("object_tag") == old_name:
                    mapping["object_tag"] = new_name

            return True

        setter = getattr(obj, f"set_{prop_name}", None)
        if setter is None:
            return False

        try:
            setter(value)
        except (TypeError, ValueError):
            return False
        return True