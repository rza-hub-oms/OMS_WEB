import sys
#sys.stdout = open("oms_debug.log", "a", buffering=1)
#sys.stderr = sys.stdout

"""
plc_sync.py
-----------
Live connectivity for OMS, bridging the simulation's PLC I/O points
(see get_plc_io_points() on scene items) to real PLC/server addresses,
using the mappings entered in the PLC Mapping panel
(SimulationView.plc_mapping).

Three interchangeable backends are supported, selectable at connect
time via the Connect dialog:

    - "asyncua"  the asyncua library, via its built-in synchronous
                 wrapper (asyncua.sync.Client).
    - "opcua"    the classic python-opcua library (opcua.Client).
    - "s7"       Siemens S7comm, via python-snap7. Addresses are DB
                 memory locations (e.g. "DB1.DBX0.0"), not OPC UA node
                 IDs -- see S7Address below.

None of these libraries are hard dependencies of this file: importing
plc_sync never fails even if none are installed. Trying to actually
connect with a backend that isn't installed raises a clear
PlcConnectionError instead, which the Connect dialog surfaces to the
user.

Direction convention (matches ui/mapping_dialog.py's Direction column):
    - "PLC -> OMS": the io point HAS a setter (setter is not None).
      The real PLC drives this value; we read the remote address and
      push it into the simulation via the setter.
    - "OMS -> PLC": the io point has NO setter (read-only, getter
      only). The simulation drives this value (e.g. a sensor's
      detected state); we read it via the getter and write it out to
      the remote address.

Type safety (OMS type vs. PLC address type):
    Every OMS I/O point's getter already returns a properly-typed
    Python value (bool/int/float) -- that's the "OMS type" for that
    point, discovered live rather than declared anywhere. For the S7
    backend, a mapped address's type is ALSO statically knowable, just
    from parsing the address string (X -> bool, B/W/INT/DINT/DWORD ->
    int, REAL -> float) -- see S7Address.python_type. Whenever both are
    known, they're compared -- in Validate Mappings (mapping_dialog.py)
    and automatically during live polling (see poll()'s type-check
    below) -- and a mismatch (e.g. mapping an int-valued OMS point to a
    bit address) is rejected rather than silently written/applied. OPC
    UA addresses can't be checked this way without an active connection
    to ask the server for the node's real type, so this check is
    currently S7-only; see PlcSyncBase.expected_python_type.

Threading:
    All actual network I/O happens on a dedicated background thread
    (every supported client library's I/O is blocking), so the 100ms
    Qt timer in SimulationView (main_window.py) never blocks the UI
    waiting on the network. The GUI thread only ever touches Qt scene
    items (via item getter/setter, in poll()) and a pair of
    thread-safe caches -- it never touches the client object itself,
    which belongs entirely to the background thread.

    _last_written (the "have we already sent this value?" cache for
    OMS -> PLC points) is touched from BOTH threads: poll() reads/sets
    it on the GUI thread to decide whether a value changed, and
    _background_loop() clears an entry on the background thread when a
    write for it fails, so poll() will retry it on the next tick
    rather than assuming a failed write was delivered. All access to
    it goes through self._lock.

Adding a new backend:
    Subclass PlcSyncBase and override:
      - __init__(scene, ...backend-specific connection params...)
      - _make_client()      -> an unconnected, configured client object
      - _connect_client(client)   [only if connect() takes args, e.g.
                                    S7's connect(ip, rack, slot)]
      - _read_node(node_id) / _write_node(node_id, value)
                             [only if the client isn't OPC UA-shaped,
                              i.e. doesn't offer
                              get_node(id).get_value()/.set_value()]
      - expected_python_type(node_id)  [optional; only if this
                                         backend's addresses statically
                                         imply a type -- see S7PlcSync]
    then add it to create_plc_sync() and to the Connect dialog.
"""

import re
import struct
import threading

try:
    from asyncua.sync import Client as AsyncuaSyncClient
    _ASYNCUA_AVAILABLE = True
except ImportError:
    _ASYNCUA_AVAILABLE = False

try:
    from opcua import Client as OpcuaClient
    _OPCUA_AVAILABLE = True
except ImportError:
    _OPCUA_AVAILABLE = False

try:
    from snap7.client import Client as S7Client
    from snap7.type import Areas
    _S7_AVAILABLE = True
except ImportError:
    _S7_AVAILABLE = False

    class Areas:
        """Stand-in for snap7.type.Areas when python-snap7 isn't
        installed. S7Address.parse()/validate_address_for_backend()
        are meant to work without a live connection (matching the
        original app's "Validate Mappings" button, which checks
        address syntax offline) -- but they were unconditionally
        referencing Areas.DB/PE/PA/MK, which only existed inside this
        try block. Without this fallback, validating (or even just
        parsing) any S7 address on a machine without snap7 installed
        raised NameError instead of a normal validation result. Only
        actually opening a connection (S7Client) needs the real enum
        values from the library."""
        DB = "DB"
        PE = "PE"
        PA = "PA"
        MK = "MK"

_OPCUA_NODE_ID_RE = re.compile(
    r'^(ns=\d+;)?(i=\d+|s=.+|g=[0-9a-fA-F-]+|b=.+)$'
)

