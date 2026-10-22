# core/scene.py
"""
Scene: holds every simulated component and advances them together each
tick. This replaces the Qt QGraphicsScene as the "source of truth" for
component state, so the web backend (and later, plc_sync.py) can work
against a plain Python object instead of a live Qt widget tree.

Simulation cycle matches the original Qt app's ANIMATION_INTERVAL_MS
(see project_structure.txt): 50 ms.
"""

import math

from core.components.conveyor import ConveyorBehavior
from core.components.cylinder import CylinderBehavior
from core.components.motor import MotorBehavior
from core.components.inductive_sensor import InductiveSensorBehavior, SensorBehavior
from core.components.photoelectric_sensor import PhotoelectricSensorBehavior
from core.components.push_button import PushButtonBehavior
from core.components.push_button import PushButtonBehavior
from core.components.emergency_push_button import EmergencyPushButtonBehavior
from core.components.toggle_switch import ToggleSwitchBehavior
from core.components.tower_light import TowerLightBehavior
from core.components.label import LabelBehavior
from core.components.index_table import IndexTableBehavior
from core.logic import LogicEngine
from core.sequence import SequenceEngine
from core.tags import TagRegistry
from core.alarms import AlarmEngine

# Maps a serialized "type" string to its behavior class. Extend this as
# more components are ported (toggle_switch, tower_light, etc.).
COMPONENT_REGISTRY = {
    "conveyor": ConveyorBehavior,
    "cylinder": CylinderBehavior,
    "motor": MotorBehavior,
    "sensor": InductiveSensorBehavior,
    "photoelectric_sensor": PhotoelectricSensorBehavior,
    "push_button": PushButtonBehavior,
    "emergency_push_button": EmergencyPushButtonBehavior,
    "toggle_switch": ToggleSwitchBehavior,
    "tower_light": TowerLightBehavior,
    "label": LabelBehavior,
    "index_table": IndexTableBehavior,
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


def _tip_overlaps_target(cylinder: "CylinderBehavior", target) -> bool:
    """Return True when the cylinder's rod tip overlaps a target rectangle."""
    tip_x, tip_y = cylinder.get_rod_tip_position()
    radius = max(4.0, min(12.0, min(target.width, target.height) * 0.15))
    return (
        tip_x + radius >= target.x
        and tip_x - radius <= target.x + target.width
        and tip_y + radius >= target.y
        and tip_y - radius <= target.y + target.height
    )


def _press_sensor(cylinder: "CylinderBehavior", target: SensorBehavior) -> None:
    """Actuate a sensor while the cylinder rod tip is physically over it."""
    target.set_detected(_tip_overlaps_target(cylinder, target))


def _press_push_button(cylinder: "CylinderBehavior", target: PushButtonBehavior) -> None:
    """Press a push button while the cylinder rod tip is physically over it."""
    target.set_pressed(_tip_overlaps_target(cylinder, target))


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
    SensorBehavior: _press_sensor,
    PushButtonBehavior: _press_push_button,
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

        self.connections = []

        self._cylinder_previously_extended = {}
        # Simulation-only control rules. Runtime never executes these; live PLC
        # commands remain the source of truth there.
        self.logic_rules = []
        self.logic_engine = LogicEngine(self)
        self.sequences = []
        self.sequence_engine = SequenceEngine(self)
        self.tags = TagRegistry(self)
        self.alarm_engine = AlarmEngine(self)

    def add(self, obj) -> None:
        """Add a component to the scene, keyed by its tag_name."""
        self.objects[obj.tag_name] = obj

    def remove(self, tag_name: str) -> bool:
        """Remove a component and return whether it existed."""
        if tag_name not in self.objects:
            return False
        del self.objects[tag_name]
        self.tags.remove_object(tag_name)
        # Keep PLC mappings consistent when a component is deleted.
        self.plc_mapping = [
            mapping for mapping in self.plc_mapping
            if mapping.get("object_tag") != tag_name
        ]
        for other in self.objects.values():
            if getattr(other, "parent_tag", None) == tag_name:
                other.parent_tag = None
        self.connections = [
            c for c in self.connections
            if c.get("source") != tag_name and c.get("target") != tag_name
        ]
        return True

    def get(self, tag_name: str):
        return self.objects.get(tag_name)

    def rename_component(self, tag_name: str, new_name: str) -> bool:
        """Rename a component while keeping all scene references consistent.

        Component tags are used as dictionary keys, PLC mapping identifiers,
        sensor watch targets, and cylinder relation targets.  A rename must
        update all of those references atomically so a saved project cannot
        contain dangling links after an otherwise valid UI rename.
        """
        obj = self.objects.get(tag_name)
        new_name = str(new_name).strip()
        if obj is None or not new_name or new_name == tag_name or new_name in self.objects:
            return False

        del self.objects[tag_name]
        obj.tag_name = new_name
        self.objects[new_name] = obj
        self.tags.rename_object(tag_name, new_name)

        for mapping in self.plc_mapping:
            if mapping.get("object_tag") == tag_name:
                mapping["object_tag"] = new_name

        for other in self.objects.values():
            if getattr(other, "parent_tag", None) == tag_name:
                other.parent_tag = new_name
            if isinstance(other, CylinderBehavior) and other.target_tag == tag_name:
                other.target_tag = new_name

        for connection in self.connections:
            if connection.get("source") == tag_name:
                connection["source"] = new_name
            if connection.get("target") == tag_name:
                connection["target"] = new_name

        return True

    def create_component(self, component_type: str, x: float, y: float):
        """Create a new component instance of the given type at (x, y),
        with an auto-generated unique tag name (e.g. "Conveyor_2"),
        mirroring the original Qt app's add_conveyor()-style naming.
        Returns the new object, or None if component_type is unknown."""
        behavior_cls = COMPONENT_REGISTRY.get(component_type)
        if behavior_cls is None:
            return None

        self._type_counters[component_type] = self._type_counters.get(component_type, 0) + 1
        prefixes = {"photoelectric_sensor": "PhotoelectricSensor"}
        tag_name = f"{prefixes.get(component_type, component_type.capitalize())}_{self._type_counters[component_type]}"

        obj = behavior_cls(tag_name, x=x, y=y)
        self.add(obj)
        self.tags.sync()
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
            if isinstance(obj, (ConveyorBehavior, MotorBehavior, IndexTableBehavior)):
                obj.set_running(False)

    def reset_simulation_state(self) -> None:
        """Clears every component from the scene -- used by the "Reset
        View" button. Equivalent to Clear View, but done as one
        backend call instead of one delete_component message per
        component."""
        self.objects.clear()
        self.tags.custom.clear()
        self.tags.sync()
        self.alarm_engine.reset(clear_history=True)
        self._type_counters.clear()
        self._cylinder_previously_extended.clear()
        self.plc_mapping.clear()
        self.connections.clear()
        self.logic_rules.clear()
        self.logic_engine.reset()
        self.sequences.clear()
        self.sequence_engine.reset()

    def tick(self, dt_seconds: float = TICK_MS / 1000.0, simulate: bool = True, logic_enabled: bool = False) -> None:
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
                elif isinstance(obj, (ConveyorBehavior, MotorBehavior, IndexTableBehavior)):
                    # E-Stop cuts drive power immediately -- without
                    # this, `running` stays True and the belt/status
                    # CSS keeps animating client-side even though the
                    # backend is frozen.
                    obj.set_running(False)
            # Safety alarms must still be evaluated while the machine is
            # stopped; an E-Stop is itself a common alarm condition.
            self.tags.evaluate_expressions()
            self.alarm_engine.evaluate()
            return

        for obj in self.objects.values():
            obj.advance_animation(dt_ms)

        self._update_sensors()
        self._handle_cylinder_relations()
        if logic_enabled:
            self.logic_engine.apply(self.logic_rules, dt_ms)
            self.sequence_engine.apply(self.sequences, dt_ms)

        # Derived internal tags are evaluated last so they see the final
        # component/logic state of this simulation tick.
        self.tags.evaluate_expressions()
        self.alarm_engine.evaluate()

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

            if not obj.target_tag:
                continue

            target = self.objects.get(obj.target_tag)
            if target is None:
                continue

            # Physical momentary targets must be released as soon as the
            # cylinder is no longer fully extended over them. Conveyor
            # interaction is intentionally one-shot/position based and
            # does not need a release operation.
            if isinstance(target, SensorBehavior):
                target.set_detected(
                    extending
                    and obj.progress >= 1.0
                    and _tip_overlaps_target(obj, target)
                )
                continue

            if isinstance(target, PushButtonBehavior):
                target.set_pressed(
                    extending
                    and obj.progress >= 1.0
                    and _tip_overlaps_target(obj, target)
                )
                continue

            if not extending or obj.progress < 1.0:
                continue

            handler = CYLINDER_RELATION_HANDLERS.get(type(target))
            if handler is not None:
                handler(obj, target)
                            
    @staticmethod
    def _conveyor_box_polys(conveyor):
        """World-space corner polygons of the boxes on a conveyor,
        honoring the conveyor's rotation (matches the renderer layout)."""
        import math

        box_w = getattr(conveyor, "box_width", 0.0)
        box_h = getattr(conveyor, "box_height", None)
        if box_h is None:
            box_h = min(24.0, conveyor.height - 4.0)
        travel = max(0.0, conveyor.width - box_w)
        cx = conveyor.x + conveyor.width / 2.0
        cy = conveyor.y + conveyor.height / 2.0
        ang = math.radians(getattr(conveyor, "rotation", 0.0) or 0.0)
        cos_a, sin_a = math.cos(ang), math.sin(ang)
        top = conveyor.y + (conveyor.height - box_h) / 2.0

        rects = []
        for pos in getattr(conveyor, "box_positions", None) or []:
            left = conveyor.x + min(pos, travel)
            poly = []
            for px, py in (
                (left, top), (left + box_w, top),
                (left + box_w, top + box_h), (left, top + box_h),
            ):
                dx, dy = px - cx, py - cy
                poly.append((cx + dx * cos_a - dy * sin_a,
                             cy + dx * sin_a + dy * cos_a))
            rects.append(poly)
        return rects

    @staticmethod
    def _segment_hits_polygon(seg, poly) -> bool:
        """True if line segment seg=(x0,y0,x1,y1) touches the convex polygon."""
        x0, y0, x1, y1 = seg
        dx, dy = x1 - x0, y1 - y0
        # Orient polygon counter-clockwise (shoelace) for inside tests.
        area = sum(poly[i][0] * poly[(i + 1) % len(poly)][1]
                   - poly[(i + 1) % len(poly)][0] * poly[i][1]
                   for i in range(len(poly)))
        pts = poly if area >= 0 else poly[::-1]
        t0, t1 = 0.0, 1.0
        for i in range(len(pts)):
            ax, ay = pts[i]
            bx, by = pts[(i + 1) % len(pts)]
            ex, ey = bx - ax, by - ay
            # inside when cross(edge, p - a) >= 0
            num = ex * (y0 - ay) - ey * (x0 - ax)
            den = ex * dy - ey * dx
            if abs(den) < 1e-12:
                if num < 0:
                    return False
                continue
            t = -num / den
            if den > 0:
                t0 = max(t0, t)
            else:
                t1 = min(t1, t)
            if t0 > t1:
                return False
        return True

    @staticmethod
    def _cylinder_polys(cyl) -> list:
        g = cyl._geometry()
        b = g["body"]
        tip = g["rod_min"] + (g["rod_max"] - g["rod_min"]) * cyl.progress
        rod_h = cyl.height * 0.3
        mid = cyl.height / 2.0
        rects = [
            (b["x"], b["y"], b["x"] + b["width"], b["y"] + b["height"]),
            (g["rod_min"], mid - rod_h / 2.0, max(tip, g["rod_min"]) + 2.0, mid + rod_h / 2.0),
        ]
        return [[cyl._local_to_scene(x, y) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
                for x0, y0, x1, y1 in rects]

    @staticmethod
    def _cylinder_piston_poly(cyl) -> list | None:
        """Return only the moving internal piston marker, in scene coordinates.

        Inductive limit sensors mounted along the cylinder barrel detect the
        magnetic piston through the housing. They must not detect the fixed
        cylinder body or exposed rod, which would keep the input on all the
        time or make the rod tip act like a mechanical switch.
        """
        zone = next((item for item in cyl.get_detectable_zones() if item["type"] == "piston"), None)
        if zone is None:
            return None
        x0, y0 = zone["x"], zone["y"]
        x1, y1 = x0 + zone["width"], y0 + zone["height"]
        return [
            cyl._local_to_scene(x0, y0),
            cyl._local_to_scene(x1, y0),
            cyl._local_to_scene(x1, y1),
            cyl._local_to_scene(x0, y1),
        ]

    @staticmethod
    def _object_body_poly(obj) -> list:
        """Body rectangle of any object as a polygon, rotated about its centre."""
        import math
        w, h = float(obj.width), float(obj.height)
        cx, cy = obj.x + w / 2.0, obj.y + h / 2.0
        a = math.radians(getattr(obj, "rotation", 0.0) or 0.0)
        c, s = math.cos(a), math.sin(a)
        return [(cx + dx * c - dy * s, cy + dx * s + dy * c)
                for dx, dy in ((-w/2, -h/2), (w/2, -h/2), (w/2, h/2), (-w/2, h/2))]

    @staticmethod
    def _point_near_polygon(point, poly, distance) -> bool:
        """Whether a point is inside a polygon or within distance of its edge."""
        px, py = point
        inside = False
        min_distance_sq = float("inf")
        for i, (ax, ay) in enumerate(poly):
            bx, by = poly[(i + 1) % len(poly)]
            if (ay > py) != (by > py):
                cross_x = (bx - ax) * (py - ay) / (by - ay) + ax
                if px < cross_x:
                    inside = not inside
            vx, vy = bx - ax, by - ay
            length_sq = vx * vx + vy * vy
            t = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / length_sq)) if length_sq else 0.0
            dx, dy = px - (ax + t * vx), py - (ay + t * vy)
            min_distance_sq = min(min_distance_sq, dx * dx + dy * dy)
        return inside or min_distance_sq <= distance * distance

    def _update_sensors(self) -> None:
        """Update sensor detection.

        Photoelectric sensors detect anything crossing their beam. Inductive
        sensors detect nearby parts; for cylinders they detect only the moving
        piston zone, so barrel-mounted sensors work as end-position switches
        without being held on by the fixed cylinder housing.
        """
        for obj in self.objects.values():
            if not isinstance(obj, SensorBehavior):
                continue

            detected = False
            seg = obj.get_beam_segment() if isinstance(obj, PhotoelectricSensorBehavior) else None
            sensor_center = (obj.x + obj.width / 2.0, obj.y + obj.height / 2.0)

            for target in self.objects.values():
                if target is obj:
                    continue

                if isinstance(target, ConveyorBehavior):
                    box_positions = getattr(target, "box_positions", None)
                    if not box_positions:
                        continue
                    for poly in self._conveyor_box_polys(target):
                        hit = (self._segment_hits_polygon(seg, poly) if seg else
                               self._point_near_polygon(sensor_center, poly, obj.detection_distance))
                        if hit:
                            detected = True
                            break

                elif isinstance(target, CylinderBehavior):
                    if seg is None:
                        # Inductive sensors mounted beside the barrel see
                        # the moving magnetic piston, not the housing/rod.
                        piston_poly = self._cylinder_piston_poly(target)
                        # The 2D layout uses X/Y for the floor plane. Include
                        # the separate altitude coordinate as the third axis;
                        # the sensor's sensing face is at local height 12 and
                        # the piston center follows CylinderBehavior's 3D model.
                        sensor_height = float(getattr(obj, "z", 0.0)) + 12.0
                        piston_height = float(getattr(target, "z", 0.0)) + max(
                            12.0, float(target.height) * 0.25
                        )
                        vertical_gap = abs(sensor_height - piston_height)
                        range_sq = float(obj.detection_distance) ** 2
                        horizontal_range = (
                            math.sqrt(max(0.0, range_sq - vertical_gap ** 2))
                            if vertical_gap <= float(obj.detection_distance)
                            else -1.0
                        )
                        detected = bool(
                            piston_poly
                            and horizontal_range >= 0.0
                            and self._point_near_polygon(sensor_center, piston_poly, horizontal_range)
                        )
                    else:
                        for poly in self._cylinder_polys(target):
                            if self._segment_hits_polygon(seg, poly):
                                detected = True
                                break

                else:
                    # Any other object (motor, index table, label, light,
                    # buttons, ...): detect its rotated body rectangle.
                    poly = self._object_body_poly(target)
                    hit = (self._segment_hits_polygon(seg, poly) if seg else
                           self._point_near_polygon(sensor_center, poly, obj.detection_distance))
                    if hit:
                        detected = True

                if detected:
                    break

            obj.set_detected(detected)

    def alarm_snapshot(self) -> dict:
        """Return current alarm definitions, active alarms and history."""
        return self.alarm_engine.snapshot()

    # ---------- Machine hierarchy / engineering connections ----------

    def set_parent(self, child_tag: str, parent_tag: str | None) -> bool:
        child = self.objects.get(child_tag)
        parent = self.objects.get(parent_tag) if parent_tag else None
        if child is None or child_tag == parent_tag:
            return False
        if parent_tag and parent is None:
            return False
        cursor = parent_tag
        seen = set()
        while cursor:
            if cursor in seen:
                return False
            seen.add(cursor)
            if cursor == child_tag:
                return False
            node = self.objects.get(cursor)
            cursor = getattr(node, "parent_tag", None) if node else None
        child.set_parent_tag(parent_tag)
        return True

    def hierarchy(self) -> list[dict]:
        children = {name: [] for name in self.objects}
        roots = []
        for name, obj in self.objects.items():
            parent = getattr(obj, "parent_tag", None)
            if parent in children and parent != name:
                children[parent].append(name)
            else:
                roots.append(name)
        for values in children.values():
            values.sort()
        roots.sort()

        def node(name):
            obj = self.objects[name]
            return {
                "tag_name": name,
                "type": getattr(obj, "TYPE", name.split("_")[0].lower()),
                "children": [node(child) for child in children[name]],
            }
        return [node(name) for name in roots]

    def add_connection(self, source: str, target: str, kind: str = "process", label: str = "") -> bool:
        if source not in self.objects or target not in self.objects or source == target:
            return False
        kind = str(kind or "process").strip().lower()
        if kind not in {"process", "control", "signal", "mechanical", "safety"}:
            return False
        if any(c.get("source") == source and c.get("target") == target and c.get("kind") == kind for c in self.connections):
            return False
        self.connections.append({"source": source, "target": target, "kind": kind, "label": str(label or "")})
        return True

    def remove_connection(self, index: int) -> bool:
        if not isinstance(index, int) or index < 0 or index >= len(self.connections):
            return False
        self.connections.pop(index)
        return True

    def validate_connections(self) -> list[dict]:
        errors = []
        for index, connection in enumerate(self.connections):
            if connection.get("source") not in self.objects:
                errors.append({"index": index, "error": "Connection source component does not exist."})
            if connection.get("target") not in self.objects:
                errors.append({"index": index, "error": "Connection target component does not exist."})
            if connection.get("source") == connection.get("target"):
                errors.append({"index": index, "error": "A component cannot connect to itself."})
        return errors

    def to_dict(self) -> dict:
        """Serialize every component's current state, keyed by tag_name.
        This is what gets pushed to the browser over WebSocket each tick."""
        result = {}
        for name, obj in self.objects.items():
            state = obj.to_dict()
            state["z"] = obj.get_z() if hasattr(obj, "get_z") else 0.0
            state["parent_tag"] = getattr(obj, "parent_tag", None)
            result[name] = state
        return result

    def engineering_snapshot(self) -> dict:
        return {"hierarchy": self.hierarchy(), "connections": list(self.connections)}

    def validate_logic_rules(self):
        """Return validation errors for configured simulation rules."""
        errors = []
        for index, rule in enumerate(self.logic_rules):
            source = rule.get("source") or {}
            destination = rule.get("destination") or {}
            src_obj = self.objects.get(source.get("object_tag"))
            dst_obj = self.objects.get(destination.get("object_tag"))
            if src_obj is None or source.get("io_point") not in src_obj.get_plc_io_points():
                errors.append({"index": index, "error": "Source I/O point does not exist."})
                continue
            if dst_obj is None:
                errors.append({"index": index, "error": "Destination component does not exist."})
                continue
            point = dst_obj.get_plc_io_points().get(destination.get("io_point"))
            if point is None or point[1] is None:
                errors.append({"index": index, "error": "Destination I/O point is not writable."})
            if rule.get("operator", "truthy") not in LogicEngine.OPERATORS:
                errors.append({"index": index, "error": "Unsupported condition operator."})
        return errors

    def validate_sequences(self):
        errors = []
        for index, sequence in enumerate(self.sequences):
            steps = sequence.get("steps") or []
            if not steps:
                errors.append({"index": index, "error": "Sequence has no steps."})
                continue
            for step_index, step in enumerate(steps):
                transition = step.get("transition")
                if transition:
                    obj = self.objects.get(transition.get("object_tag"))
                    if obj is None or transition.get("io_point") not in obj.get_plc_io_points():
                        errors.append({"index": index, "step": step_index, "error": "Transition I/O point does not exist."})
                for action in step.get("actions") or []:
                    destination = action.get("destination") or {}
                    obj = self.objects.get(destination.get("object_tag"))
                    point = obj.get_plc_io_points().get(destination.get("io_point")) if obj else None
                    if point is None or point[1] is None:
                        errors.append({"index": index, "step": step_index, "error": "Step action destination is not writable."})
        return errors

    def diagnostics(self, plc_validator=None) -> dict:
        """Run a cross-system engineering health check.

        Diagnostics deliberately sits above the individual validators.  It
        checks the relationships that can otherwise fail silently between
        hierarchy, engineering connections, tags, alarms, simulation logic,
        sequences and PLC mappings.  ``plc_validator`` is an optional
        callback supplied by the WebSocket/session layer because PLC address
        syntax depends on the selected backend.
        """
        issues = []

        def add(level, category, message, object_tag=None, detail=""):
            issues.append({
                "level": level,
                "category": category,
                "message": message,
                "object_tag": object_tag,
                "detail": detail,
            })

        # ----- hierarchy -----
        parent_map = {}
        for name, obj in self.objects.items():
            parent = getattr(obj, "parent_tag", None)
            if parent:
                parent_map[name] = parent
                if parent not in self.objects:
                    add("error", "Hierarchy", "Parent component does not exist.", name,
                        f"Parent: {parent}")

        for start in self.objects:
            seen = set()
            cursor = start
            while cursor in parent_map:
                if cursor in seen:
                    add("error", "Hierarchy", "Circular parent relationship detected.", start)
                    break
                seen.add(cursor)
                cursor = parent_map[cursor]

        # ----- engineering connections -----
        connection_errors = self.validate_connections()
        for item in connection_errors:
            add("error", "Connections", item["error"] + f" (connection {item['index'] + 1}).")

        seen_connections = set()
        for index, connection in enumerate(self.connections):
            key = (connection.get("source"), connection.get("target"), connection.get("kind"))
            if key in seen_connections:
                add("error", "Connections", "Duplicate engineering connection.",
                    connection.get("source"), f"Connection {index + 1} duplicates another connection.")
            seen_connections.add(key)
            if connection.get("kind") not in {"process", "control", "signal", "mechanical", "safety"}:
                add("error", "Connections", "Unknown engineering connection type.",
                    connection.get("source"), f"Type: {connection.get('kind')!r}")

        # ----- central tags -----
        self.tags.sync()
        for tag in self.tags.custom.values():
            if tag.object_tag is not None:
                obj = self.objects.get(tag.object_tag)
                if obj is None:
                    add("error", "Tags", "Internal tag is bound to a missing component.",
                        tag.name, f"Component: {tag.object_tag}")
                elif not any(s.name == tag.io_point for s in obj.get_io_signals()):
                    add("error", "Tags", "Internal tag is bound to a missing I/O point.",
                        tag.name, f"I/O point: {tag.io_point}")
            if tag.expression.strip():
                try:
                    self.tags.evaluate_expression(tag.expression)
                except Exception as exc:
                    add("error", "Tags", "Tag expression cannot be evaluated.",
                        tag.name, str(exc))

        expression_errors = self.tags.evaluate_expressions()
        for item in expression_errors:
            add("error", "Tags", "Derived tag expression has an error.", item.get("name"), item.get("error", ""))

        # ----- alarms -----
        seen_alarm_ids = set()
        for index, alarm in enumerate(self.alarm_engine.definitions):
            alarm_id = alarm.get("id")
            if alarm_id in seen_alarm_ids:
                add("error", "Alarms", "Duplicate alarm ID.", alarm_id)
            seen_alarm_ids.add(alarm_id)
            expression = str(alarm.get("expression") or "").strip()
            if not expression:
                add("warning", "Alarms", "Alarm has no expression and can never become active.", alarm.get("name") or alarm_id)
                continue
            try:
                self.tags.evaluate_expression(expression)
            except Exception as exc:
                add("error", "Alarms", "Alarm expression cannot be evaluated.", alarm.get("name") or alarm_id, str(exc))

        # ----- simulation logic / sequences -----
        for item in self.validate_logic_rules():
            add("error", "Logic", item["error"], detail=f"Rule {item['index'] + 1}")
        for item in self.validate_sequences():
            location = f"Sequence {item['index'] + 1}"
            if "step" in item:
                location += f", step {item['step'] + 1}"
            add("error", "Sequences", item["error"], detail=location)

        # ----- PLC mappings -----
        if not self.plc_mapping:
            add("info", "PLC Mapping", "No PLC mappings are configured. This is normal for Simulation-only projects.")
        seen_mappings = set()
        for index, mapping in enumerate(self.plc_mapping):
            tag_name = mapping.get("tag_name") or mapping.get("object_tag")
            io_point = mapping.get("io_point") or mapping.get("point")
            plc_node = str(mapping.get("plc_node") or "").strip()
            key = (tag_name, io_point)
            if key in seen_mappings:
                add("error", "PLC Mapping", "Duplicate PLC mapping for the same OMS signal.", tag_name,
                    f"I/O point: {io_point}")
            seen_mappings.add(key)
            if mapping.get("tag_name"):
                tag = self.tags.get(mapping.get("tag_name"))
                if tag is None:
                    add("error", "PLC Mapping", "Mapped OMS tag does not exist.", mapping.get("tag_name"),
                        f"Mapping {index + 1}")
            else:
                obj = self.objects.get(mapping.get("object_tag"))
                if obj is None:
                    add("error", "PLC Mapping", "Mapped component does not exist.", mapping.get("object_tag"),
                        f"Mapping {index + 1}")
                elif io_point not in obj.get_plc_io_points():
                    add("error", "PLC Mapping", "Mapped I/O point does not exist on the component.",
                        mapping.get("object_tag"), f"I/O point: {io_point}")
            if not plc_node:
                add("error", "PLC Mapping", "PLC address / node is empty.", tag_name,
                    f"Mapping {index + 1}")

        if plc_validator is not None and self.plc_mapping:
            try:
                for problem in plc_validator() or []:
                    add("error", "PLC Mapping", problem.get("error", "Invalid PLC address."),
                        problem.get("object_tag"), f"PLC node: {problem.get('plc_node')}")
            except Exception as exc:
                add("error", "PLC Mapping", "PLC mapping validation could not be completed.", detail=str(exc))

        # Stable ordering makes the UI and tests deterministic.
        level_order = {"error": 0, "warning": 1, "info": 2}
        issues.sort(key=lambda item: (level_order.get(item["level"], 9), item["category"], item["message"], item.get("object_tag") or ""))
        counts = {
            "error": sum(i["level"] == "error" for i in issues),
            "warning": sum(i["level"] == "warning" for i in issues),
            "info": sum(i["level"] == "info" for i in issues),
        }
        return {
            "valid": counts["error"] == 0,
            "counts": counts,
            "issues": issues,
        }

    def signal_catalog(self) -> list:
        """Return component signals through the central tag registry."""
        self.tags.sync()
        return [
            {
                "object_tag": tag.object_tag,
                "io_point": tag.io_point,
                "tag": tag.name,
                "direction": tag.direction,
                "datatype": tag.datatype,
                "description": tag.description,
            }
            for tag in self.tags.all()
            if tag.system
        ]

    def tag_catalog(self) -> list:
        """Return the complete central OMS tag catalog with live values."""
        rows = []
        for tag in self.tags.all():
            item = tag.to_dict()
            item["value"] = self.tags.read(tag.name)
            item["expression"] = tag.expression
            item["expression_error"] = tag.expression_error
            rows.append(item)
        return sorted(rows, key=lambda row: row["name"])

    def set_tag(self, name: str, value) -> bool:
        return self.tags.write(name, value)

    def add_tag(self, name: str, datatype="bool", value=False, description="", writable=True):
        return self.tags.add_custom(name, datatype, value, description, writable)

    def remove_tag(self, name: str) -> bool:
        return self.tags.remove_custom(name)

    def set_tag_expression(self, name: str, expression: str) -> bool:
        return self.tags.set_expression(name, expression)

    def bind_tag(self, name: str, object_tag: str, io_point: str) -> bool:
        return self.tags.bind_custom(name, object_tag, io_point)

    def unbind_tag(self, name: str) -> bool:
        return self.tags.unbind_custom(name)

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
            return self.rename_component(tag_name, value)

        setter = getattr(obj, f"set_{prop_name}", None)
        if setter is None:
            return False

        try:
            setter(value)
        except (TypeError, ValueError):
            return False
        return True
