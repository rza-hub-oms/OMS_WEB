## Latest 3D motion correction (v11.23)\n\nThe 3D view now renders conveyor rollers as transverse rollers spaced along the belt and spins them around their own axes when the conveyor is available and running. Pneumatic cylinder rods follow the backend cylinder geometry and normalized extension progress, with the rod end moving in the local positive X direction before component rotation. 3D component dragging also uses pointer capture to make drag gestures more reliable.\n\n# OMS Web

OMS Web is a browser-based machine simulation and virtual-commissioning environment with PLC integration.

## Architecture

```text
Browser
  │ WebSocket
  ▼
FastAPI session manager
  │
  ├── ProjectSession (one per browser)
  │     ├── Project
  │     │    └── Scene
  │     │         └── simulation components
  │     └── PLC sync adapter
  │
  └── S7 / OPC UA
```

Each browser connection gets an independent project/session. A project can be saved as `.oms` JSON and is versioned so older projects can be migrated.

## Physical component relations

Cylinders can be configured to interact with conveyors, sensors, and push buttons. Sensor and push-button interactions are physical/momentary: the target is actuated while the cylinder is fully extended and the rod tip overlaps it, then released when the cylinder retracts.

## Modes

- **Design** — edit the machine; simulation is frozen.
- **Simulation** — run the machine without a PLC.
- **Runtime** — run against a connected PLC.

## Simulation engine

The server is the source of truth for component state. The simulation clock uses actual elapsed monotonic time and caps unusually large time steps to prevent a stalled process from teleporting components.

Conveyors expose typed I/O signals for speed, running, direction and status. Conveyor boxes and belt markings use the same backend state; the browser no longer runs a separate CSS animation that can disagree with the simulated direction.

## PLC layer

S7, OPC UA and asyncua adapters consume the same component signal abstraction. PLC communication remains isolated from the simulation engine, and communication loss drives PLC-controlled inputs to safe values.

## Development

From the project root:

```bash
pip install -r requirements.txt
python main.py
```

The application listens on `http://127.0.0.1:8000/`.

For a server-only launch:

```bash
uvicorn api.server:app --host 127.0.0.1 --port 8000
```

## Tests

Run the built-in regression suite:

```bash
python -m unittest discover -s tests -v
```

The tests cover conveyor reverse motion, elapsed-time simulation, typed signals, project round trips, project migration, and session isolation.

## Project files

`.oms` files are JSON documents. Current project format version is **10**. Older project files are migrated in memory when opened.

## Frontend structure

`web/app.js` remains the UI composition layer. Transport is isolated in `web/modules/socket.js`, and conveyor rendering is isolated in `web/modules/conveyor-renderer.js`. More component renderers can follow the same pattern without changing the simulation engine.

## Logging

Use Python's standard logging system rather than ad-hoc `print()` calls. PLC diagnostics are emitted under the `oms.plc` logger.


## Sequence Control (v4)

Simulation mode now includes a deterministic step/transition sequence engine. A sequence contains ordered steps with output actions, I/O-based transitions, optional timeouts, timeout behavior (`fault`, `stop`, or `advance`), and `once`/`continuous` cycle modes. Sequences are simulation-only and are never executed in Runtime mode; the live PLC remains the Runtime source of truth.


## Central Tag System (v6)

OMS now exposes one central tag registry for machine I/O and internal variables.
Component signals are represented as stable tags such as `Conveyor_1.running`
and `Motor_1.speed`. Internal tags can be created from the Tags panel and are
persisted in `.oms` projects. The registry is the common data contract for alarms, engineering structure, trends, Runtime and richer PLC mapping.

## Engineering Structure (v10)
Components can belong to a machine hierarchy through a `parent_tag`. Engineering connections are stored separately from simulation logic and can describe process, control, signal, mechanical and safety relationships. Connections are validated, persisted in `.oms` projects, and cleaned automatically when referenced components are renamed or deleted.


### Engineering hierarchy editor

In Design mode, open **Inspector → Engineering → Machine Hierarchy**. Drag a component onto another component to make it a child. Drag a component to **Drop here to move to Root**, or select it and use **Move to Root**. The **Connections** section below is separate and is used for process/control/signal/mechanical/safety relationships.

### Engineering diagnostics

Open **Inspector → Diagnostics** and select **Run Diagnostics**. The diagnostic pass checks hierarchy references/cycles, engineering connections, central tag bindings and expressions, alarm expressions, simulation logic, sequences, and PLC mappings. Issues are reported as errors, warnings, or informational messages; a project with no errors is shown as valid.