def _validate_opcua_node_id(node_id):
    text = (node_id or "").strip()
    if not text:
        return "Address is empty."
    if not _OPCUA_NODE_ID_RE.match(text):
        return (
            'Doesn\'t look like an OPC UA Node ID. Expected a form like '
            '"ns=3;s=Line1.Cylinder1.Extend" or "ns=3;i=1001" '
            '(ns=<namespace>; then i=, s=, g=, or b= followed by the identifier).'
        )
    return None

_OPCUA_UNQUOTED_S_RE = re.compile(r'^(?P<prefix>(ns=\d+;)?s=)(?P<ident>[^"].*)$')

def _normalize_opcua_node_id(node_id):
    """Expands 'ns=3;s=DB_OPC_2.iEPB' into 'ns=3;s="DB_OPC_2"."iEPB"'.
    Passes through unchanged if already quoted or not an s= node id."""
    if not node_id:
        return node_id
    match = _OPCUA_UNQUOTED_S_RE.match(node_id.strip())
    if not match:
        return node_id
    prefix, ident = match.group("prefix"), match.group("ident")
    quoted = ".".join(f'"{p}"' for p in ident.split(".") if p)
    return prefix + quoted

class PlcConnectionError(Exception):
    """Raised when a connection attempt fails, when the requested
    backend library isn't installed, or when a mapped address string
    can't be parsed for the selected backend."""
    pass


def _describe_connect_error(exc):
    """Builds a non-empty, actionable error message from a connection
    failure. Some built-in exceptions -- notably TimeoutError -- have
    an EMPTY str() by default unless a message was explicitly set,
    which would otherwise surface as a blank QMessageBox with no way
    to tell what went wrong. This guarantees there's always something
    useful to show, and adds a plain-language hint for a few common
    causes."""
    detail = str(exc).strip()

    if isinstance(exc, TimeoutError):
        hint = ("Connection timed out. Check the address/port, that the "
                "server or PLC is powered on and reachable, and that "
                "nothing (e.g. a firewall) is blocking the connection.")
    elif isinstance(exc, ConnectionRefusedError):
        hint = ("Connection refused. Check the address/port -- the "
                "target reachable, but nothing is listening on that "
                "port/service.")
    elif isinstance(exc, OSError):
        hint = "A network error occurred. Check the address and your network connection."
    else:
        hint = None

    if detail and hint:
        return f"{detail}\n\n{hint}"
    if detail:
        return detail
    if hint:
        return hint
    return f"{type(exc).__name__}: no further details were provided by the connection library."


BACKEND_ASYNCUA = "asyncua"
BACKEND_OPCUA = "opcua"
BACKEND_S7 = "s7"

# Used by the Connect dialog to show which backends are actually usable
# in this Python environment right now.
AVAILABLE_BACKENDS = {
    BACKEND_ASYNCUA: _ASYNCUA_AVAILABLE,
    BACKEND_OPCUA: _OPCUA_AVAILABLE,
    BACKEND_S7: _S7_AVAILABLE,
}

# ---------- OPC UA security policies ----------
#
# Both asyncua and opcua (the latter is where asyncua originally forked
# from) support the same set_security_string(policy,mode,cert,key)
# call, so one implementation in _apply_opcua_security() below covers
# both backends. Only Basic256Sha256 is offered here -- the most
# widely supported modern policy -- rather than exposing every policy
# OPC UA defines; ask if you need an older one (e.g. Basic128Rsa15)
# for a specific server.
SECURITY_NONE = "None"
SECURITY_SIGN = "Basic256Sha256,Sign"
SECURITY_SIGN_ENCRYPT = "Basic256Sha256,SignAndEncrypt"

SECURITY_POLICIES = {
    SECURITY_NONE: "No security (unencrypted, unsigned) — only use on trusted networks.",
    SECURITY_SIGN: "Basic256Sha256, Sign only — messages are signed but not encrypted.",
    SECURITY_SIGN_ENCRYPT: "Basic256Sha256, Sign & Encrypt — full message security.",
}


def _apply_opcua_security(client, security_policy, certificate_path, private_key_path):
    """Shared by AsyncuaPlcSync and OpcuaPlcSync. Raises
    PlcConnectionError up front (before ever touching the network) if
    a secured policy is selected but the cert/key files are missing,
    rather than letting the client library fail with a less clear
    error later during connect()."""
    if not security_policy or security_policy == SECURITY_NONE:
        return

    if not certificate_path or not private_key_path:
        raise PlcConnectionError(
            "The selected security policy requires both a client "
            "certificate and a private key file."
        )

    security_string = f"{security_policy},{certificate_path},{private_key_path}"
    try:
        client.set_security_string(security_string)
    except Exception as exc:
        raise PlcConnectionError(
            f"Could not apply security settings: {exc}"
        ) from exc


