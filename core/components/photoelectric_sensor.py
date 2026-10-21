"""Behavior model for the directional photoelectric (photonic) sensor."""

from core.components.inductive_sensor import InductiveSensorBehavior


class PhotoelectricSensorBehavior(InductiveSensorBehavior):
    """Photoelectric sensor whose output is detected along a directional beam."""

    TYPE = "photoelectric_sensor"
    DETECTION_KIND = "photoelectric"
