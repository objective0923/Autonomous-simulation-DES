"""HTTP contract tests run real SimPy calculations through the FastAPI app."""
from fastapi.testclient import TestClient
import pytest
import simpy

from backend.app import app, slots
from backend.tests.test_engine import reference_project


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_health_identifies_the_simpy_backend(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["engine"] == "SimPy"
    assert response.json()["simpyVersion"] == simpy.__version__


def test_simulate_returns_the_analytical_result_and_trace(client):
    response = client.post("/api/simulate", json={"project": reference_project()})
    assert response.status_code == 200
    result = response.json()
    assert result["engineName"] == "Python SimPy"
    assert result["horizon"] == 30
    assert result["kpis"]["transportCompleted"] == 1
    assert result["finalState"]["jobs"][0]["completedAt"] == pytest.approx(12)
    assert result["history"][-1]["finished"] is True
    assert any(event["kind"] == "transport.completed" for event in result["events"])
    assert client.post("/api/simulate", json={"project": reference_project()}).json() == result


@pytest.mark.parametrize("payload", [{}, {"project": []}, {"project": None}, {"project": {}},
                                      {"project": reference_project(), "extra": True}])
def test_invalid_request_is_422_instead_of_an_internal_error(client, payload):
    response = client.post("/api/simulate", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"]


def test_invalid_project_reference_is_422_and_does_not_poison_the_next_run(client):
    project = reference_project()
    project["transportRules"][0]["destinationBufferId"] = "missing"
    response = client.post("/api/simulate", json={"project": project})
    assert response.status_code == 422
    assert "MISSING_REFERENCE" in str(response.json()["detail"])
    assert client.post("/api/simulate", json={"project": reference_project()}).status_code == 200


@pytest.mark.parametrize("field,value", [("loadedSpeed", -1), ("loadedSpeed", "2"), ("maxUnits", True)])
def test_invalid_physical_spec_is_rejected_before_running(client, field, value):
    project = reference_project()
    project["robotTypes"][0][field] = value
    response = client.post("/api/simulate", json={"project": project})
    assert response.status_code == 422
    assert "NUMBER_RANGE" in str(response.json()["detail"])


def test_negative_inventory_and_infeasible_payload_are_422(client):
    project = reference_project()
    project["buffers"][0]["initialInventory"]["part"] = -1
    assert client.post("/api/simulate", json={"project": project}).status_code == 422
    project = reference_project()
    project["transportRules"][0]["unitWeightKg"] = 101
    response = client.post("/api/simulate", json={"project": project})
    assert response.status_code == 422
    assert "NO_CAPABLE_ROBOT" in str(response.json()["detail"])


def test_malformed_json_is_422(client):
    response = client.post("/api/simulate", content="{", headers={"content-type": "application/json"})
    assert response.status_code == 422


def test_overloaded_compute_slots_return_503_then_recover(client):
    assert slots.acquire(blocking=False)
    assert slots.acquire(blocking=False)
    try:
        response = client.post("/api/simulate", json={"project": reference_project()})
        assert response.status_code == 503
        assert response.json()["detail"]
    finally:
        slots.release()
        slots.release()
    assert client.post("/api/simulate", json={"project": reference_project()}).status_code == 200


def test_runtime_model_exception_returns_diagnosed_trace_for_investigation(client):
    project = reference_project()
    project["transportRules"] = []
    project["robotTypes"][0]["idlePowerW"] = 3600
    project["robots"][0]["initialBatteryWh"] = .5
    project["settings"]["duration"] = 2
    response = client.post("/api/simulate", json={"project": project})
    assert response.status_code == 200
    result = response.json()
    assert any(issue["code"] == "BATTERY_EXHAUSTED" and issue["severity"] == "error" for issue in result["diagnostics"])
    assert result["finalState"]["robots"][0]["batteryWh"] == 0
    assert result["events"] and result["history"]