class PlcSyncBase:
    """Qt-free port of the original PlcSyncBase: the desktop app used Qt
    Signals (error_occurred, comms_lost, etc.) to notify the GUI thread;
    the web app instead just exposes plain state (self.last_error,
    self.comms_healthy, self.event_log) that api/websocket.py reads
    each tick and broadcasts to the browser -- polling instead of
    push, since the browser already gets a state broadcast every
    TICK_MS anyway."""

    ADDRESS_FORMAT_HINT = "Address format depends on the connected backend."

    @classmethod
    def validate_address(cls, node_id, expected_type=None):
        """Checks a PLC Node ID string against this backend's expected
        address format, WITHOUT needing a live connection or even the
        backend's client library installed -- pure string validation.

        expected_type, if given, is the OMS I/O point's own Python
        type (bool/int/float, discovered by calling its getter -- see
        mapping_dialog.py's _validate_mappings and
        PlcSyncBase.expected_python_type). Subclasses whose address
        format statically implies a type (currently only S7 -- see
        S7PlcSync.validate_address) additionally reject a mismatch
        between that and expected_type. Backends that can't know the
        real type without a live connection (OPC UA) simply ignore
        expected_type.

        Returns None if valid (or at least not obviously wrong), or a
        short human-readable reason if not. Subclasses override this;
        the default here only checks for a non-empty string, so any
        future backend that doesn't override it still gets a minimal
        sanity check for free."""
        if not node_id or not node_id.strip():
            return "Address is empty."
        return None

    @classmethod
    def expected_python_type(cls, node_id):
        """Returns the Python type (bool/int/float) that `node_id`
        statically implies, if this backend's address format encodes
        that -- or None if it can't be known without a live connection
        (the default, e.g. for OPC UA node IDs, which carry no type
        information in the string itself). Used by poll() to catch a
        mapping whose PLC address type doesn't match the OMS I/O
        point's own type (discovered from its getter) BEFORE ever
        reading/writing that mismatched value, not just when the user
        remembers to click Validate Mappings."""
        return None

    # How often the background thread performs a full read/write sweep
    # of every mapped address. Deliberately decoupled from the GUI's
    # 100ms timer/poll() call -- poll() just reads whatever the
    # background thread most recently cached, instantly, every tick.
    BACKGROUND_INTERVAL_S = 0.2

    # Recent (message, is_mapping_error) entries, newest last -- polled
    # by api/websocket.py instead of connecting to a Qt signal.
    EVENT_LOG_MAX = 20

    def __init__(self, scene):
        self.scene = scene

        self.is_connected = False
        self.is_paused = False
        self.last_error = None
        self._had_error = False
        self._reported_mapping_errors = set()
        self._last_shown_error_msg = {}
        self.event_log = []

        self._consecutive_dead_sweeps = 0   # add
        self._comms_healthy = True          # add

        self._client = None
        self._lock = threading.Lock()
        self._read_cache = {}       # node_id -> last value read from server
        self._pending_writes = {}   # node_id -> value waiting to be written
        self._known_node_ids = set()

        self._stop_event = threading.Event()
        self._thread = None

        # "Last value successfully pushed to the server" cache, so a
        # write is only queued when the simulation's value actually
        # changed -- avoids hammering the server every 100ms with
        # identical writes. Touched from BOTH threads (poll() on the
        # GUI thread, _background_loop() on the background thread when
        # a write fails), so every access goes through self._lock.
        self._last_written = {}

    # ---------- Backend hooks (subclasses implement/override) ----------

    def _make_client(self):
        """Returns a new, not-yet-connected client instance. Subclasses
        override this to instantiate the right backend's Client class,
        already configured with connection details (but not yet
        connected)."""
        raise NotImplementedError

    def _connect_client(self, client):
        """Actually opens the connection on `client`. Default assumes
        an OPC UA-style client whose connect() takes no arguments
        (URL/credentials were already set on it in _make_client()).
        Backends with a different connect signature -- e.g. S7's
        connect(ip, rack, slot) -- override this."""
        client.connect()

    def _read_node(self, node_id):
        return self._client.get_node(_normalize_opcua_node_id(node_id)).get_value()

    def _write_node(self, node_id, value):
        self._client.get_node(_normalize_opcua_node_id(node_id)).set_value(value)

    # ---------- Connection lifecycle ----------

    def open_connection(self):
        """Synchronous connect, called once from the GUI thread (the
        Connect dialog's OK handler). Raises PlcConnectionError on any
        failure, so the caller can show it to the user without leaving
        a half-connected state behind."""
        try:
            client = self._make_client()
            self._connect_client(client)
        except PlcConnectionError:
            raise
        except Exception as exc:
            raise PlcConnectionError(_describe_connect_error(exc)) from exc

        self._client = client
        self.is_connected = True
        self.is_paused = False
        self.last_error = None

        # Always start a fresh communication state for a new connection.
        self._consecutive_dead_sweeps = 0
        self._comms_healthy = True

        with self._lock:
            self._read_cache.clear()
            self._pending_writes.clear()
            self._known_node_ids.clear()
            self._last_written.clear()

        self._stop_event = threading.Event()

        self._thread = threading.Thread(
            target=self._background_loop,
            name="PlcSyncBackground",
            daemon=True,
        )
        self._thread.start()

    def close_connection(self):
        """Stops the background thread and closes the session. Safe to
        call even if already disconnected."""
        self._stop_event.set()

        if self._thread is not None:
            self._thread.join(timeout=2.0)
            if self._thread.is_alive():
                self._report_error("PLC background thread did not stop cleanly (still running).")
            self._thread = None

        if self._client is not None:
            try:
                self._client.disconnect()
            except Exception:
                pass
            try:
                self._client.destroy()
            except Exception:
                pass
            self._client = None

        self.is_connected = False
        self.is_paused = False

    def pause(self):
        """Pause PLC <-> OMS I/O exchange without disconnecting the PLC."""
        if not self.is_connected:
            return

        self.is_paused = True

        with self._lock:
            self._pending_writes.clear()
            self._read_cache.clear()
            self._last_written.clear()

    def resume(self):
        """Resume PLC <-> OMS I/O exchange."""
        if not self.is_connected:
            return

        self.is_paused = False

    # ---------- Background thread: all actual network I/O lives here ----------

    def _background_loop(self):
        while not self._stop_event.is_set():
            if self.is_paused:
                self._stop_event.wait(self.BACKGROUND_INTERVAL_S)
                continue
            with self._lock:
                node_ids = set(self._known_node_ids)
                writes = dict(self._pending_writes)
                self._pending_writes.clear()
            print("[PLC BG SWEEP] node_ids =", node_ids)

            sweep_ok = True

            # Writes first, so a value the simulation just produced
            # reaches the server promptly rather than waiting behind
            # every read in this sweep.
            for node_id, value in writes.items():
                try:
                    print(
                        "[PLC ACTUAL WRITE]",
                        "node=", node_id,
                        "value=", value,
                        "type=", type(value).__name__,
                    )
                    self._write_node(node_id, value)
                    print(
                        "[PLC WRITE OK]",
                        "node=", node_id,
                        "value=", value,
                    )
                except Exception as exc:
                    sweep_ok = False
                    self._report_error(str(exc) or type(exc).__name__)

                    with self._lock:
                        self._last_written.pop(node_id, None)

            new_cache = {}
            for node_id in node_ids:
                try:
                    value = self._read_node(node_id)
                    new_cache[node_id] = value
                    print("[PLC READ VALUE]", node_id, "=", value)
                except Exception as exc:
                    sweep_ok = False
                    print("[PLC READ FAIL]", node_id, repr(exc))
                    self._report_error(str(exc) or type(exc).__name__)

            if new_cache:
                with self._lock:
                    self._read_cache.update(new_cache)

            # Whole-connection health tracking, separate from
            # _report_error()'s per-tag error messages above. A single
            # misconfigured tag failing every sweep looks identical,
            # tag-by-tag, to the whole PLC being gone -- so instead
            # this specifically watches for a sweep where NOTHING
            # succeeded despite there being tags to read/write, and
            # only treats that as "comms lost" after it happens
            # several sweeps in a row (~0.6s), to ride out a single
            # transient blip without falsely triggering the safe-state
            # response on every momentary hiccup.
            had_points_to_check = bool(node_ids) or bool(writes)
            sweep_fully_dead = had_points_to_check and not new_cache and not sweep_ok

            if sweep_fully_dead:
                self._consecutive_dead_sweeps += 1
            else:
                self._consecutive_dead_sweeps = 0

            if self._consecutive_dead_sweeps >= 3 and self._comms_healthy:
                self._comms_healthy = False

                # Never allow old PLC -> OMS values to survive a
                # communication loss.  poll() will force the PLC ->
                # OMS signals to their safe values while unhealthy.
                with self._lock:
                    self._read_cache.clear()

                self._log_event("Communication with the PLC was lost.")

            elif not sweep_fully_dead and not self._comms_healthy:
                self._comms_healthy = True
                self._log_event("Communication with the PLC was restored.")

            if sweep_ok and self._had_error:
                self._had_error = False

            self._stop_event.wait(self.BACKGROUND_INTERVAL_S)

    def _log_event(self, message):
        with self._lock:
            self.event_log.append(message)
            del self.event_log[:-self.EVENT_LOG_MAX]

    def _report_error(self, message):
        print("[PLC ERROR]", message)
        """Records the error, but only when the message actually
        changed -- a node that's broken every single sweep would
        otherwise flood the log five times a second."""
        self._had_error = True
        if message != self.last_error:
            self.last_error = message
            self._log_event(message)

    def _report_mapping_error(self, point_key, message):
        if self._last_shown_error_msg.get(point_key) != message:
            self._last_shown_error_msg[point_key] = message
            self._log_event(message)

    # ---------- GUI-thread entrypoint: called every ~100ms by SimulationView ----------

    def poll(self):

        if not self.is_connected:
            return

        mapped = self._resolve_mapped_points()

        writes_to_queue = {}

        resolved = []
        for entry in mapped:
            oms_type = None
            if entry["getter"] is not None:
                try:
                    oms_type = type(entry["getter"]())
                except Exception:
                    oms_type = None

            mapping_error = type(self).validate_address(
                entry["plc_node"], expected_type=oms_type,
            )
            print("[POLL RESOLVED]", entry["item"].tag_name, entry["io_point"], entry["plc_node"], "error=", mapping_error)
            resolved.append((entry, oms_type, mapping_error))

        node_ids_needed = {
            e["plc_node"] for e, _, err in resolved if err is None
        }

        with self._lock:
            self._known_node_ids = node_ids_needed
            self._read_cache = {
                k: v for k, v in self._read_cache.items() if k in node_ids_needed
            }
            self._last_written = {
                k: v for k, v in self._last_written.items() if k in node_ids_needed
            }
            cached_reads = dict(self._read_cache)
            last_written_snapshot = dict(self._last_written)

        for entry, oms_type, mapping_error in resolved:
            node_id = entry["plc_node"]

            point_key = (entry["item"].tag_name, entry.get("io_point"))
            
            if mapping_error is not None:
                object_tag = getattr(entry["item"], "tag_name", "Unknown object")
                io_point = entry.get("io_point", "Unknown point")

                already_reported = point_key in self._reported_mapping_errors

                self._report_mapping_error(
                    point_key,
                    f"Object: {object_tag}\n"
                    f"I/O Point: {io_point}\n"
                    f"PLC Address: {node_id}\n"
                    f"Problem: {mapping_error}\n\n"
                    f"Fix the PLC Node mapping."
                )

                if not already_reported and entry["setter"] is not None:
                    safe_value = False if oms_type is bool else 0 if oms_type in (int, float) else None
                    if safe_value is not None:
                        try:
                            entry["setter"](safe_value)
                        except Exception:
                            pass

                continue

            else:
                self._reported_mapping_errors.discard(point_key)
                self._last_shown_error_msg.pop(point_key, None)

            if entry["setter"] is not None:
                # PLC -> OMS.
                #
                # When communication is lost, NEVER apply the last
                # cached PLC value.  The last cached value may be TRUE
                # even though the PLC has stopped.
                #
                # Instead force the PLC-controlled OMS signal to its
                # safe value until communication is restored.
                if not self._comms_healthy:
                    safe_value = (
                        False
                        if oms_type is bool
                        else 0
                        if oms_type in (int, float)
                        else None
                    )

                    if safe_value is not None:
                        try:
                            entry["setter"](safe_value)
                        except Exception:
                            pass
                    continue

                if node_id in cached_reads:
                    try:
                        entry["setter"](cached_reads[node_id])
                    except Exception:
                        pass

            else:
                # OMS -> PLC.
                #
                # Communication loss must NOT modify the OMS-side
                # command/state. Keep this direction independent from
                # the PLC -> OMS safe-state handling.
                if oms_type is None:
                    continue

                value = entry["getter"]()

                if last_written_snapshot.get(node_id) != value:
                    writes_to_queue[node_id] = value

        with self._lock:

            if writes_to_queue:
                self._pending_writes.update(writes_to_queue)
                self._last_written.update(writes_to_queue)

    def _resolve_mapped_points(self):
        """Matches scene.plc_mapping entries (object_tag, io_point,
        plc_node) back to live scene objects and their getter/setter
        pair. Deliberately independent of api/mapping.py (this module
        has no web-framework dependency either), even though the logic
        mirrors MappingPanel._scan_scene() in the original desktop
        app."""
        by_tag = {}
        for obj in self.scene.objects.values():
            tag = getattr(obj, "tag_name", None)
            if tag is not None and hasattr(obj, "get_plc_io_points"):
                by_tag[tag] = obj

        resolved = []
        for entry in self.scene.plc_mapping:
            item = by_tag.get(entry.get("object_tag"))
            if item is None:
                continue

            io_points = item.get_plc_io_points()
            point = io_points.get(entry.get("io_point"))
            if point is None:
                continue

            getter, setter = point
            node_id = entry.get("plc_node")
            if not node_id:
                continue

            resolved.append({
                "item": item,
                "getter": getter,
                "setter": setter,
                "plc_node": node_id,
                "io_point": entry.get("io_point"),
            })

        return resolved

