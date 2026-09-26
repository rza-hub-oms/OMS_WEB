# OMS Web

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

`.oms` files are JSON documents. Current project format version is **6**. Older project files are migrated in memory when opened.

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
persisted in `.oms` projects. The registry is the common data contract for
future alarms, trends, Runtime and richer PLC mapping.
