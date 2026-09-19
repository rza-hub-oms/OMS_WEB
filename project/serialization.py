# project/serialization.py
"""Save/Load project (.oms) support. An .oms file is JSON: every
component's full to_dict() state, the PLC tag mapping, and the
type-name counters (so components added after loading keep
auto-naming where the project left off)."""

from core.scene import COMPONENT_REGISTRY

PROJECT_VERSION = 1

# A few saved keys don't match their setter name 1:1.
_SETTER_OVERRIDES = {
    "rotation": "rotation_value",
    "color": "color_name",
    "watch_tag": "watch_target",
}


def scene_to_project_dict(scene) -> dict:
    return {
        "version": PROJECT_VERSION,
        "objects": [obj.to_dict() for obj in scene.objects.values()],
        "plc_mapping": list(scene.plc_mapping),
        "type_counters": dict(scene._type_counters),
    }


def load_project_dict(scene, data: dict) -> None:
    """Replaces the scene's contents in place. Unknown component types
    are skipped rather than raising."""
    scene.objects.clear()
    scene._cylinder_previously_extended.clear()
    scene.plc_mapping = list(data.get("plc_mapping", []))
    scene._type_counters = dict(data.get("type_counters", {}))

    for state in data.get("objects", []):
        behavior_cls = COMPONENT_REGISTRY.get(state.get("type"))
        if behavior_cls is None:
            continue

        obj = behavior_cls(
            state["tag_name"],
            x=state.get("x", 0.0),
            y=state.get("y", 0.0),
            width=state.get("width"),
            height=state.get("height"),
        )

        for key, value in state.items():
            setter_name = "set_" + _SETTER_OVERRIDES.get(key, key)
            setter = getattr(obj, setter_name, None)
            if setter is None:
                continue
            try:
                setter(value)
            except (TypeError, ValueError):
                pass

        scene.add(obj)