# =============================================================================
# OPC UA backends
# =============================================================================

class AsyncuaPlcSync(PlcSyncBase):
    """OPC UA backend using the asyncua library's built-in synchronous
    wrapper (asyncua.sync.Client), so no manual asyncio event loop
    management is needed in this file."""

    ADDRESS_FORMAT_HINT = (
        'OPC UA Node ID, e.g. "ns=3;s=Line1.Cylinder1.Extend" — same '
        'format as the "opcua" backend; either can be used for the '
        "same server."
    )

    def __init__(self, scene, url, username=None, password=None,
                 security_policy=SECURITY_NONE, certificate_path=None,
                 private_key_path=None):
        super().__init__(scene)
        self.url = url
        self.username = username
        self.password = password
        self.security_policy = security_policy
        self.certificate_path = certificate_path
        self.private_key_path = private_key_path

    def _make_client(self):
        if not _ASYNCUA_AVAILABLE:
            raise PlcConnectionError(
                "The 'asyncua' package is not installed in this Python "
                "environment. Install it with: pip install asyncua"
            )

        client = AsyncuaSyncClient(self.url)
        if self.username:
            client.set_user(self.username)
        if self.password:
            client.set_password(self.password)

        _apply_opcua_security(
            client, self.security_policy, self.certificate_path, self.private_key_path
        )

        return client

    def _write_node(self, node_id, value):
        # Siemens S7-1500's OPC UA server rejects writes where the
        # client either (a) sends a Variant whose type doesn't exactly
        # match the tag's real server-side type -- Python is
        # dynamically typed, OPC UA isn't, so a bare `True`/`False`
        # forces the library to guess -- or (b) includes source/server
        # timestamps in the DataValue, which the base class's default
        # set_value() can end up doing depending on library version.
        # Both surface as the same BadWriteNotSupported error. Fix:
        # read the node's own current type and build an explicit,
        # timestamp-free Variant/DataValue with that type before
        # writing.
        from asyncua import ua
        node = self._client.get_node(_normalize_opcua_node_id(node_id))
        variant_type = node.get_data_value().Value.VariantType
        node.set_value(ua.DataValue(ua.Variant(value, variant_type)))

    @classmethod
    def validate_address(cls, node_id, expected_type=None):
        return _validate_opcua_node_id(node_id)


