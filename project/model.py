"""Project and session models.

A Project owns the editable simulation state.  A ProjectSession adds the
connection-specific runtime state needed by one browser/WebSocket client.
Keeping these objects separate prevents one browser window from changing
another window's scene or PLC connection.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from core.scene import Scene


@dataclass
class Project:
    scene: Scene = field(default_factory=Scene)
    name: str = "Untitled"
    version: int = 7
    metadata: dict = field(default_factory=dict)

    def reset(self) -> None:
        self.scene.reset_simulation_state()


@dataclass
class ProjectSession:
    project: Project = field(default_factory=Project)
    mode: str = "design"
    plc_sync: object | None = None
    selected_plc_backend: str | None = None
    last_connect_error: str | None = None

    @property
    def scene(self) -> Scene:
        return self.project.scene

    def close(self) -> None:
        if self.plc_sync is not None:
            try:
                self.plc_sync.close_connection()
            finally:
                self.plc_sync = None
