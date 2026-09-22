# core/components/cylinder.py

from __future__ import annotations

import math

from core.sim_object import SimObject


class CylinderBehavior(SimObject):
    """
    Qt-free physical behavior for an industrial pneumatic/hydraulic cylinder.

    This class contains simulation state and PLC-facing I/O only.
    Rendering, mouse handling, menus, labels, and other UI concerns
    belong to the frontend.

    The cylinder is represented by a normalized extension progress:

        0.0 -> fully retracted
        1.0 -> fully extended

    Supported valve modes:

        single:
            One PLC command controls the target state.

        dual:
            Separate extend/retract PLC commands control movement.

    Geometry is kept here because it is part of the machine model and is
    needed by the simulation for physical interactions and sensor detection.
    """

    # ------------------------------------------------------------------
    # Defaults / limits
    # ------------------------------------------------------------------

    DEFAULT_SIZE_W = 150.0
    DEFAULT_SIZE_H = 30.0

    MIN_ITEM_WIDTH = 40.0
    MIN_ITEM_HEIGHT = 24.0

    MIN_SPEED = 0.0
    MAX_SPEED = 5000.0
    DEFAULT_SPEED = 50.0

    # Same movement scaling as the original Qt implementation.
    ANIM_SPEED_SCALE = 0.05

    # Valve configuration
    VALVE_SINGLE = "single"
    VALVE_DUAL = "dual"
    DEFAULT_VALVE_TYPE = VALVE_SINGLE

    # Geometry ratios from the original implementation.
    BODY_WIDTH_RATIO = 0.62
    DETECT_MARKER_WIDTH = 8.0

    def __init__(
        self,
        name: str,
        x: float = 0.0,
        y: float = 0.0,
        width: float | None = None,
        height: float | None = None,
        rotation: float = 0.0,
    ):
        width = (
            self.DEFAULT_SIZE_W
            if width is None
            else max(self.MIN_ITEM_WIDTH, float(width))
        )

        height = (
            self.DEFAULT_SIZE_H
            if height is None
            else max(self.MIN_ITEM_HEIGHT, float(height))
        )

        super().__init__(name, x, y, width, height)

        # Design-time geometry
        self.rotation = float(rotation) % 360.0

        # Runtime state
        self.speed = self.DEFAULT_SPEED

        # Single-valve commanded target.
        self.extended = False

        # Actual physical position.
        self.progress = 0.0

        # Valve configuration.
        self.valve_type = self.DEFAULT_VALVE_TYPE

        # Dual-valve commands.
        self.extend_command = False
        self.retract_command = False

        # One-shot event generated when the cylinder reaches 100%.
        self._was_fully_extended = False
        self._extend_trigger_pending = False

        # Which other component (by tag_name) this cylinder physically
        # interacts with when it reaches full extension. None = disabled.
        # What "interacts with" means depends on the target's component
        # type -- see Scene.CYLINDER_RELATION_HANDLERS, which currently
        # only knows how to push a box off a conveyor, but can gain more
        # handlers (e.g. pressing a sensor or button) without this field
        # or its UI needing to change.
        self.target_tag = None

    # ------------------------------------------------------------------
    # Geometry
    # ------------------------------------------------------------------

    def set_width(self, value: float) -> None:
        self.width = max(self.MIN_ITEM_WIDTH, float(value))

    def get_width(self) -> float:
        return self.width

    def set_height(self, value: float) -> None:
        self.height = max(self.MIN_ITEM_HEIGHT, float(value))

    def get_height(self) -> float:
        return self.height

    def set_rotation_value(self, value: float) -> None:
        self.rotation = float(value) % 360.0

    def get_rotation_value(self) -> float:
        return self.rotation

    # ------------------------------------------------------------------
    # Speed
    # ------------------------------------------------------------------

    def set_speed(self, value: float) -> None:
        self.speed = max(
            self.MIN_SPEED,
            min(self.MAX_SPEED, float(value)),
        )

    def get_speed(self) -> float:
        return self.speed

    # ------------------------------------------------------------------
    # Valve
    # ------------------------------------------------------------------

    def set_target_tag(self, tag_name) -> None:
        self.target_tag = tag_name if tag_name else None

    def get_target_tag(self):
        return self.target_tag

    def set_valve_type(self, value: str) -> None:
        if value not in (self.VALVE_SINGLE, self.VALVE_DUAL):
            value = self.DEFAULT_VALVE_TYPE

        self.valve_type = value

    def get_valve_type(self) -> str:
        return self.valve_type

    # ------------------------------------------------------------------
    # Single-valve command
    # ------------------------------------------------------------------

    def set_extended(self, value) -> None:
        self.extended = bool(int(value))

    def get_extended(self) -> bool:
        """
        Return the actual fully-extended state.

        This deliberately follows the original OMS behavior:
        True means the physical cylinder has reached progress == 1.0.
        """
        return self.progress >= 1.0

    def toggle_extended(self) -> None:
        self.set_extended(not self.extended)

    # ------------------------------------------------------------------
    # Dual-valve commands
    # ------------------------------------------------------------------

    def set_extend_command(self, value) -> None:
        self.extend_command = bool(int(value))

    def get_extend_command(self) -> bool:
        return self.extend_command

    def set_retract_command(self, value) -> None:
        self.retract_command = bool(int(value))

    def get_retract_command(self) -> bool:
        return self.retract_command

    # ------------------------------------------------------------------
    # Movement
    # ------------------------------------------------------------------

    def is_moving(self) -> bool:
        if self.valve_type == self.VALVE_DUAL:
            moving_toward_extend = (
                self.extend_command
                and not self.retract_command
                and self.progress < 1.0
            )

            moving_toward_retract = (
                self.retract_command
                and not self.extend_command
                and self.progress > 0.0
            )

            return moving_toward_extend or moving_toward_retract

        target = 1.0 if self.extended else 0.0
        return self.progress != target

    def advance_animation(self, dt_ms: float) -> None:
        """
        Advance the physical cylinder position.

        No Qt repaint/update is performed here.
        """

        dt_sec = float(dt_ms) / 1000.0

        step = (
            self.speed
            * self.ANIM_SPEED_SCALE
            * dt_sec
        )

        if self.valve_type == self.VALVE_DUAL:

            # Both commands active -> hold.
            # Both commands inactive -> hold.
            if self.extend_command and not self.retract_command:
                self.progress = min(
                    1.0,
                    self.progress + step,
                )

            elif self.retract_command and not self.extend_command:
                self.progress = max(
                    0.0,
                    self.progress - step,
                )

        else:
            target = 1.0 if self.extended else 0.0

            if self.progress < target:
                self.progress = min(
                    target,
                    self.progress + step,
                )

            elif self.progress > target:
                self.progress = max(
                    target,
                    self.progress - step,
                )

        # Generate a one-shot event when fully extended.
        now_extended = self.progress >= 1.0

        if now_extended and not self._was_fully_extended:
            self._extend_trigger_pending = True

        self._was_fully_extended = now_extended

    # ------------------------------------------------------------------
    # PLC I/O
    # ------------------------------------------------------------------

    def get_plc_io_points(self) -> dict:
        """
        Return the PLC-facing points.

        Single valve:
            extend

        Dual valve:
            extend_command
            retract_command
        """

        if self.valve_type == self.VALVE_DUAL:
            return {
                "extend_command": (
                    self.get_extend_command,
                    self.set_extend_command,
                ),
                "retract_command": (
                    self.get_retract_command,
                    self.set_retract_command,
                ),
            }

        return {
            "extend": (
                self.get_extended,
                self.set_extended,
            ),
        }

    # ------------------------------------------------------------------
    # One-shot extension event
    # ------------------------------------------------------------------

    def consume_extend_trigger(self) -> bool:
        """
        Return True exactly once when the cylinder reaches full extension.
        """

        if self._extend_trigger_pending:
            self._extend_trigger_pending = False
            return True

        return False

    # ------------------------------------------------------------------
    # Physical geometry
    # ------------------------------------------------------------------

    def _geometry(self) -> dict:
        """
        Calculate the cylinder's local geometry.

        Coordinates are local to the cylinder. The web renderer can use
        the same values to draw the cylinder, while the simulation uses
        them for physical interaction and sensor detection.
        """

        body_width = self.width * self.BODY_WIDTH_RATIO
        body_height = self.height * 0.62

        body_y = (
            self.height / 2.0
            - body_height / 2.0
        )

        body = {
            "x": 0.0,
            "y": body_y,
            "width": body_width,
            "height": body_height,
        }

        rear_cap_width = max(
            6.0,
            self.width * 0.055,
        )

        gland_width = max(
            7.0,
            self.width * 0.065,
        )

        fixed_front = (
            body["x"]
            + body["width"]
            - gland_width * 0.25
        )

        rod_min = fixed_front

        rod_max = (
            self.width
            - self.width * 0.025
        )

        return {
            "body": body,
            "rear_cap_width": rear_cap_width,
            "gland_width": gland_width,
            "rod_min": rod_min,
            "rod_max": rod_max,
        }

    def _piston_geometry(self) -> tuple[dict, float, float]:
        """
        Return the internal piston travel range.
        """

        geometry = self._geometry()

        body = geometry["body"]
        rear_cap_width = geometry["rear_cap_width"]
        gland_width = geometry["gland_width"]

        piston_min = (
            body["x"]
            + rear_cap_width * 2.2
        )

        piston_max = (body["x"] + body["width"] - gland_width * 0.5)

        if piston_max < piston_min:
            piston_max = piston_min

        return body, piston_min, piston_max

    def get_rod_tip_position(self) -> tuple[float, float]:
        """
        Return the current rod-tip position in scene/world coordinates.

        The cylinder's local axis points to the right before rotation.
        """

        geometry = self._geometry()

        rod_min = geometry["rod_min"]
        rod_max = geometry["rod_max"]

        local_x = (
            rod_min
            + (rod_max - rod_min) * self.progress
        )

        local_y = self.height / 2.0

        return self._local_to_scene(local_x, local_y)

    def get_detectable_zones(self) -> list[dict]:
        """
        Return the two physical zones that a sensor can detect.

        Each zone contains an axis-aligned local rectangle plus the
        cylinder's world position and rotation. The simulation layer can
        use these zones for collision/detection calculations.

        Zones:
            - rod_tip
            - piston
        """

        geometry = self._geometry()

        marker_width = min(
            self.DETECT_MARKER_WIDTH,
            max(3.0, self.width * 0.05),
        )

        rod_tip_x = (
            geometry["rod_min"]
            + (
                geometry["rod_max"]
                - geometry["rod_min"]
            ) * self.progress
        )

        rod_zone = {
            "type": "rod_tip",
            "x": rod_tip_x - marker_width / 2.0,
            "y": self.height / 2.0 - self.height * 0.24,
            "width": marker_width,
            "height": self.height * 0.48,
        }

        body, piston_min, piston_max = self._piston_geometry()

        piston_x = (
            piston_min
            + (piston_max - piston_min) * self.progress
        )

        piston_zone = {
            "type": "piston",
            "x": piston_x - marker_width / 2.0,
            "y": body["y"],
            "width": marker_width,
            "height": body["height"],
        }

        return [
            rod_zone,
            piston_zone,
        ]

    def get_detectable_zone_bounds(self) -> list[dict]:
        """
        Return axis-aligned world-space bounds for the cylinder's
        detectable zones.  Sensors can overlap these bounds even when
        the cylinder is rotated.

        The piston zone moves with `progress`, so a sensor mounted near
        the rear of the body can act as a retracted limit switch and a
        sensor mounted near the front can act as an extended limit switch.
        """
        bounds = []

        for zone in self.get_detectable_zones():
            x0 = zone["x"]
            y0 = zone["y"]
            x1 = x0 + zone["width"]
            y1 = y0 + zone["height"]

            corners = [
                self._local_to_scene(x0, y0),
                self._local_to_scene(x1, y0),
                self._local_to_scene(x1, y1),
                self._local_to_scene(x0, y1),
            ]

            xs = [p[0] for p in corners]
            ys = [p[1] for p in corners]

            bounds.append({
                "type": zone["type"],
                "x": min(xs),
                "y": min(ys),
                "width": max(xs) - min(xs),
                "height": max(ys) - min(ys),
            })

        return bounds

    def _local_to_scene(
        self,
        local_x: float,
        local_y: float,
    ) -> tuple[float, float]:
        """
        Convert a local cylinder coordinate to world/scene coordinates.

        The rotation pivot is the center of the cylinder, matching the
        original Qt implementation.
        """

        center_x = self.width / 2.0
        center_y = self.height / 2.0

        dx = local_x - center_x
        dy = local_y - center_y

        angle = math.radians(self.rotation)

        rotated_x = (
            dx * math.cos(angle)
            - dy * math.sin(angle)
        )

        rotated_y = (
            dx * math.sin(angle)
            + dy * math.cos(angle)
        )

        return (
            self.x + center_x + rotated_x,
            self.y + center_y + rotated_y,
        )

    # ------------------------------------------------------------------
    # Serialization
    # ------------------------------------------------------------------

    def to_dict(self) -> dict:
        """
        Serialize runtime state for the backend/web layer.
        """

        state = super().to_dict()

        state.update(
            {
                "type": "cylinder",
                "x": self.x,
                "y": self.y,
                "width": self.width,
                "height": self.height,
                "rotation": self.rotation,
                "speed": self.speed,
                "extended": self.get_extended(),
                "progress": self.progress,
                "valve_type": self.valve_type,
                "extend_command": self.extend_command,
                "retract_command": self.retract_command,
                "target_tag": self.target_tag,
                "moving": self.is_moving(),
                "rod_tip": {
                    "x": self.get_rod_tip_position()[0],
                    "y": self.get_rod_tip_position()[1],
                },
            }
        )

        return state