class OpcuaPlcSync(PlcSyncBase):
    """OPC UA backend using the classic python-opcua library."""

    ADDRESS_FORMAT_HINT = (
        'OPC UA Node ID, e.g. "ns=3;s=Line1.Cylinder1.Extend" — same '
        'format as the "asyncua" backend; either can be used for the '
        "same server."
    )

    def __init__(self, scene, url, username=None, password=None,
                 security_policy=SECURITY_NONE, certificate_path=None,
                 private_key_path=None):
        super().__init__(scene)
        self.url = url
        self.username = username
        self.password = password
        self.security_policy = security_policy
        self.certificate_path = certificate_path
        self.private_key_path = private_key_path

    def _make_client(self):
        if not _OPCUA_AVAILABLE:
            raise PlcConnectionError(
                "The 'opcua' package is not installed in this Python "
                "environment. Install it with: pip install opcua"
            )

        client = OpcuaClient(self.url)
        if self.username:
            client.set_user(self.username)
        if self.password:
            client.set_password(self.password)

        _apply_opcua_security(
            client, self.security_policy, self.certificate_path, self.private_key_path
        )

        return client

    def _write_node(self, node_id, value):
        # Same Siemens-specific fix as AsyncuaPlcSync._write_node --
        # see the comment there for why this is needed.
        from opcua import ua
        node = self._client.get_node(node_id)
        variant_type = node.get_data_value().Value.VariantType
        node.set_value(ua.DataValue(ua.Variant(value, variant_type)))

    @classmethod
    def validate_address(cls, node_id, expected_type=None):
        return _validate_opcua_node_id(node_id)

