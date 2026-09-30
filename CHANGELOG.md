
## v11.4 — Project-load PLC Mapping refresh
- Fixed PLC Mapping not immediately showing component/system tags after opening a `.oms` project.
- Project loading now sends an immediate refreshed tag catalog and PLC mapping snapshot.
- Frontend resets the mapping table cache and rebuilds it from the freshly loaded project state.
- Sensor tags such as `Sensor_Box.detected`, `Sensor_HomePos.detected`, and `Sensor_WorkPos.detected` are now refreshed immediately after project load.
- No Inspector tabs added.
# OMS Web – Architecture Update

## v9 — Alarm System

- Added central tag-driven alarm engine with safe expressions, severity, latching and acknowledgement.
- Added active alarm state and bounded event history.
- Added Alarm inspector panel and alarm project persistence.
- Alarm evaluation remains active during E-Stop.


## 2.1 — Simulation logic / sequence control

- Added rising-edge and falling-edge logic conditions.
- Added deterministic on-delay timers (`delay_ms`) for level conditions.
- Added configurable true/false destination values to logic rules.
- Logic runtime state resets safely when the scene/rule set is reset.
- Project format advanced to version 3; older projects migrate in memory.


## Next simulation step — cylinder physical I/O targets

- Cylinders can now physically actuate Sensors and Push buttons, in addition to conveyor interactions.
- Sensor/push-button targets are momentary: they release automatically when the cylinder retracts or loses contact.
- The Design inspector exposes conveyor, sensor, and push-button targets for cylinder interactions.
- Added regression tests for both physical target types.


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


## v4 — Sequence Control
- Added deterministic step/transition sequence engine for Simulation mode.
- Added step actions, edge/level transitions, timeouts, fault/stop/advance handling, and continuous cycles.
- Added Sequence editor and live sequence status panel.
- Added `.oms` v3 → v4 migration and sequence persistence.
- Runtime remains PLC-controlled and does not execute simulation sequences.


## v6 — Central Tag / Variable System
- Added a central tag registry shared by simulation, PLC mapping and future Runtime features.
- Component I/O points are exposed as stable tags (`Object.IOPoint`).
- Added persistent internal OMS tags with datatype, description and writable state.
- Added Tags inspector panel.
- Added tag read/write API and project persistence.

## v7.1 - Visual Tag Logic Editor

- Replaced the prompt-based internal-tag `fx` editor with a visual condition builder.
- Select source tags from a dropdown instead of typing `tag("...")` manually.
- Select comparison operators appropriate to the tag datatype.
- Enter boolean, numeric, or text comparison values using normal form controls.
- Add multiple conditions joined by AND/OR.
- Live preview shows the generated OMS expression.
- Advanced mode remains available for complex expressions.
- Existing simple expressions are loaded back into the visual builder.

## v8 - Internal tag connections and PLC mapping search
- Internal tags can connect to component I/O signals.
- Connected internal tags inherit the component signal datatype, direction, live value and writability.
- Internal tags now appear in PLC Mapping and can be mapped directly to PLC addresses.
- PLC synchronization resolves `tag_name` mappings through the central tag registry.
- Mapping Search opens the existing parsed S7/OPC UA address picker for every tag.
- PLC mapping validation and force support include central tags.
- Bound internal-tag connections persist in `.oms` projects.


## v10.1 — Hierarchy editor usability

- Added a dedicated Machine Hierarchy editor in the Engineering tab.
- Components can be dragged onto another component to change their parent.
- Components can be dragged to the Root drop area or moved to Root with a button.
- Clarified that engineering connections are separate from hierarchy.
- Replaced ambiguous `+` / `✓` connection controls with `+ Connection` / `✓ Validate`.
- Added hierarchy regression tests for parent assignment, root moves, and cycle prevention.

## v10.2 — Engineering diagnostics

- Added a cross-system Diagnostics inspector panel.
- Diagnostics validate machine hierarchy, engineering connections, central tags, alarms, simulation logic, sequences and PLC mappings.
- Added severity levels (error, warning, info) with deterministic issue ordering and a project-valid summary.
- Added regression coverage for clean projects, missing alarm/mapping references, hierarchy cycles and duplicate engineering connections.

## v10.3 — Tag Trends
- Added a bounded in-memory trend recorder sampling selected numeric OMS tags once per second.
- Added Inspector → Trends with numeric tag selection, live history chart and Clear action.
- Trend data uses the central OMS Tag Registry and is available in Design, Simulation and Runtime sessions.
- Boolean tags are intentionally excluded from numeric plots; alarm/event history remains the appropriate representation for discrete states.

## v11 — Production Information
- Added central-tag-driven production counters and OEE foundation.
- Added Production inspector panel with trigger configuration, reset, cycle time and KPI display.
- Production configuration is saved in `.oms` projects.
- Project format advanced to version 11.

## v11.1 Dashboard
- Added a separate operator Dashboard overlay accessible from the main toolbar.
- Kept the Inspector tab set unchanged.
- Dashboard combines production KPIs, machine status, active alarms, and PLC status.
- Dashboard uses existing WebSocket state; no duplicate data model was introduced.

## v11.5 — PLC Mapping saved-project fallback
- Fixed PLC Mapping rows disappearing when the component tag catalog arrives stale or out of order during project load.
- PLC Mapping now uses the saved `plc.mapping` entries as an authoritative fallback and can render mapped component I/O directly from the backend signal catalog.
- Sensor mappings such as `Sensor_Box.detected`, `Sensor_HomePos.detected`, and `Sensor_WorkPos.detected` remain visible even if the tag catalog refresh is delayed.
- No Inspector tabs added.
