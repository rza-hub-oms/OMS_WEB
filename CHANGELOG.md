## v11.23 — 3D conveyor roller and cylinder motion correction
- Rebuilt conveyor roller layout as evenly spaced transverse rollers across the belt width, rather than four small cylinders at the corners.
- Corrected roller animation to rotate each roller about its own longitudinal axis and stop when the conveyor is stopped, faulted, or emergency-stopped.
- Reworked pneumatic-cylinder geometry to align with the backend's local X-axis and normalized progress range; the exposed rod now grows from the gland toward the configured extension limit, and its end head follows the rod tip.
- Hardened 3D drag initiation with pointer capture, touch-action suppression, and prevention of the same pointer-down starting a second interaction.
- Bumped frontend/module cache versions.
- Validation: 64 Python tests passed; JavaScript syntax and Python compilation passed. Browser interaction testing was not available.

## v11.22 — 3D layout editing and industrial detail
- Added direct drag-to-reposition for existing 3D components in Design mode, with 10-unit layout snapping and saved X/Y coordinates.
- Added a 90-degree rotate-selected control in the 3D toolbar, routed through the existing component property system.
- Refined conveyor geometry with slimmer fabricated rails, feet, exposed fasteners, and less block-like proportions.
- Preserved the existing 2D editor, shared properties inspector, and simulation-mode interactions.

## v11.20 — 3D Simulation Property Parity
- 3D component selection opens the existing Properties inspector, exposing the same component settings, live status, and Simulation Controls as the 2D view.
- Added Simulation-only press/release controls for push buttons, latch/reset controls for emergency push buttons, and ON/OFF controls for toggle switches.
- Added direct 3D interaction for momentary push buttons, emergency push buttons, and toggle switches in Simulation mode.
- Reflected live machine states in 3D: conveyor roller motion, motor rotation, cylinder extension progress, sensor detection illumination, control actuation, tower-light states, index-table motion, and fault/E-stop indicators.
- Kept the existing 2D view and backend simulation command/property paths; bumped the frontend script version to avoid stale cache.
- Validation: 64 Python tests passed; JavaScript syntax, Python compilation, and ZIP integrity checked.

## v11.19 — Dedicated Logic Editor Workspace
- Replaced the dense Logic Inspector form with a compact launch card and live rule counts.
- Added a large Logic Editor workspace using the existing overlay infrastructure, with rule totals, enabled-rule count, readable-I/O count, and clearer IF/THEN editing layout.
- Kept the existing rule model, validation action, and backend protocol; the editor moves the original panel into the workspace to preserve event handlers and current state.
- Updated frontend asset version to prevent stale cached JavaScript/CSS.
- Validation: Python tests, Python compilation, JavaScript syntax, and ZIP integrity checked.

## v11.18 — PLC Mapping Workspace Dialog Layer Fix
- Fixed Import DB Tags and Select PLC Address dialogs opening behind the expanded PLC Mapping workspace.
- Raised standard modal overlays above the engineering workspace overlay so nested workflows remain visible and interactive.
- Bumped frontend asset query versions to avoid stale CSS/JavaScript being served from browser cache.
- Validation: Python test suite, Python compilation, JavaScript syntax, and ZIP integrity checked.

## v11.16 — Simulation Operation Controls

- Added Simulation-only Start/Stop and Forward/Reverse controls to the Properties inspector for conveyors and motors.
- Added Simulation-only Extend/Retract controls for single-valve cylinders and mutually exclusive Extend/Retract plus Hold controls for dual-valve cylinders.
- Expanded conveyor and motor live status rows to distinguish run command from effective running state and expose speed/direction or estimated motor current.
- Controls issue component I/O commands and do not mark the design project dirty.
- Runtime remains separate; these virtual controls are not presented as physical PLC commands.
- Validation: 59 Python tests passed; JavaScript syntax check passed.

