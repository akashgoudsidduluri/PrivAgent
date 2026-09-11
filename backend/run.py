#!/usr/bin/env python3
"""
PrivAgent Backend — Launch Script.

Starts the Agent Safety API on localhost only (127.0.0.1:8010).
This is a local IPC bridge — it is never exposed to the public internet.

Usage:
    python backend/run.py
"""
import sys
import os

# Ensure the project root is on the path so `backend.app` resolves correctly
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn

if __name__ == "__main__":
    print("[PrivAgent] Starting Agent Safety API on http://127.0.0.1:8010")
    print("[PrivAgent] Docs available at: http://127.0.0.1:8010/docs")
    print("[PrivAgent] Press Ctrl+C to stop.\n")
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8010,
        reload=True,
        log_level="info",
    )