# =============================================================================
# Siemens S7 backend
# =============================================================================

# Recognized address forms (case-insensitive), all relative to a Data
# Block, using canonical Siemens DB notation:
#   DB<db>.DBX<byte>.<bit>   bool     e.g. "DB1.DBX0.0"
#   DB<db>.DBB<byte>         byte     e.g. "DB1.DBB2"      (0-255)
#   DB<db>.DBW<byte>         word     e.g. "DB1.DBW4"      (0-65535, unsigned)
#   DB<db>.DBD<byte>         REAL     e.g. "DB1.DBD10"     (32-bit float --
#                                     the canonical Siemens DBD notation is
#                                     treated as REAL, since that's what
#                                     OMS's real-valued I/O points need;
#                                     use the explicit typed forms below if
#                                     you specifically need a 32-bit
#                                     integer at that same address)
#
# Explicit typed forms, for addresses whose 16/32-bit storage doesn't
# map 1:1 onto a single canonical letter (Siemens' own DBW is used for
# both WORD and INT; DBD is used for DINT, DWORD, AND REAL -- the
# address alone can't disambiguate those, only the PLC program's own
# variable declaration can):
#   DB<db>.INT<byte>         int      e.g. "DB1.INT4"    (16-bit, signed)
#   DB<db>.DINT<byte>        dint     e.g. "DB1.DINT6"   (32-bit, signed)
#   DB<db>.DWORD<byte>       dword    e.g. "DB1.DWORD6"  (32-bit, unsigned)
#   DB<db>.REAL<byte>        real     e.g. "DB1.REAL10"  (32-bit float,
#                                     same as DBD<byte> -- provided for
#                                     symmetry/clarity)
#
# Only Data Block (DB) addressing is supported for now -- covers the
# large majority of real-world PLC tag mapping. Inputs/Outputs/Merkers
# (I/Q/M areas) aren't implemented yet; ask if you need them.
_S7_CANONICAL_ADDRESS_RE = re.compile(
    r'^\s*DB(?P<db>\d+)\s*\.\s*DB'
    r'(?P<type>X|B|W|D)'
    r'(?P<byte>\d+)'
    r'(?:\.(?P<bit>[0-7]))?\s*$',
    re.IGNORECASE,
)

_S7_TYPED_ADDRESS_RE = re.compile(
    r'^\s*DB(?P<db>\d+)\s*\.\s*'
    r'(?P<type>INT|DINT|DWORD|REAL)'
    r'(?P<byte>\d+)\s*$',
    re.IGNORECASE,
)

_S7_IO_AREA_MAP = {"I": "PE", "Q": "PA", "M": "MK"}  # maps to Areas.PE/PA/MK

_S7_IO_ADDRESS_RE = re.compile(
    r'^\s*(?P<area>I|Q|M)'
    r'(?P<type>B|W|D)?'
    r'(?P<byte>\d+)'
    r'(?:\.(?P<bit>[0-7]))?\s*$',
    re.IGNORECASE,
)

_S7_TYPE_SIZES = {
    "X": 1,      # bit -- read/write the whole containing byte
    "B": 1,
    "W": 2,
    "INT": 2,
    "DINT": 4,
    "DWORD": 4,
    "REAL": 4,
}

