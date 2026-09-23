# api/websocket.py
"""
WebSocket connection management + the background tick loop that
broadcasts Scene state to every connected browser.
"""

import asyncio
import base64
import json
import logging
import time

from project.model import ProjectSession

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

# How long to wait, after the last browser window disconnects, before
# actually shutting the process down. A simple page refresh also drops
# and re-opens the WebSocket -- this grace period lets that reconnect
# cancel the shutdown instead of killing the whole app on a refresh.
SHUTDOWN_GRACE_S = 5.0
# Browser refreshes no longer terminate the whole Python process.
# The development launcher owns server lifetime instead.


class ConnectionManager:
    """Owns one ProjectSession per WebSocket client."""

    def __init__(self):
        self.active: list[WebSocket] = []
        self.sessions: dict[WebSocket, ProjectSession] = {}
        self._tick_tasks: dict[WebSocket, asyncio.Task] = {}
        self._shutdown_task = None

    async def connect(self, ws: WebSocket) -> ProjectSession:
        await ws.accept()
        session = ProjectSession()
        self.active.append(ws)
        self.sessions[ws] = session
        self._tick_tasks[ws] = asyncio.create_task(_session_tick_loop(ws, session))
        if self._shutdown_task is not None:
            self._shutdown_task.cancel()
            self._shutdown_task = None
        logger.info("Client connected (%d total)", len(self.active))
        return session

    def disconnect(self, ws: WebSocket) -> None:
        session = self.sessions.pop(ws, None)
        tick_task = self._tick_tasks.pop(ws, None)
        if tick_task is not None:
            tick_task.cancel()
        if session is not None:
            session.close()
        if ws in self.active:
            self.active.remove(ws)
        logger.info("Client disconnected (%d total)", len(self.active))
        if not self.active and self._shutdown_task is None:
            self._shutdown_task = asyncio.get_event_loop().create_task(
                self._shutdown_after_grace()
            )

    async def _shutdown_after_grace(self) -> None:
        try:
            await asyncio.sleep(SHUTDOWN_GRACE_S)
        except asyncio.CancelledError:
            return
        if not self.active:
            logger.info("No browser windows connected -- server remains available for reconnect.")

    async def broadcast(self, ws: WebSocket, payload: dict) -> None:
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            self.disconnect(ws)


manager = ConnectionManager()


