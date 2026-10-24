"""Local development API. SimPy owns all simulation state and metrics."""
from __future__ import annotations

from pathlib import Path
import threading

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict
import simpy

from .engine import ENGINE_VERSION, SimulationEngine

app = FastAPI(title="CROIS SimPy DES", version="0.2.0")
slots = threading.BoundedSemaphore(2)


class SimulationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project: dict


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "engine": "SimPy", "simpyVersion": simpy.__version__, "engineVersion": ENGINE_VERSION}


@app.post("/api/simulate")
def simulate(request: SimulationRequest) -> dict:
    if not slots.acquire(blocking=False):
        raise HTTPException(503, "다른 시뮬레이션이 계산 중입니다. 잠시 후 다시 실행하세요.")
    try:
        result = SimulationEngine(request.project).run()
        if result.get("diagnostics") and any(d.get("severity") == "error" for d in result["diagnostics"]):
            # Return the trace, including diagnosed model exceptions, for investigation.
            return result
        return result
    except (ValueError, KeyError, TypeError, OverflowError) as error:
        raise HTTPException(422, str(error)) from error
    finally:
        slots.release()


ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
if DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def web_index() -> FileResponse:
        return FileResponse(DIST / "index.html")
