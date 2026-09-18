# api/server.py
"""
FastAPI app entrypoint. Seeds a demo Scene with one conveyor (and one
cylinder, since that behavior is already ported too), starts the
background tick loop, and serves the web/ frontend as static files.

Run with:
    uvicorn api.server:app --reload
from the OMS_WEB project root.
"""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from core.scene import Scene
from api.websocket import router as websocket_router, tick_loop

# Single shared Scene instance for this prototype. A real multi-project
# setup would create/load one per session or per open project instead.
scene = Scene()

# Holds the single live PlcSyncBase subclass instance while connected,
# or None -- the web equivalent of sim_view.plc_sync /
# sim_view.selected_plc_backend in the original desktop app. Read/set
# by api/websocket.py's plc_connect/plc_disconnect actions.
plc_sync = None
selected_plc_backend = None
_last_connect_error = None

# Seeded via create_component() (not scene.add() directly) so the
# auto-naming counter used for dock-dragged components stays in sync --
# otherwise the first dragged conveyor would collide with "Conveyor_1".

@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(tick_loop(scene))
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan)
app.include_router(websocket_router)

# Serves web/index.html, app.js, styles.css at the site root.
app.mount("/", StaticFiles(directory="web", html=True), name="web")