### Trends
The Inspector **Trends** tab can record selected numeric OMS tags at 1-second intervals. History is kept for the current browser session with a bounded 3,600-sample buffer (about one hour per selected tag). The trend recorder reads through the same central tag registry used by simulation, alarms and PLC integration.

### Operator Dashboard
The main toolbar now includes **Dashboard**. It opens a separate operator-oriented overview without adding another Inspector tab. It shows production KPIs, machine status, active alarms, and PLC connection status using the existing OMS state.


### v11.4
PLC Mapping now refreshes its component-backed system tag catalog immediately after opening a `.oms` project, including sensor tags.

### v11.6 Reports
The main toolbar now includes **Reports**. It opens a separate operational-history screen without adding another Inspector tab. Reports shows the current session's production summary, alarm history, PLC events, and recent trend samples, with CSV export for production/alarm/PLC data.

### v11.7 Shift Production
The operator Dashboard and Reports now show the current shift name, start time and elapsed time. Reports provides a **New Shift** action to reset production counters and begin a new shift while in Simulation or Runtime.

### Project Save/Load hardening (v11.8)
Project loading now validates the project before replacing the current scene. Unsupported future versions and malformed project structures are rejected with a clear error. Ctrl/Cmd+S and unsaved-change protection are also supported.


### Project recovery (v11.9)
OMS keeps a recent recovery snapshot in the browser's local storage while a project has unsaved changes. Use **Recover** in the File toolbar after an unexpected close. After recovery, save the project normally. Recovery does not add an Inspector tab.


### v11.10 Operator Screens
The Runtime mode now provides a dedicated operator screen navigator and bottom navigation bar. Existing Dashboard, Reports and Inspector panels are reused; no additional Inspector tabs were introduced.

### v11.11 Operator Screens
The Screens workspace now supports project-specific operator screens. Custom screens are built from existing OMS operator views (Machine, Dashboard, Alarms, Trends, Production, Diagnostics and Reports), saved in project metadata, and exposed in Runtime navigation. No additional Inspector tabs are required.

### v11.13 HMI Widget Extensions
Custom operator screens now support reusable KPI, Production, PLC Status, Mini Trend, and Machine Status widgets in addition to Value, Indicator, Button, Label, and Alarms. Widgets are configured in the Screens workspace and use existing OMS state/tags; no additional Inspector tab is required.


## v11.15 HMI widget resizing
In Screens, open a custom screen and select **Edit layout**. Select a widget and drag the blue lower-right handle to resize it. The size snaps to the grid and is saved with the screen. You can also edit W/H in the widget editor.


## Simulation operation controls (v11.16)

In **Simulation** mode, select a conveyor or motor and use the Properties inspector's
**Simulation Controls** section to Start/Stop and change direction. Select a cylinder
to Extend/Retract it; dual-valve cylinders also have a Hold/Stop command. These controls
are only shown in Simulation mode and operate the virtual component through its I/O
interface. Runtime remains PLC-connected and is not controlled by these simulation buttons.
The inspector reports command state separately from effective running state; motor current
is a deterministic simulated estimate, not a physical measurement.

### Simulating sensor inputs

In **Simulation** mode, select a sensor and use **Force ON**, **Force OFF**, or **Auto / Physical** in the Properties inspector. Forced states are useful for testing sequence transitions before positioning physical simulated objects. Auto / Physical returns the sensor to detection based on its configured watch target and geometry. Sensor forcing is rejected in Runtime mode and does not write to the physical PLC.

### Sensor-to-conveyor sequence demo

In Design mode, open the Sequences panel and choose **Sensor → Conveyor Demo** after adding at least one sensor and one conveyor. OMS creates a continuous two-step sequence: run the conveyor until the sensor is active, stop the conveyor until the sensor clears, then repeat. Validate the sequence, switch to Simulation, and use the sensor's Force ON / Force OFF controls to exercise the transitions. This is a virtual simulation example, not a safety-rated machine control program.

## Full Machine Cycle simulation template

In the Inspector's Sequences panel, choose **Full Machine Cycle** to create a reusable example sequence. It needs a conveyor, a cylinder, a sensor whose Watch Component is the conveyor (part detection), and a second sensor whose Watch Component is the cylinder (end-position confirmation). A motor is included automatically if one exists. Validate the sequence before running it in Simulation. The template faults on missing end-position confirmation rather than assuming the cylinder moved. It is for virtual simulation only and does not execute in Runtime or directly control a physical PLC.

## Sequence fault recovery and reject-rate KPI

