"""Photoelectric (photonic) sensor behavior."""

from core.components.inductive_sensor import InductiveSensorBehavior


class PhotoelectricSensorBehavior(InductiveSensorBehavior):
    """Directional sensor with a red beam and segment-based detection."""

    TYPE = "photoelectric_sensor"
    DETECTION_KIND = "photoelectric"