## v11.15 — Direct HMI Widget Resizing
- Added a visible resize handle to the selected widget in Edit Layout mode.
- Drag the lower-right handle to resize widgets on the canvas; sizes snap to the existing 10 px grid and respect minimum dimensions.
- Existing numeric W/H fields remain available in the widget editor.
- Resized geometry is persisted with the operator screen configuration.
- No Inspector tabs added.

## v11.10 — Operator Screens
- Added an operator screen navigator and Runtime-only navigation bar.
- Reuses existing Dashboard, Reports, Alarms, Trends, Production and Diagnostics views.
- No new Inspector tabs.

## v11.8 — Project Save/Load Hardening

- Added project schema validation before loading.
- Rejects unsupported future project versions and malformed project structures without replacing the current scene.
- Added load error reporting in the web UI.
- Added Ctrl/Cmd+S shortcut and browser unsaved-change warning.
- Project version advanced to 12; older projects continue to migrate.

## v11.7 — Shift Production

- Added current shift information to Dashboard and Reports without adding an Inspector tab.
- Added shift name, start time and elapsed time to production snapshots.
- Added New Shift operator action to reset production counters and start a new shift.
- Shift name is preserved in project production configuration.
- Reports CSV now includes shift information.


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

## v11.6
- Added Reports as a separate operator/engineering overlay; no Inspector tab added.
- Added session operational history view for production KPIs, alarm history, PLC events, and recent trend samples.
- Added CSV export for production, alarm, and PLC operational data.
- Reports update live while open and reuse existing OMS state/history sources.
- Browser asset cache version bumped to app.js?v=16.


## v11.9
- Added automatic browser-local recovery backups for dirty projects.
- Added Recover action to restore the latest automatic backup after an unexpected browser/app close.
- Added backend project snapshot endpoint used by recovery without changing Save behavior.
- Recovery backup is refreshed shortly after project edits and is cleared from active dirty state after a normal save.

## v11.11 - Configurable Operator Screens
- Added project-specific operator screens without adding Inspector tabs.
- Added Screens manager with New Screen and Delete actions.
- Custom screens can combine existing Machine, Dashboard, Alarms, Trends, Production, Diagnostics, and Reports views.
- Custom operator screen definitions are persisted in project metadata and restored when a project is opened.
- Runtime navigation automatically includes configured custom screens.
- Added a dedicated custom-screen operator view with navigation back to existing OMS views.

## v11.13 — HMI Widget Extensions
- Expanded custom operator screens with reusable KPI, Production, PLC Status, Mini Trend, and Machine Status widgets.
- Added live binding/refresh using existing OMS production, trend, PLC, machine-state, and tag data.
- Added widget metric configuration without adding Inspector tabs.
- Project version advanced to 13.

## v11.17 — Simulation Sensor Inputs

- Added Simulation-only Force ON, Force OFF, and Auto/Physical controls for sensors in the Properties inspector.
- Sensor overrides affect the effective PLC-visible sensor signal while physical detection continues updating underneath; switching back to Auto restores geometry/watch-target-based detection.
- Normally-open/normally-closed electrical behavior remains applied to the effective sensor state.
- Added a dedicated WebSocket action guarded to Simulation mode so sensor forcing cannot override live Runtime PLC feedback.
- Persisted sensor override state through project serialization for repeatable simulation setups.
- Added regression tests for forced inputs, automatic restoration, NC behavior, and project round-tripping.
- Added a one-click **Sensor → Conveyor Demo** sequence template in the Sequences panel. It runs the first conveyor until the first sensor activates, stops while the sensor remains active, then repeats after the sensor clears; timeout protection is enabled on the detection step.

## v11.18 — Full Machine Cycle Template