Sequence steps may define `on_fault_actions`, a list of normal I/O writes executed once when that step times out. The Full Machine Cycle template uses this to stop conveyor/motor commands and de-energize cylinder valve commands. Faulted sequences latch instead of continuing to evaluate transitions. In Simulation, use **Recover Fault** to acknowledge the fault and leave the sequence stopped, then use **Start** to explicitly restart it. These are simulation-sequence controls and are not a replacement for safety PLCs or physical machine risk assessment.

The Production panel also displays **Reject Rate** (`reject_count / total_count`) as a percentage. Configure production and reject trigger tags as rising-edge boolean signals.


### v11.17 PLC Mapping Workspace

Open **Inspector → PLC Mapping → Pop out ↗** to work in a wide PLC Mapping workspace. The workspace summary shows available signals, mapped addresses, and signals that still need a PLC address. The expanded table provides more room for node/address editing and live values while retaining the existing search, grouping, browse, validation, and force functions. Close the workspace to return to the Inspector; the mapping panel itself is moved, not duplicated, so its live state and controls are preserved.
## Latest UI fix

Dialogs opened from the PLC Mapping workspace (including **Import DB Tags** and **Select PLC Address**) are layered above the workspace so they remain visible and usable. If an older stylesheet is cached, reload the page once with a hard refresh.

## Rotary index table stations and parts

The 3D carousel uses the configured station count and follows the simulated index angle. Station fixtures are empty until a part is loaded. In Simulation mode, select the table and use **Load part** / **Unload part** to update the pocket at the transfer position. PLC mappings can use `load_part` and `unload_part` as pulse commands; `part_present` reports whether that pocket contains a part. Set the table's **Infeed Conveyor** and **Outfeed Conveyor** properties to connect conveyors. A cylinder targeting the index table can push a conveyor box into the station facing it, or push an occupied station's part onto the configured outfeed conveyor. Configure the cylinder so its extended rod reaches the transfer side; a conveyor box is added at the closest free slot on the outfeed belt.

For a simulated cylinder-fed infeed, set the index table's **Infeed Conveyor** property, set the cylinder's **Interacts With** target to the index table, then position the extended rod so it contacts a conveyor box at the table edge. When the cylinder completes an extension stroke, OMS transfers that box into the empty pocket facing the cylinder. For outfeed, set **Outfeed Conveyor** and use a cylinder on the discharge side; on its completed extension stroke, it transfers the occupied pocket facing the rod to the conveyor's nearest free slot. The table must be stopped and the cylinder/conveyor/table altitudes must align. Retract the cylinder before the next transfer. The handoff is modeled at the end of the stroke.



## Logic Editor workspace

The Logic Inspector tab now presents a compact launch card. Choose **Open Logic Editor** to edit simulation IF/THEN rules in a wide workspace. The workspace summarizes total rules, enabled rules, and readable I/O points while retaining the existing rule editor and validation workflow. The editor is for simulation logic and does not replace PLC safety logic.


### Logic Editor live monitor
The Logic Editor includes a live rule monitor for current source and destination values and condition status. Common IF-condition presets make rules quicker to configure. Edge conditions are labelled as runtime-evaluated because a single state snapshot cannot establish an edge event.

## 3D Machine View (foundation)
Use **3D Machine View** in the viewport toolbar to switch from the existing 2D layout to a 3D representation of the machine. The scene includes lighting, a floor/grid, orbit and zoom controls, and visual models for common machine components. Component placement and key simulation state (including conveyor product positions) are sourced from the existing scene state. Use **Reset camera** to restore the view. The current 3D foundation is a visualization layer, not yet a full physics-based digital twin; Three.js is loaded from a CDN when the view is opened, so network access is required.

## 3D machine view and simulation controls

The 3D view uses the same component state and Properties inspector as the 2D editor. Select a component in 3D to inspect its properties and live status; in Simulation mode the inspector exposes the existing virtual controls. Push buttons, emergency push buttons, and toggle switches can also be operated directly in the 3D scene. Live simulation state drives conveyor roller motion, motor rotation, cylinder extension, sensor indication, tower-light lamps, index-table movement, and fault/E-stop indicators. The 2D editor remains available as an alternative view.


### 3D layout editing (v11.22)
In Design mode, drag an already-placed component across the 3D floor to reposition it. Placement snaps to 10 layout units and commits the same X/Y properties used by the 2D editor. Select a component and use **Rotate selected 90°** in the 3D toolbar to rotate it through its existing `rotation_value` property. Camera orbit remains available by dragging empty space; scroll to zoom. The 3D geometry is still a lightweight procedural approximation, not a CAD-grade or physics-based digital twin.