def _plc_status(session: ProjectSession) -> dict:
    """Everything the Mapping panel needs to render each tick: which
    backends are installed, the live connection (if any), its recent
    event log, and the current mapping list -- the web equivalent of
    what MappingPanel._scan_scene() + _refresh_live_values() pull from
    sim_view/plc_sync in the original desktop app."""
    sync = session.plc_sync
    raw_values = sync.get_read_values() if sync else {}

    # Attach the latest raw PLC value directly to each mapping row. This
    # avoids making the browser reconstruct the relationship between a
    # mapping row and the PLC read cache, and guarantees the monitor uses
    # exactly the same address string the mapping table uses.
    mapping = []
    for row in session.scene.plc_mapping:
        item = dict(row)
        node = item.get("plc_node", "")
        node_key = node.strip() if isinstance(node, str) else node
        if node in raw_values:
            item["live_value"] = raw_values[node]
            item["live_value_available"] = True
        elif node_key in raw_values:
            item["live_value"] = raw_values[node_key]
            item["live_value_available"] = True
        else:
            item["live_value"] = None
            item["live_value_available"] = False
        mapping.append(item)

    return {
        "available_backends": AVAILABLE_BACKENDS,
        "address_format_hints": ADDRESS_FORMAT_HINTS,
        "connected": bool(sync and sync.is_connected),
        "paused": bool(sync and sync.is_paused),
        "backend": session.selected_plc_backend,
        "comms_healthy": bool(sync and sync._comms_healthy) if sync else True,
        "last_error": (sync.last_error if sync else session.last_connect_error),
        "event_log": list(sync.event_log) if sync else [],
        "mapping": mapping,
        "signals": session.scene.signal_catalog(),
        # Keep the raw cache available for diagnostics and future monitor
        # features as well.
        "values": raw_values,
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
        {"action": "plc_import_db_tags", "target": "s7", "text": "<pasted TIA 'Generate source' .db text>", "db_number": 1}
        {"action": "plc_import_db_tags", "target": "opcua", "text": "<same pasted text>", "namespace": 3, "db_name": null}
        {"action": "plc_browse_opcua", "node_id": "ns=3;s=..." or omitted for the root}
    Outgoing messages (pushed by the tick loop, not sent from here):
        {"objects": {"Conveyor_1": {...}, ...}, "plc": {...}}
    """
    session = await manager.connect(ws)
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
                        session.plc_sync is not None and session.plc_sync.is_connected
                    ):
                        # RUNTIME means "connected to the actual PLC" --
                        # refuse to enter it without a live connection
                        # instead of silently showing frozen/fake values.
                        await ws.send_text(json.dumps({
                            "mode_error": "Connect to a PLC before switching to Runtime.",
                        }))
                        continue

                    if requested_mode == "design":
                        session.scene.stop_all_actuators()

                    session.mode = requested_mode
                    continue
                elif action == "set_point":
                    session.scene.apply_command(
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

                    if property_name in runtime_properties:
                        if session.mode == "design":
                            continue
                    elif session.mode != "design":
                        continue

                    session.scene.apply_property(
                        tag_name,
                        property_name,
                        command["value"],
                    )
                elif action == "add_component":
                    if session.mode != "design":
                        continue

                    obj = session.scene.create_component(
                        command["component_type"],
                        command["x"],
                        command["y"],
                    )
                    if obj is None:
                        logger.warning(
                            "Unknown component_type %r", command["component_type"]
                        )
                elif action == "delete_component":
                    if session.mode != "design":
                        continue
                    tag_name = command["tag_name"]

                    if not session.scene.remove(tag_name):
                        logger.warning("Component %r not found", tag_name)

                elif action == "plc_connect":
                    await _plc_connect(session, command["backend"], command.get("params", {}))
                elif action == "plc_disconnect":
                    _plc_disconnect(session)
                elif action == "plc_pause":
                    if session.plc_sync is not None:
                        session.plc_sync.pause()
                elif action == "plc_resume":
                    if session.plc_sync is not None:
                        session.plc_sync.resume()
                elif action == "plc_set_mapping":
                    # Replaces the whole list in one shot -- simpler
                    # than per-row add/remove actions, and matches how
                    # the frontend's mapping table submits its rows
                    # (see web/app.js's Apply Mappings button).
                    session.scene.plc_mapping = [
                        m for m in command.get("mappings", [])
                        if m.get("plc_node", "").strip()
                    ]
                elif action == "plc_force":
                    if session.mode == "design":
                        continue
                    session.scene.force_value(
                        command["tag_name"], command["io_point"], command["value"],
                    )
                elif action == "plc_import_db_tags":
                    from plc.s7_db_import import (
                        parse_db_source, generate_opcua_node_ids, S7ImportError,
                    )
                    from plc.tag_table_import import (
                        parse_tag_table_xlsx,
                        generate_opcua_node_ids_from_tag_table,
                        TagTableImportError,
                    )
                    target = command.get("target", "s7")
                    source = command.get("source", "text")
                    try:
                        if source == "xlsx":
                            try:
                                file_bytes = base64.b64decode(command.get("xlsx_base64", ""))
                            except Exception:
                                raise TagTableImportError("Couldn't decode the uploaded .xlsx file.")

                            if target == "opcua":
                                tags, warnings = generate_opcua_node_ids_from_tag_table(
                                    file_bytes,
                                    namespace=command.get("namespace") or 3,
                                    path_prefix=command.get("db_name") or None,
                                )
                            else:
                                tags, warnings = parse_tag_table_xlsx(file_bytes)
                        else:
                            text = command.get("text", "")
                            if target == "opcua":
                                tags, warnings = generate_opcua_node_ids(
                                    text,
                                    namespace=command.get("namespace") or 3,
                                    db_name=command.get("db_name") or None,
                                )
                            else:
                                tags, warnings = parse_db_source(
                                    text, command.get("db_number"),
                                )

                        await ws.send_text(json.dumps({
                            "db_import_result": {"target": target, "tags": tags, "warnings": warnings},
                        }))
                    except (S7ImportError, TagTableImportError) as exc:
                        await ws.send_text(json.dumps({
                            "db_import_result": {"target": target, "error": str(exc)},
                        }))
                elif action == "plc_browse_opcua":
                    await _plc_browse_opcua(session, ws, command.get("node_id"))
                elif action == "load_project":
                    if session.mode != "design":
                        continue
                    from project.serialization import load_project_dict
                    info = load_project_dict(session.scene, command.get("data", {}))
                    session.project.name = info["name"]
                    session.project.metadata = info["metadata"]
                    session.project.version = info["version"]
                elif action == "restore_objects":
                    # Undo/Redo: replaces component placement/state only --
                    # PLC mapping and connection settings are untouched.
                    if session.mode != "design":
                        continue
                    from project.serialization import load_objects_only
                    load_objects_only(session.scene, command.get("objects", []))
                elif action == "reset_view":
                    if session.mode != "design":
                        continue
                    session.scene.reset_simulation_state()
                elif action == "plc_validate":
                    await ws.send_text(json.dumps({
                        "plc_validation": _validate_mappings(session),
                    }))
                elif action == "save_project":
                    from project.serialization import scene_to_project_dict
                    await ws.send_text(json.dumps({
                        "project_data": scene_to_project_dict(
                            session.scene,
                            name=session.project.name,
                            metadata=session.project.metadata,
                        ),
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


async def _plc_connect(session: ProjectSession, backend: str, params: dict) -> None:
    """Opens a PLC connection, mirroring PlcConnectDialog's accept
    handler + main_window.py's start_plc_connection(). Any failure
    (bad params, library not installed, network error, timeout) is
    caught and surfaced via last_error/event_log instead of raising,
    since there's no modal dialog here to catch an exception."""
    if session.plc_sync is not None:
        _plc_disconnect(session)

    session.last_connect_error = None
    session.scene.plc_connection = {"backend": backend, "params": dict(params)}
    try:
        sync = create_plc_sync(backend, session.scene, **params)
        await asyncio.wait_for(
            asyncio.to_thread(sync.open_connection), timeout=CONNECT_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        session.plc_sync = None
        session.selected_plc_backend = backend
        session.last_connect_error = (
            f"Connection attempt timed out after {CONNECT_TIMEOUT_S:.0f}s."
        )
        logger.warning("PLC connect timed out: backend=%r", backend)
        return
    except Exception as exc:
        session.plc_sync = None
        session.selected_plc_backend = backend
        session.last_connect_error = str(exc)
        logger.warning("PLC connect failed: %s", exc)
        return

    session.plc_sync = sync
    session.selected_plc_backend = backend


BROWSE_TIMEOUT_S = 10.0


async def _plc_browse_opcua(session: ProjectSession, ws, node_id) -> None:
    """Browses one level of the connected OPC UA server's node tree
    for the Mapping panel's tag picker. Needs a live connection --
    unlike the S7 DB importer, there's no offline file to read here,
    the server itself is the address list."""
    sync = session.plc_sync
    if sync is None or not sync.is_connected or sync._client is None:
        await ws.send_text(json.dumps({
            "opcua_browse_result": {"error": "Connect to the PLC first."},
        }))
        return

    from plc.opcua_browse import browse_node
    try:
        children = await asyncio.wait_for(
            asyncio.to_thread(browse_node, sync._client, node_id),
            timeout=BROWSE_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        await ws.send_text(json.dumps({
            "opcua_browse_result": {"error": "Browse timed out."},
        }))
        return
    except Exception as exc:
        await ws.send_text(json.dumps({
            "opcua_browse_result": {"error": str(exc)},
        }))
        return

    await ws.send_text(json.dumps({
        "opcua_browse_result": {"node_id": node_id, "children": children},
    }))


def _plc_disconnect(session: ProjectSession) -> None:
    if session.plc_sync is not None:
        session.plc_sync.close_connection()
    session.plc_sync = None

    # RUNTIME requires a live PLC by definition -- losing the connection
    # drops back to DESIGN rather than leaving the UI stuck showing a
    # "live" screen that isn't live anymore.
    if session.mode == "runtime":
        session.mode = "design"


def _validate_mappings(session: ProjectSession) -> list:
    """Same check as the original's "Validate Mappings" button: every
    mapped PLC Node ID against the selected backend's address format,
    no live connection needed."""
    backend = session.selected_plc_backend
    if backend is None:
        return [{"error": "Choose a connection type first (Connect), then validate again."}]

    problems = []
    for entry in session.scene.plc_mapping:
        obj = session.scene.objects.get(entry.get("object_tag"))
        expected_type = None
        if obj is not None:
            signals = {signal.name: signal for signal in obj.get_io_signals()}
            signal = signals.get(entry.get("io_point"))
            if signal is not None:
                expected_type = signal.datatype
                if expected_type is None:
                    try:
                        expected_type = type(signal.read())
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


async def _session_tick_loop(ws: WebSocket, session: ProjectSession) -> None:
    """Run one deterministic simulation clock for one browser session."""
    last = time.monotonic()
    while True:
        now = time.monotonic()
        dt_seconds = now - last
        last = now
        try:
            session.scene.tick(dt_seconds, simulate=(session.mode != "design"))
            if session.plc_sync is not None and session.mode == "runtime":
                session.plc_sync.poll()
            await manager.broadcast(
                ws,
                {
                    "objects": session.scene.to_dict(),
                    "plc": _plc_status(session),
                    "mode": session.mode,
                    "project": {
                        "name": session.project.name,
                        "version": session.project.version,
                    },
                },
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Session tick failed")
        await asyncio.sleep(TICK_MS / 1000.0)


async def tick_loop() -> None:
    """Compatibility helper for embedding OMS in another ASGI host.
    Normal operation starts one clock per ProjectSession in connect()."""
    while True:
        await asyncio.sleep(3600)