# The Python type each S7 dtype implies -- this is the "PLC address
# type" half of the OMS-type-vs-PLC-type check described in the module
# docstring. Kept as its own table (rather than folded into
# _S7_TYPE_SIZES) since it's conceptually a different axis: size in
# bytes vs. what kind of Python value that data represents.
_S7_PYTHON_TYPES = {
    "X": bool,
    "B": int,
    "W": int,
    "INT": int,
    "DINT": int,
    "DWORD": int,
    "REAL": float,
}


class S7Address:
    """Parsed representation of one Data Block address string, e.g.
    "DB1.DBX0.0" or "DB1.DBD10". See the format table above."""

    def __init__(self, db, dtype, byte, bit=None, area=None):
        self.db = db
        self.dtype = dtype
        self.byte = byte
        self.bit = bit
        self.area = area if area is not None else Areas.DB

    @property
    def size(self):
        return _S7_TYPE_SIZES[self.dtype]

    @property
    def python_type(self):
        """The Python type (bool/int/float) this address's dtype
        implies -- see _S7_PYTHON_TYPES."""
        return _S7_PYTHON_TYPES[self.dtype]

    @classmethod
    def parse(cls, text):
        text = text or ""

        match = _S7_CANONICAL_ADDRESS_RE.match(text)
        if match:
            db = int(match.group("db"))
            storage_type = match.group("type").upper()
            byte = int(match.group("byte"))
            bit_text = match.group("bit")
            bit = int(bit_text) if bit_text is not None else None

            # DBx.DBDn is the normal Siemens notation for a 4-byte
            # value. OMS maps the canonical DBD form to REAL -- the
            # common case for this app's real-valued I/O mappings. Use
            # the explicit "DB1.DINT..." / "DB1.DWORD..." forms below
            # when the underlying PLC variable is actually a 32-bit
            # integer, not a REAL, at that address.
            dtype = "REAL" if storage_type == "D" else storage_type
        else:
            io_match = _S7_IO_ADDRESS_RE.match(text)
            if io_match:
                area_letter = io_match.group("area").upper()
                type_letter = io_match.group("type")
                byte = int(io_match.group("byte"))
                bit_text = io_match.group("bit")
                bit = int(bit_text) if bit_text is not None else None
                dtype = "REAL" if type_letter and type_letter.upper() == "D" else (type_letter.upper() if type_letter else "X")
                db = 0
                area = getattr(Areas, _S7_IO_AREA_MAP[area_letter])
                if dtype == "X" and bit is None:
                    raise PlcConnectionError(f"Invalid S7 address {text!r}: a bit address needs a .bit suffix, e.g. 'I0.0'.")
                return cls(db, dtype, byte, bit, area=area)

            typed = _S7_TYPED_ADDRESS_RE.match(text)

            if not typed:
                raise PlcConnectionError(
                    f"Invalid S7 address {text!r}. Expected a Data Block "
                    f"address like 'DB1.DBX0.0' (bool), 'DB1.DBB2' (byte), "
                    f"'DB1.DBW4' (word), or 'DB1.DBD6' (REAL). Explicit "
                    f"typed forms are also accepted: 'DB1.INT4', 'DB1.DINT6', "
                    f"'DB1.DWORD6', or 'DB1.REAL10'."
                )
            db = int(typed.group("db"))
            dtype = typed.group("type").upper()
            byte = int(typed.group("byte"))
            bit = None

        if dtype == "X" and bit is None:
            raise PlcConnectionError(
                f"Invalid S7 address {text!r}: a bit address (X) needs "
                f"a .bit suffix, e.g. 'DB1.DBX0.0'."
            )

        return cls(db, dtype, byte, bit)


def _s7_decode(dtype, data, bit=None):
    """Decodes a raw byte buffer (as returned by db_read) into a
    Python value, given the parsed type. S7 uses big-endian byte
    order throughout."""
    if dtype == "X":
        return bool((data[0] >> bit) & 1)
    if dtype == "B":
        return data[0]
    if dtype == "W":
        return struct.unpack(">H", bytes(data))[0]
    if dtype == "INT":
        return struct.unpack(">h", bytes(data))[0]
    if dtype == "DINT":
        return struct.unpack(">i", bytes(data))[0]
    if dtype == "DWORD":
        return struct.unpack(">I", bytes(data))[0]
    if dtype == "REAL":
        return struct.unpack(">f", bytes(data))[0]
    raise PlcConnectionError(f"Unsupported S7 type: {dtype!r}")


def _s7_encode(dtype, value, current_byte=None, bit=None):
    """Encodes a Python value into a raw byte buffer ready for
    db_write. For a single bit (X), current_byte must be the byte's
    existing contents (read first), so the other 7 bits are
    preserved -- S7 has no bit-level write, only whole-byte writes."""
    if dtype == "X":
        byte_value = current_byte if current_byte is not None else 0
        if value:
            byte_value |= (1 << bit)
        else:
            byte_value &= ~(1 << bit) & 0xFF
        return bytes([byte_value])
    if dtype == "B":
        return bytes([int(value) & 0xFF])
    if dtype == "W":
        return struct.pack(">H", int(value) & 0xFFFF)
    if dtype == "INT":
        return struct.pack(">h", int(value))
    if dtype == "DINT":
        return struct.pack(">i", int(value))
    if dtype == "DWORD":
        return struct.pack(">I", int(value) & 0xFFFFFFFF)
    if dtype == "REAL":
        return struct.pack(">f", float(value))
    raise PlcConnectionError(f"Unsupported S7 type: {dtype!r}")


