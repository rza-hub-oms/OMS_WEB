"""Versioned .oms project serialization and migration."""
from __future__ import annotations

from core.scene import COMPONENT_REGISTRY

PROJECT_VERSION = 12

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


def validate_project_dict(data: dict) -> list[dict]:
    """Return user-facing validation errors for an .oms project payload."""
    errors = []
    if not isinstance(data, dict):
        return [{"field": "root", "error": "Project must be a JSON object."}]
    version = data.get("version", 1)
    try:
        version_num = int(version)
    except (TypeError, ValueError):
        errors.append({"field": "version", "error": "Project version must be an integer."})
        version_num = PROJECT_VERSION
    if version_num > PROJECT_VERSION:
        errors.append({"field": "version", "error": f"Project version {version_num} is newer than this OMS version {PROJECT_VERSION}."})
    objects = data.get("objects", [])
    if not isinstance(objects, list):
        errors.append({"field": "objects", "error": "Objects must be a list."})
    else:
        for i, obj in enumerate(objects):
            if not isinstance(obj, dict):
                errors.append({"field": f"objects[{i}]", "error": "Object must be an object."})
                continue
            if not obj.get("type"):
                errors.append({"field": f"objects[{i}].type", "error": "Missing component type."})
            if not obj.get("tag_name"):
                errors.append({"field": f"objects[{i}].tag_name", "error": "Missing tag name."})
    for field in ("plc_mapping", "logic_rules", "sequences", "alarms", "connections"):
        if field in data and not isinstance(data[field], list):
            errors.append({"field": field, "error": f"{field} must be a list."})
    if "tags" in data and not isinstance(data["tags"], list):
        errors.append({"field": "tags", "error": "tags must be a list."})
    if "plc_connection" in data and not isinstance(data["plc_connection"], dict):
        errors.append({"field": "plc_connection", "error": "PLC connection settings must be an object."})
    if "production" in data and not isinstance(data["production"], dict):
        errors.append({"field": "production", "error": "Production settings must be an object."})
    return errors


def migrate_project_dict(data: dict) -> dict:
    """Upgrade older project dictionaries in memory without mutating input."""
    payload = dict(data or {})
    version = int(payload.get("version", 1) or 1)
    if version < PROJECT_VERSION:
        payload.setdefault("metadata", {})
        payload["metadata"].setdefault("migrated_from", version)
        payload["version"] = PROJECT_VERSION
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
        obj.set_parent_tag(state.get("parent_tag"))
        built[obj.tag_name] = obj
    return built


def scene_to_project_dict(scene, *, name="Untitled", metadata=None, production=None) -> dict:
    return {
        "version": PROJECT_VERSION,
        "name": name,
        "metadata": dict(metadata or {}),
        "objects": [{**obj.to_dict(), "parent_tag": getattr(obj, "parent_tag", None)} for obj in scene.objects.values()],
        "plc_mapping": list(scene.plc_mapping),
        "plc_connection": dict(scene.plc_connection),
        "type_counters": dict(scene._type_counters),
        "logic_rules": list(scene.logic_rules),
        "sequences": list(scene.sequences),
        "tags": scene.tags.to_dict(),
        "alarms": list(scene.alarm_engine.definitions),
        "connections": list(scene.connections),
        "production": dict(production or {}),
    }


def load_project_dict(scene, data: dict) -> dict:
    """Replace scene contents and return normalized project metadata."""
    errors = validate_project_dict(data)
    if errors:
        raise ValueError("Invalid OMS project: " + "; ".join(e["error"] for e in errors))
    payload = migrate_project_dict(data)
    scene.objects.clear()
    scene._cylinder_previously_extended.clear()
    scene.plc_mapping = list(payload.get("plc_mapping", []))
    scene.plc_connection = dict(payload.get("plc_connection", {}))
    scene.connections = list(payload.get("connections", []))
    scene._type_counters = dict(payload.get("type_counters", {}))
    scene.logic_rules = list(payload.get("logic_rules", []))
    scene.sequences = list(payload.get("sequences", []))
    scene.sequence_engine.reset()
    scene.objects.update(_build_objects(payload.get("objects", [])))
    scene.connections = [c for c in scene.connections if isinstance(c, dict) and c.get("source") in scene.objects and c.get("target") in scene.objects and c.get("source") != c.get("target")]
    scene.tags.load_custom(payload.get("tags", []))
    scene.tags.sync()
    scene.alarm_engine.set_definitions(payload.get("alarms", []))
    scene.alarm_engine.reset(clear_history=True)
    return {
        "name": payload.get("name", "Untitled"),
        "metadata": dict(payload.get("metadata", {})),
        "version": PROJECT_VERSION,
    }


def load_objects_only(scene, objects_data) -> None:
    scene.objects.clear()
    scene._cylinder_previously_extended.clear()
    scene.objects.update(_build_objects(objects_data))
