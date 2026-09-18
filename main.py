# main.py
"""Entry point for the OMS web prototype. Run with:  python main.py"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run("api.server:app", host="127.0.0.1", port=8000, reload=True)
