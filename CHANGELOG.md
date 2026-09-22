# OMS Web – Architecture Update

## 2.0 foundation update

- Fixed conveyor visual direction by removing the independent CSS belt animation and rendering belt phase from the server simulation state.
- Added actual elapsed-time simulation with a bounded `dt`.
- Added typed `Signal` I/O descriptors.
- Added `Project` and per-browser `ProjectSession` models.
- Isolated scenes, modes, PLC connections and project state per WebSocket client.
- Added project format version 2 and version-1 migration support.
- Kept PLC adapters compatible with the existing I/O getter/setter API while moving mapping resolution to typed signals.
- Added structured PLC logging in place of debug `print()` calls.
- Added component-delete cleanup for PLC mappings.
- Added regression tests for conveyor direction, elapsed-time simulation, signals, serialization, migration and session isolation.
- Split WebSocket transport and conveyor rendering into frontend modules.
- Updated asset cache version from `v=5` to `v=6`.
- Added development documentation and `.gitignore`.

## 2026-09-21 — Conveyor interaction/direction fix

- Fixed simulation-mode conveyor clicks so each click toggles the **current** running state; the first click starts and the next click stops.
- Fixed conveyor belt visual phase direction so the belt markings move in the same direction as the simulated boxes.
- Bumped web asset cache version from `v=7` to `v=8`.
