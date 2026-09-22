# main.py
"""Entry point for the OMS web prototype."""

import logging
import threading
import time
import webbrowser

import uvicorn


def open_browser():
    time.sleep(1.5)
    webbrowser.open("http://127.0.0.1:8000/")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    threading.Thread(target=open_browser, daemon=True).start()

    uvicorn.run(
        "api.server:app",
        host="127.0.0.1",
        port=8000,
        reload=False,
    )