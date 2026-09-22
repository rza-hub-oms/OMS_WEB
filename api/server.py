"""FastAPI application entry point for OMS Web."""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from api.websocket import router as websocket_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="OMS Web", version="2.0")
app.include_router(websocket_router)
app.mount("/", StaticFiles(directory="web", html=True), name="web")
