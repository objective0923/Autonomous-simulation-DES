"""Local development API. SimPy owns all simulation state and metrics."""
from __future__ import annotations

from pathlib import Path
import threading
import sqlite3

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict
import simpy

from .engine import ENGINE_VERSION, SimulationEngine
from . import scenarios

app = FastAPI(title="CROIS SimPy DES", version="0.2.0")
slots = threading.BoundedSemaphore(2)


class SimulationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project: dict


class ScenarioRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    customerName: str
    name: str
    project: dict


def scenario_operation(operation, *args):
    try:
        return operation(*args)
    except scenarios.ScenarioNotFound as error:
        raise HTTPException(404, str(error)) from error
    except scenarios.ScenarioConflict as error:
        raise HTTPException(409, str(error)) from error
    except (ValueError, KeyError, TypeError, OverflowError) as error:
        raise HTTPException(422, str(error)) from error
    except (sqlite3.Error, OSError) as error:
        raise HTTPException(503, "이 PC의 시나리오 저장소를 사용할 수 없습니다. 저장 폴더 권한과 디스크 상태를 확인하세요.") from error


@app.get("/api/scenarios")
def scenario_list() -> dict:
    return {"scenarios": scenario_operation(scenarios.list_scenarios)}


@app.post("/api/scenarios", status_code=201)
def scenario_create(request: ScenarioRequest) -> dict:
    return scenario_operation(scenarios.create_scenario, request.customerName, request.name, request.project)


@app.get("/api/scenarios/{identifier}")
def scenario_get(identifier: str) -> dict:
    return scenario_operation(scenarios.get_scenario, identifier)


@app.put("/api/scenarios/{identifier}")
def scenario_update(identifier: str, request: ScenarioRequest) -> dict:
    return scenario_operation(scenarios.update_scenario, identifier, request.customerName, request.name, request.project)


@app.delete("/api/scenarios/{identifier}", status_code=204)
def scenario_delete(identifier: str) -> Response:
    scenario_operation(scenarios.delete_scenario, identifier)
    return Response(status_code=204)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "engine": "SimPy", "simpyVersion": simpy.__version__, "engineVersion": ENGINE_VERSION}


@app.post("/api/simulate")
def simulate(request: SimulationRequest) -> dict:
    if not slots.acquire(blocking=False):
        raise HTTPException(503, "다른 시뮬레이션이 계산 중입니다. 잠시 후 다시 실행하세요.")
    try:
        result = SimulationEngine(request.project).run()
        try:
            scenarios.save_result_if_current(request.project, result)
        except (sqlite3.Error, OSError) as error:
            raise HTTPException(503, "계산은 완료되었지만 결과를 저장하지 못했습니다. 이 PC의 저장 폴더 권한과 디스크 상태를 확인하고 다시 실행하세요.") from error
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
