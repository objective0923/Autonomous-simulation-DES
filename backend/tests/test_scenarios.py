"""Local customer/scenario persistence through real HTTP and SQLite."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

from fastapi.testclient import TestClient
import pytest

from backend.app import app
from backend.engine import SimulationEngine
from backend import scenarios
from backend.tests.test_engine import reference_project


@pytest.fixture
def store(tmp_path, monkeypatch):
    directory = tmp_path / "customer projects with spaces"
    monkeypatch.setenv("CROIS_DATA_DIR", str(directory))
    return directory


@pytest.fixture
def client(store):
    with TestClient(app) as client:
        yield client


def payload(identifier="scenario-1", customer="  CROIS 고객  ", name="  기준 시나리오  "):
    project = reference_project()
    project["id"] = identifier
    return {"customerName": customer, "name": name, "project": project}


def create(client, **kwargs):
    response = client.post("/api/scenarios", json=payload(**kwargs))
    assert response.status_code == 201, response.text
    return response.json()


def test_customer_and_name_are_enough_to_persist_and_reopen_complete_inputs(client, store):
    assert client.get("/api/scenarios").json() == {"scenarios": []}
    saved = create(client)
    assert saved["id"] == "scenario-1"
    assert saved["customerName"] == "CROIS 고객"
    assert saved["name"] == "기준 시나리오"
    assert saved["project"]["customerName"] == saved["customerName"]
    assert saved["project"]["name"] == saved["name"]
    assert saved["createdAt"].endswith("Z")
    assert saved["lastRunAt"] is None and saved["result"] is None and not saved["hasResult"]
    assert (store / "scenarios.sqlite3").is_file()
    # A separate HTTP session and SQLite connection see the same durable input.
    with TestClient(app) as reopened:
        assert reopened.get("/api/scenarios/scenario-1").json() == saved
    listed = client.get("/api/scenarios").json()["scenarios"]
    assert listed == [{key: value for key, value in saved.items() if key not in ("project", "result")}]


def test_same_name_is_allowed_for_different_customers(client):
    create(client, identifier="one", customer="고객 A", name="기준")
    create(client, identifier="two", customer="고객 B", name="기준")
    summaries = client.get("/api/scenarios").json()["scenarios"]
    assert {(s["customerName"], s["name"]) for s in summaries} == {("고객 A", "기준"), ("고객 B", "기준")}


def test_whitespace_casefold_duplicates_and_reused_ids_are_409(client):
    create(client, customer="Factory A", name="Baseline")
    duplicate = payload(identifier="another-id", customer="  FACTORY A ", name=" baseline ")
    assert client.post("/api/scenarios", json=duplicate).status_code == 409
    assert client.post("/api/scenarios", json=payload(customer="other", name="other")).status_code == 409
    assert len(client.get("/api/scenarios").json()["scenarios"]) == 1


@pytest.mark.parametrize("key,value", [("customerName", ""), ("customerName", "   "), ("name", ""),
                                      ("name", "x" * 121), ("customerName", 123), ("name", "bad\nname")])
def test_customer_and_scenario_names_are_validated_without_creating_records(client, key, value):
    body = payload(); body[key] = value
    assert client.post("/api/scenarios", json=body).status_code == 422
    assert client.get("/api/scenarios").json()["scenarios"] == []


def test_invalid_project_is_rejected_before_storage_and_does_not_corrupt_next_create(client):
    body = payload(); body["project"]["transportRules"][0]["destinationBufferId"] = "missing"
    assert client.post("/api/scenarios", json=body).status_code == 422
    assert client.get("/api/scenarios").json()["scenarios"] == []
    assert create(client)["id"] == "scenario-1"


@pytest.mark.parametrize("identifier", ["part/hidden", "part\\hidden", "with space", "줄바꿈\nid", "고객-id", "x" * 129, ""])
def test_non_routable_ids_cannot_create_unreachable_saved_records(client, identifier):
    response = client.post("/api/scenarios", json=payload(identifier=identifier))
    assert response.status_code == 422
    assert "시나리오 ID" in response.json()["detail"]
    assert client.get("/api/scenarios").json()["scenarios"] == []


def test_url_safe_punctuation_id_reopens_normally(client):
    saved = create(client, identifier="factory_1.baseline:2026-01")
    assert client.get("/api/scenarios/factory_1.baseline:2026-01").json() == saved


def test_normal_simulate_automatically_saves_latest_result_for_exact_saved_input(client):
    saved = create(client)
    result = client.post("/api/simulate", json={"project": saved["project"]})
    assert result.status_code == 200
    detail = client.get("/api/scenarios/scenario-1").json()
    assert detail["result"] == result.json()
    assert detail["result"]["kpis"]["transportCompleted"] == 1
    assert detail["hasResult"] and detail["lastRunAt"].endswith("Z")
    assert client.get("/api/scenarios").json()["scenarios"][0]["hasResult"]
    # Saving identical inputs preserves the result and timestamp, including after reconnect.
    same = {"customerName": saved["customerName"], "name": saved["name"], "project": saved["project"]}
    response = client.put("/api/scenarios/scenario-1", json=same)
    assert response.status_code == 200
    assert response.json() == detail


def test_changed_input_clears_outdated_result_and_late_compute_cannot_restore_it(client):
    saved = create(client)
    original_result = SimulationEngine(saved["project"]).run()
    assert scenarios.save_result_if_current(saved["project"], original_result)
    revised = deepcopy(saved["project"]); revised["settings"]["seed"] += 1
    response = client.put("/api/scenarios/scenario-1", json={"customerName": saved["customerName"], "name": saved["name"], "project": revised})
    assert response.status_code == 200
    updated = response.json()
    assert updated["result"] is None and updated["lastRunAt"] is None and not updated["hasResult"]
    assert not scenarios.save_result_if_current(saved["project"], original_result)
    assert client.get("/api/scenarios/scenario-1").json() == updated
    revised_result = client.post("/api/simulate", json={"project": revised}).json()
    assert client.get("/api/scenarios/scenario-1").json()["result"] == revised_result


def test_rename_between_customers_and_conflict_rollback_preserve_records(client):
    first = create(client, identifier="first", customer="A", name="Baseline")
    second = create(client, identifier="second", customer="B", name="Baseline")
    conflict = {"customerName": "B", "name": "BASELINE", "project": first["project"]}
    assert client.put("/api/scenarios/first", json=conflict).status_code == 409
    assert client.get("/api/scenarios/first").json() == first
    assert client.get("/api/scenarios/second").json() == second
    renamed = client.put("/api/scenarios/first", json={"customerName": "고객 C", "name": "신규 계획", "project": first["project"]})
    assert renamed.status_code == 200
    assert renamed.json()["id"] == first["id"]
    assert renamed.json()["project"]["name"] == "신규 계획"


def test_ids_are_immutable_and_missing_records_are_404(client):
    saved = create(client)
    body = payload(identifier="changed-id")
    assert client.put("/api/scenarios/scenario-1", json=body).status_code == 422
    body["project"]["id"] = "not-found"
    assert client.put("/api/scenarios/not-found", json=body).status_code == 404
    assert client.get("/api/scenarios/not-found").status_code == 404
    assert client.delete("/api/scenarios/not-found").status_code == 404
    assert client.get("/api/scenarios/scenario-1").json() == saved


def test_delete_removes_only_selected_scenario_and_a_late_result_cannot_recreate_it(client):
    deleted = create(client, identifier="delete-me", customer="A", name="one")
    retained = create(client, identifier="keep-me", customer="A", name="two")
    assert client.delete("/api/scenarios/delete-me").status_code == 204
    assert client.get("/api/scenarios/delete-me").status_code == 404
    assert client.get("/api/scenarios/keep-me").json() == retained
    assert not scenarios.save_result_if_current(deleted["project"], SimulationEngine(deleted["project"]).run())
    assert [x["id"] for x in client.get("/api/scenarios").json()["scenarios"]] == ["keep-me"]


def test_unsaved_headless_project_does_not_create_a_database(store):
    project = reference_project()
    assert not scenarios.save_result_if_current(project, SimulationEngine(project).run())
    assert not store.exists()


def test_mismatched_result_identity_is_not_persisted(client):
    saved = create(client)
    result = SimulationEngine(saved["project"]).run()
    result["projectId"] = "another-id"
    assert not scenarios.save_result_if_current(saved["project"], result)
    assert client.get("/api/scenarios/scenario-1").json()["result"] is None


def test_concurrent_creates_use_sqlite_unique_constraint_without_duplicate_rows(store):
    def attempt(number):
        try:
            scenarios.create_scenario("one customer", "same name", payload(identifier=f"id-{number}")["project"])
            return "saved"
        except scenarios.ScenarioConflict:
            return "duplicate"
    with ThreadPoolExecutor(max_workers=4) as pool:
        outcomes = list(pool.map(attempt, range(4)))
    assert outcomes.count("saved") == 1 and outcomes.count("duplicate") == 3
    assert len(scenarios.list_scenarios()) == 1


def test_unavailable_local_storage_is_reported_as_503(client, store):
    store.mkdir(parents=True)
    # A directory in the database's position is a platform-independent I/O failure.
    (store / "scenarios.sqlite3").mkdir()
    response = client.get("/api/scenarios")
    assert response.status_code == 503
    assert "저장소" in response.json()["detail"]


def test_result_write_failure_is_reported_and_releases_compute_slot(client, monkeypatch):
    saved = create(client)
    with monkeypatch.context() as patch:
        def unavailable(*_args):
            raise OSError("disk unavailable")
        patch.setattr(scenarios, "save_result_if_current", unavailable)
        response = client.post("/api/simulate", json={"project": saved["project"]})
        assert response.status_code == 503
        assert "계산은 완료되었지만" in response.json()["detail"]
        assert "저장하지 못했습니다" in response.json()["detail"]
    assert client.get("/api/scenarios/scenario-1").json()["result"] is None
    response = client.post("/api/simulate", json={"project": saved["project"]})
    assert response.status_code == 200
    assert client.get("/api/scenarios/scenario-1").json()["result"] == response.json()