class S7PlcSync(PlcSyncBase):
    """Siemens S7comm backend using python-snap7. Addresses are Data
    Block memory locations (see S7Address), not OPC UA node IDs, so
    this overrides the connect/read/write hooks instead of relying on
    PlcSyncBase's OPC UA-shaped defaults.

    rack/slot identify which physical CPU slot to target and vary by
    CPU family -- commonly rack 0 / slot 2 for S7-300, rack 0 / slot 1
    for many S7-1200/1500s, but always confirm against the actual
    hardware configuration."""

    ADDRESS_FORMAT_HINT = (
        'S7 Data Block address, e.g. "DB1.DBX0.0" (bool), "DB1.DBB2" '
        '(byte), "DB1.DBW4" (word/int), or "DB1.DBD10" (REAL). Use '
        '"DB1.DINT6" / "DB1.DWORD6" for an explicit 32-bit integer '
        'instead of REAL at that address — not an OPC UA node ID.'
    )

    def __init__(self, scene, ip, rack=0, slot=1):
        super().__init__(scene)
        self.ip = ip
        self.rack = rack
        self.slot = slot

    def _make_client(self):
        if not _S7_AVAILABLE:
            raise PlcConnectionError(
                "The 'python-snap7' package is not installed in this "
                "Python environment. Install it with: pip install "
                "python-snap7"
            )
        return S7Client()

    def _connect_client(self, client):
        client.connect(self.ip, self.rack, self.slot)

    def _read_node(self, node_id):
        addr = S7Address.parse(node_id)
        data = self._client.read_area(addr.area, addr.db, addr.byte, addr.size)
        return _s7_decode(addr.dtype, data, addr.bit)

    def _write_node(self, node_id, value):
        addr = S7Address.parse(node_id)
        if addr.dtype == "X":
            current = self._client.read_area(addr.area, addr.db, addr.byte, 1)
            encoded = _s7_encode("X", value, current_byte=current[0], bit=addr.bit)
        else:
            encoded = _s7_encode(addr.dtype, value)
        self._client.write_area(addr.area, addr.db, addr.byte, bytearray(encoded))

    @classmethod
    def validate_address(cls, node_id, expected_type=None):
        try:
            addr = S7Address.parse(node_id)
        except PlcConnectionError as exc:
            return str(exc)

        if expected_type is not None and addr.python_type is not expected_type:
            return (
                f"Type mismatch: this OMS point is "
                f"{expected_type.__name__}, but {node_id!r} is a "
                f"{addr.dtype} address ({addr.python_type.__name__})."
            )

        return None

    @classmethod
    def expected_python_type(cls, node_id):
        try:
            return S7Address.parse(node_id).python_type
        except PlcConnectionError:
            return None


# =============================================================================
# Factory
# =============================================================================

# Lets callers (e.g. ui/mapping_dialog.py) look up a backend's address
# format hint by name, without needing a live, connected instance --
# useful for showing "here's the format you'll need" as soon as a
# connection type is selected, even before any connection attempt has
# succeeded (or been made at all).
ADDRESS_FORMAT_HINTS = {
    BACKEND_ASYNCUA: AsyncuaPlcSync.ADDRESS_FORMAT_HINT,
    BACKEND_OPCUA: OpcuaPlcSync.ADDRESS_FORMAT_HINT,
    BACKEND_S7: S7PlcSync.ADDRESS_FORMAT_HINT,
}

_BACKEND_CLASSES = {
    BACKEND_ASYNCUA: AsyncuaPlcSync,
    BACKEND_OPCUA: OpcuaPlcSync,
    BACKEND_S7: S7PlcSync,
}

def validate_address_for_backend(backend, node_id, expected_type=None):
    """Validates a single PLC Node ID string against `backend`'s
    expected address format -- no live connection, no client library
    needed. Used by ui/mapping_dialog.py's "Validate Mappings" button
    so addresses can be checked before ever attempting to connect.

    expected_type, if given, is the OMS I/O point's own Python type
    (bool/int/float) -- see S7PlcSync.validate_address for how S7
    additionally checks this against the address's implied type.
    Backends that can't determine a real type without a live
    connection (OPC UA) simply ignore it.

    Returns None if `backend` isn't recognized (nothing to check
    against) or if the address is valid; otherwise a short
    human-readable reason."""
    cls = _BACKEND_CLASSES.get(backend)
    if cls is None:
        return None
    return cls.validate_address(node_id, expected_type=expected_type)


def create_plc_sync(backend, scene, **params):
    """Factory used by the Connect dialog. `backend` is one of
    BACKEND_ASYNCUA / BACKEND_OPCUA / BACKEND_S7. `params` are passed
    straight through as keyword args to the matching subclass's
    __init__ -- see each class for what it expects:

        asyncua / opcua : url, username=None, password=None
        s7               : ip, rack=0, slot=1
    """
    if backend == BACKEND_ASYNCUA:
        return AsyncuaPlcSync(scene, **params)
    elif backend == BACKEND_OPCUA:
        return OpcuaPlcSync(scene, **params)
    elif backend == BACKEND_S7:
        return S7PlcSync(scene, **params)
    else:
        raise ValueError(f"Unknown PLC sync backend: {backend!r}")