- Added a one-click Full Machine Cycle template to the Sequences panel.
- The template coordinates conveyor feed, optional motor run, cylinder extension, cylinder end-position confirmation, retraction, and station release.
- The template requires a part-detection sensor watching the conveyor and a second limit sensor watching the cylinder; it provides setup guidance if the limit sensor is missing.
- Each wait step has a timeout that faults the sequence rather than silently advancing when a sensor fails to confirm movement.
- Supports single-valve and dual-valve cylinders; dual-valve extend/retract commands are mutually exclusive.
- Simulation sequence only; does not command physical PLC outputs in Runtime.
- Validation: 62 Python tests passed; JavaScript syntax check passed.

## v11.19 — Sequence fault recovery and production reject rate

- Sequence timeouts can execute explicit per-step `on_fault_actions`, allowing templates to stop conveyors/motors and de-energize cylinder commands when a wait step fails.
- Faulted sequences remain latched and no longer continue evaluating transitions in the background.
- Added Simulation-only **Recover Fault** and **Start** controls. Recovery acknowledges the fault but keeps the sequence stopped; a separate Start is required to run it again.
- Full Machine Cycle template now defines fail-safe output actions for every timeout step.
- Production panel now displays reject rate alongside total/good/reject counts and OEE indicators.
- Added regression tests for timeout fail-safe actions, explicit recovery/restart, and reject-rate calculation.
- Browser asset cache version bumped to app.js?v=21.
- Validation: 64 Python tests passed; Python compilation and JavaScript syntax checks passed.


## v11.17 — Dedicated Sequence Editor Workspace
- Replaced the crowded in-Inspector sequence controls with a compact Sequence Editor launch card and live sequence count.
- Added a large modal workspace for editing sequences with roomier action controls and a scrollable sequence list.
- The existing sequence editor DOM is moved into the workspace while open, preserving control IDs, event handlers and the existing sequence save/validation flow.
- Close via the Close button, Escape, or clicking the backdrop; returns the editor to its original location without losing in-progress field values.
- Responsive layout uses full-screen mode on narrow displays.
- Validation: Python tests, Python compilation and JavaScript syntax check.

## v11.17 — PLC Mapping Workspace
- Expanded PLC Mapping into a wide engineering workspace using the existing Inspector Pop out action.
- Added live summary counters for available signals, mapped addresses, and signals that still need mapping.
- Added workspace guidance and a wider, sticky-header mapping table for easier address editing and live-value inspection.
- Preserved the existing mapping controls, filtering, grouping, PLC address picker, force behavior, and validation flow.
- Updated the frontend asset version to prevent stale browser caching.
- Validation: JavaScript syntax check and Python compilation passed; automated tests are run with `python -m pytest` from the project root.


## v11.20 — Logic live monitor
- Added a live Logic Editor monitor showing each rule source/destination, current simulated values, and condition state.
- Added common condition presets for ON/OFF, equals, not-equals, and edge conditions.
- Monitor updates with incoming simulation state without rebuilding the rule editor controls.

## v11.21 — 3D Machine View foundation
- Added a dedicated 3D Machine View toggle alongside the existing viewport controls.
- Added a Three.js 3D scene with floor grid, lighting, orbit/zoom camera controls, and 3D representations for conveyors, motors, cylinders, sensors, index tables, tower lights, and operator controls.
- Existing scene object positions, dimensions, rotation, conveyor product positions, and runtime states feed the 3D view.
- The existing 2D editor remains available; the 3D engine loads on demand.
- Three.js is currently loaded from a CDN, so the first 3D view requires network access. This is a visualization foundation; full rigid-body physics and collision-based interaction are future work.
- Validation: 64 Python tests passed; JavaScript syntax checks, Python compilation, and ZIP integrity passed.


## v11.22 — Drop Components into the 3D Machine View
- Enabled dragging components from the existing component palette directly into the 3D viewport while in Design mode.
- Converts the drop location into machine-layout coordinates using a ray cast against the 3D ground plane, then uses the existing add-component flow so the new component persists in the simulation model.
- Added a visible drop target highlight and placement prompt.
