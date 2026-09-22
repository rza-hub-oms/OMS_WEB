"""Versioned .oms project serialization and migration."""
from __future__ import annotations

from core.scene import COMPONENT_REGISTRY

PROJECT_VERSION = 2

_SETTER_OVERRIDES = {
    "rotation": "rotation_value",
    "color": "color_name",
    "watch_tag": "watch_target",
    # Cylinder's "which component do I interact with" field was renamed
    # from target_conveyor to target_tag when the push-off-conveyor
    # behavior was generalized to other relation types. Old saved
    # projects still have the old key; route it to the new setter.
    "target_conveyor": "target_tag",
}


def migrate_project_dict(data: dict) -> dict:
    """Upgrade older project dictionaries in memory without mutating input."""
    payload = dict(data or {})
    version = int(payload.get("version", 1) or 1)
    if version < 2:
        payload.setdefault("metadata", {})
        payload["metadata"].setdefault("migrated_from", version)
        payload["version"] = 2
    return payload


def _build_objects(objects_data) -> dict:
    built = {}
    for state in objects_data or []:
        behavior_cls = COMPONENT_REGISTRY.get(state.get("type"))
        if behavior_cls is None or not state.get("tag_name"):
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
                continue
        built[obj.tag_name] = obj
    return built


def scene_to_project_dict(scene, *, name="Untitled", metadata=None) -> dict:
    return {
        "version": PROJECT_VERSION,
        "name": name,
        "metadata": dict(metadata or {}),
        "objects": [obj.to_dict() for obj in scene.objects.values()],
        "plc_mapping": list(scene.plc_mapping),
        "plc_connection": dict(scene.plc_connection),
        "type_counters": dict(scene._type_counters),
    }


def load_project_dict(scene, data: dict) -> dict:
    """Replace scene contents and return normalized project metadata."""
    payload = migrate_project_dict(data)
    scene.objects.clear()
    scene._cylinder_previously_extended.clear()
    scene.plc_mapping = list(payload.get("plc_mapping", []))
    scene.plc_connection = dict(payload.get("plc_connection", {}))
    scene._type_counters = dict(payload.get("type_counters", {}))
    scene.objects.update(_build_objects(payload.get("objects", [])))
    return {
        "name": payload.get("name", "Untitled"),
        "metadata": dict(payload.get("metadata", {})),
        "version": PROJECT_VERSION,
    }


def load_objects_only(scene, objects_data) -> None:
    scene.objects.clear()
    scene._cylinder_previously_extended.clear()
    scene.objects.update(_build_objects(objects_data))
