# api/websocket.py
"""
WebSocket connection management + the background tick loop that
broadcasts Scene state to every connected browser.
"""

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from core.scene import TICK_MS
from plc.plc_sync import (
    AVAILABLE_BACKENDS,
    ADDRESS_FORMAT_HINTS,
    create_plc_sync,
    validate_address_for_backend,
)

logger = logging.getLogger("oms_web")

router = APIRouter()

# The three OMS modes, in the order they appear in the mode bar.
VALID_MODES = ("design", "simulation", "runtime")


class ConnectionManager:
    """Tracks connected browser clients and broadcasts JSON state to all
    of them. Kept separate from the Scene itself, since the Scene knows
    nothing about WebSockets."""

    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.append(ws)
        logger.info("Client connected (%d total)", len(self.active))

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self.active:
            self.active.remove(ws)
        logger.info("Client disconnected (%d total)", len(self.active))

    async def broadcast(self, payload: dict) -> None:
        message = json.dumps(payload)
        stale = []
        for ws in self.active:
            try:
                await ws.send_text(message)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self.disconnect(ws)


manager = ConnectionManager()


def _plc_status() -> dict:
    """Everything the Mapping panel needs to render each tick: which
    backends are installed, the live connection (if any), its recent
    event log, and the current mapping list -- the web equivalent of
    what MappingPanel._scan_scene() + _refresh_live_values() pull from
    sim_view/plc_sync in the original desktop app."""
    import api.server as server

    sync = server.plc_sync
    return {
        "available_backends": AVAILABLE_BACKENDS,
        "address_format_hints": ADDRESS_FORMAT_HINTS,
        "connected": bool(sync and sync.is_connected),
        "paused": bool(sync and sync.is_paused),
        "backend": server.selected_plc_backend,
        "comms_healthy": bool(sync and sync._comms_healthy) if sync else True,
        "last_error": (sync.last_error if sync else getattr(server, "_last_connect_error", None)),
        "event_log": list(sync.event_log) if sync else [],
        "mapping": server.scene.plc_mapping,
    }


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """Browsers connect here. Incoming messages are commands, one of:
        {"action": "set_point", "tag_name": "Conveyor_1", "point": "running", "value": 1}
        {"action": "set_property", "tag_name": "Conveyor_1", "property": "width", "value": 400}
        {"action": "add_component", "component_type": "conveyor", "x": 120, "y": 80}
        {"action": "plc_connect", "backend": "asyncua", "params": {"url": "..."}}
        {"action": "plc_disconnect"}
        {"action": "plc_pause"}
        {"action": "plc_resume"}
        {"action": "plc_set_mapping", "mappings": [{"object_tag", "io_point", "plc_node"}, ...]}
        {"action": "plc_force", "tag_name": "...", "io_point": "...", "value": "..."}
        {"action": "plc_validate"}
    Outgoing messages (pushed by the tick loop, not sent from here):
        {"objects": {"Conveyor_1": {...}, ...}, "plc": {...}}
    """
    import api.server as server  # local import avoids a circular import

    await manager.connect(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                command = json.loads(raw)
                action = command.get("action", "set_point")  # default keeps old messages working

                if action == "set_mode":
                    requested_mode = command.get("mode")

                    if requested_mode not in VALID_MODES:
                        continue

                    if requested_mode == "runtime" and not (
                        server.plc_sync is not None and server.plc_sync.is_connected
                    ):
                        # RUNTIME means "connected to the actual PLC" --
                        # refuse to enter it without a live connection
                        # instead of silently showing frozen/fake values.
                        await ws.send_text(json.dumps({
                            "mode_error": "Connect to a PLC before switching to Runtime.",
                        }))
                        continue

                    server.mode = requested_mode
                    continue
                elif action == "set_point":
                    server.scene.apply_command(
                        command["tag_name"],
                        command["point"],
                        command["value"],
                    )
                elif action == "set_property":
                    tag_name = command["tag_name"]
                    property_name = command["property"]

                    runtime_properties = {
                        "pressed",
                        "on",
                    }

                    if (
                        server.mode != "design"
                        and property_name not in runtime_properties
                    ):
                        continue

                    server.scene.apply_property(
                        tag_name,
                        property_name,
                        command["value"],
                    )
                elif action == "add_component":
                    if server.mode != "design":
                        continue

                    obj = server.scene.create_component(
                        command["component_type"],
                        command["x"],
                        command["y"],
                    )
                    if obj is None:
                        logger.warning(
                            "Unknown component_type %r", command["component_type"]
                        )
                elif action == "delete_component":
                    if server.mode != "design":
                        continue
                    tag_name = command["tag_name"]

                    if not server.scene.remove(tag_name):
                        logger.warning("Component %r not found", tag_name)

                elif action == "plc_connect":
                    await _plc_connect(server, command["backend"], command.get("params", {}))
                elif action == "plc_disconnect":
                    _plc_disconnect(server)
                elif action == "plc_pause":
                    if server.plc_sync is not None:
                        server.plc_sync.pause()
                elif action == "plc_resume":
                    if server.plc_sync is not None:
                        server.plc_sync.resume()
                elif action == "plc_set_mapping":
                    # Replaces the whole list in one shot -- simpler
                    # than per-row add/remove actions, and matches how
                    # the frontend's mapping table submits its rows
                    # (see web/app.js's Apply Mappings button).
                    server.scene.plc_mapping = [
                        m for m in command.get("mappings", [])
                        if m.get("plc_node", "").strip()
                    ]
                elif action == "plc_force":
                    server.scene.force_value(
                        command["tag_name"], command["io_point"], command["value"],
                    )
                elif action == "plc_validate":
                    await ws.send_text(json.dumps({
                        "plc_validation": _validate_mappings(server),
                    }))
                else:
                    logger.warning("Unknown action %r", action)
            except (KeyError, json.JSONDecodeError) as exc:
                logger.warning("Ignoring malformed command %r: %s", raw, exc)
    except WebSocketDisconnect:
        manager.disconnect(ws)


# The original PlcConnectDialog connects synchronously on the GUI
# thread and just accepts that a bad address blocks briefly. That's
# not acceptable here -- blocking the asyncio event loop would freeze
# every connected browser's tick broadcast, not just the one dialog --
# so open_connection() runs in a worker thread with a hard timeout;
# a PLC that never responds surfaces as a timeout error instead of
# hanging the whole server.
CONNECT_TIMEOUT_S = 10.0


async def _plc_connect(server, backend: str, params: dict) -> None:
    """Opens a PLC connection, mirroring PlcConnectDialog's accept
    handler + main_window.py's start_plc_connection(). Any failure
    (bad params, library not installed, network error, timeout) is
    caught and surfaced via last_error/event_log instead of raising,
    since there's no modal dialog here to catch an exception."""
    if server.plc_sync is not None:
        _plc_disconnect(server)

    server._last_connect_error = None
    try:
        sync = create_plc_sync(backend, server.scene, **params)
        await asyncio.wait_for(
            asyncio.to_thread(sync.open_connection), timeout=CONNECT_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        server.plc_sync = None
        server.selected_plc_backend = backend
        server._last_connect_error = (
            f"Connection attempt timed out after {CONNECT_TIMEOUT_S:.0f}s."
        )
        logger.warning("PLC connect timed out: backend=%r", backend)
        return
    except Exception as exc:
        server.plc_sync = None
        server.selected_plc_backend = backend
        server._last_connect_error = str(exc)
        logger.warning("PLC connect failed: %s", exc)
        return

    server.plc_sync = sync
    server.selected_plc_backend = backend


def _plc_disconnect(server) -> None:
    if server.plc_sync is not None:
        server.plc_sync.close_connection()
    server.plc_sync = None

    # RUNTIME requires a live PLC by definition -- losing the connection
    # drops back to DESIGN rather than leaving the UI stuck showing a
    # "live" screen that isn't live anymore.
    if server.mode == "runtime":
        server.mode = "design"


def _validate_mappings(server) -> list:
    """Same check as the original's "Validate Mappings" button: every
    mapped PLC Node ID against the selected backend's address format,
    no live connection needed."""
    backend = server.selected_plc_backend
    if backend is None:
        return [{"error": "Choose a connection type first (Connect), then validate again."}]

    problems = []
    for entry in server.scene.plc_mapping:
        obj = server.scene.objects.get(entry.get("object_tag"))
        expected_type = None
        if obj is not None:
            point = obj.get_plc_io_points().get(entry.get("io_point"))
            if point is not None and point[0] is not None:
                try:
                    expected_type = type(point[0]())
                except Exception:
                    expected_type = None

        error = validate_address_for_backend(
            backend, entry.get("plc_node", ""), expected_type=expected_type,
        )
        if error is not None:
            problems.append({
                "object_tag": entry.get("object_tag"),
                "io_point": entry.get("io_point"),
                "plc_node": entry.get("plc_node"),
                "error": error,
            })
    return problems


async def tick_loop(scene) -> None:
    """Runs forever: advances the scene, polls the live PLC connection
    (if any), and broadcasts state every TICK_MS milliseconds. Started
    as a background task in server.py's lifespan handler."""
    import api.server as server

    interval_sec = TICK_MS / 1000.0
    while True:
        # DESIGN is frozen (editing only); SIMULATION and RUNTIME both
        # animate -- they differ in where commands come from, not
        # whether the scene moves.
        scene.tick(TICK_MS, simulate=(server.mode != "design"))
        if server.plc_sync is not None:
            server.plc_sync.poll()
        await manager.broadcast({"objects": scene.to_dict(), "plc": _plc_status(), "mode": server.mode,})
        await asyncio.sleep(interval_sec)
