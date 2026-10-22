"""Backward-compatible sensor behavior imports.

New code should import InductiveSensorBehavior from
``core.components.inductive_sensor`` and PhotoelectricSensorBehavior from
``core.components.photoelectric_sensor``.
"""

from core.components.inductive_sensor import InductiveSensorBehavior, SensorBehavior
from core.components.photoelectric_sensor import PhotoelectricSensorBehavior

__all__ = ["InductiveSensorBehavior", "SensorBehavior", "PhotoelectricSensorBehavior"]
