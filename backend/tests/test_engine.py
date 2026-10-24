"""Independent physical and state-invariant checks for the authoritative SimPy DES.

Reference values use SI units. Fixtures do not depend on browser calculation code.
"""
from copy import deepcopy
import json
import math
from pathlib import Path

import pytest
import simpy

from backend.engine import SimulationEngine
from backend.models import validate_project


ROOT = Path(__file__).resolve().parents[2]


def reference_project():
    """One good, one robot, 10 m, 2 m/s, 1 m/s², 2 s load, 3 s unload."""
    return {
        "schemaVersion": "1.0", "id": "reference", "name": "Reference transport",
        "description": "Independent analytical test assumptions", "modelVersion": "test-1", "assumptions": [],
        "nodes": [
            {"id": "source", "name": "Source", "x": 0, "y": 0, "kind": "pickup"},
            {"id": "destination", "name": "Destination", "x": 10, "y": 0, "kind": "dropoff"},
        ],
        "edges": [{"id": "corridor", "from": "source", "to": "destination", "length": 10,
                   "width": 2, "speedLimit": 2, "bidirectional": True}],
        "objects": [],
        "buffers": [
            {"id": "source-buffer", "name": "Source stock", "nodeId": "source", "capacity": 10, "initialInventory": {"part": 1}},
            {"id": "destination-buffer", "name": "Destination stock", "nodeId": "destination", "capacity": 10, "initialInventory": {}},
        ],
        "robotTypes": [{
            "id": "amr", "name": "Reference AMR", "width": .5, "length": .8,
            "maxPayloadKg": 100, "maxUnits": 10, "cargoTypes": ["part", "A", "B"],
            "emptySpeed": 2, "loadedSpeed": 2, "acceleration": 1, "turnTime": 0,
            "loadTime": 2, "unloadTime": 3, "batteryCapacityWh": 100,
            "idlePowerW": 0, "emptyPowerW": 0, "loadedPowerW": 0,
            "reserveWh": 0, "chargeBelowWh": 0, "chargeToWh": 100,
        }],
        "robots": [{"id": "r1", "name": "Robot 1", "typeId": "amr", "nodeId": "source", "initialBatteryWh": 100}],
        "chargers": [], "processes": [], "equipment": [], "disruptions": [],
        "transportRules": [{"id": "delivery", "name": "Deliver part", "sourceBufferId": "source-buffer",
                            "destinationBufferId": "destination-buffer", "product": "part", "quantity": 1,
                            "unitWeightKg": 1, "priority": 1}],
        "settings": {"duration": 30, "seed": 1234, "warmup": 0, "dispatchPolicy": "fifo"},
    }


def example(name="demo"):
    return json.loads((ROOT / "examples" / f"{name}.json").read_text())


def inventory(snapshot, product):
    return sum(buffer["inventory"].get(product, 0) for buffer in snapshot["buffers"]) + sum(
        robot.get("carrying", {}).get("quantity", 0)
        for robot in snapshot["robots"] if robot.get("carrying", {}).get("product") == product
    )


def resource_bounds(project, snapshot):
    specs = {buffer["id"]: buffer for buffer in project["buffers"]}
    for buffer in snapshot["buffers"]:
        values = list(buffer["inventory"].values()) + list(buffer["reservedOut"].values()) + [buffer["reservedIn"]]
        assert all(math.isfinite(value) and value >= -1e-8 for value in values)
        assert sum(buffer["inventory"].values()) + buffer["reservedIn"] <= specs[buffer["id"]]["capacity"] + 1e-8
        for product, reserved in buffer["reservedOut"].items():
            assert reserved <= buffer["inventory"].get(product, 0) + 1e-8
    robot_specs = {robot["id"]: robot for robot in project["robots"]}
    type_specs = {kind["id"]: kind for kind in project["robotTypes"]}
    for robot in snapshot["robots"]:
        assert math.isfinite(robot["batteryWh"])
        assert 0 <= robot["batteryWh"] <= type_specs[robot_specs[robot["id"]]["typeId"]]["batteryCapacityWh"]
    charger_specs = {charger["id"]: charger for charger in project["chargers"]}
    for charger in snapshot["chargers"]:
        spec = charger_specs[charger["id"]]
        assert len(charger["occupants"]) <= spec["capacity"]
        assert len(charger["queue"]) <= spec["waitingCapacity"]
        assert len(set(charger["occupants"] + charger["queue"])) == len(charger["occupants"]) + len(charger["queue"])
    active = [job for job in snapshot["jobs"] if job["status"] in ("assigned", "loading", "transporting", "unloading")]
    assert len({job.get("robotId") for job in active}) == len(active), "one active job per robot"
    for job in active:
        assert job.get("robotId")
        assert next(robot for robot in snapshot["robots"] if robot["id"] == job["robotId"]).get("jobId") == job["id"]


def process_spec(**changes):
    spec = {"id": "producer", "name": "Producer", "nodeId": "destination", "inputRequirements": {},
            "outputBufferId": "destination-buffer", "outputProduct": "part", "outputQuantity": 1,
            "processingTime": {"kind": "fixed", "value": 5}, "isFinal": True}
    spec.update(changes)
    return spec


def test_uses_a_real_simpy_environment_and_hand_calculated_transport():
    engine = SimulationEngine(reference_project())
    assert isinstance(engine.env, simpy.Environment)
    result = engine.run()
    assert engine.env.now == 30
    assert result["engineName"] == "Python SimPy"
    assert result["kpis"]["transportCompleted"] == 1
    assert result["kpis"]["productionCompleted"] == 0
    # Acceleration 2 s/2 m + cruise 3 s/6 m + deceleration 2 s/2 m.
    # Loading 2 s + travel 7 s + unloading 3 s = 12 s.
    assert result["finalState"]["jobs"][0]["completedAt"] == pytest.approx(12)
    assert result["finalState"]["robots"][0]["distanceLoaded"] == pytest.approx(10)
    assert result["finalState"]["robots"][0]["distanceEmpty"] == 0
    assert result["kpis"]["meanLeadTime"] == pytest.approx(12)
    assert result["finalState"]["buffers"][1]["inventory"]["part"] == 1


def test_native_simpy_processes_can_share_the_authoritative_clock():
    project = reference_project()
    engine = SimulationEngine(project)
    observations = []

    def observer():
        yield engine.env.timeout(4)
        observations.append(engine.env.now)
        yield engine.env.timeout(3)
        observations.append(engine.env.now)

    engine.env.process(observer())
    result = engine.run()
    assert observations == [4, 7]
    assert engine.env.now == result["horizon"] == 30
    assert result == SimulationEngine(project).run()


def test_reproducible_same_input_seed_and_unmodified_input():
    project = example()
    project["settings"]["duration"] = 600
    original = deepcopy(project)
    first = SimulationEngine(project).run()
    second = SimulationEngine(project).run()
    assert len(first["events"]) > 10
    assert second == first
    assert project == original


@pytest.mark.parametrize("frame_seconds", [1, 17, 10000])
def test_playback_frame_intervals_preserve_entire_result_including_history(frame_seconds):
    project = example()
    project["settings"].update(duration=600, warmup=31.5)
    headless = SimulationEngine(project).run()
    framed = SimulationEngine(project)
    for target in range(frame_seconds, 600, frame_seconds):
        framed.run_until(target)
    framed.run_until(600)
    assert framed.get_result() == headless


def test_step_and_headless_results_match_with_resource_bounds_at_each_step():
    project = example()
    project["settings"]["duration"] = 600
    headless = SimulationEngine(project).run()
    engine = SimulationEngine(project)
    previous_time = 0
    for _ in range(100000):
        snapshot = engine.step()
        assert snapshot["time"] >= previous_time
        previous_time = snapshot["time"]
        resource_bounds(project, snapshot)
        if snapshot["finished"]:
            break
    else:
        pytest.fail("event stepping did not finish")
    assert engine.get_result() == headless


def test_power_is_integrated_in_watt_hours():
    project = reference_project()
    project["settings"]["duration"] = 12
    project["robotTypes"][0].update(idlePowerW=360, loadedPowerW=720)
    result = SimulationEngine(project).run()
    # 5 s loading/unloading × .1 Wh/s + 7 s travel × .2 Wh/s = 1.9 Wh.
    assert result["finalState"]["robots"][0]["batteryWh"] == pytest.approx(98.1)


def test_finite_goods_reservations_and_single_assignment_at_each_recorded_event():
    project = reference_project()
    project["buffers"][0]["initialInventory"]["part"] = 7
    project["buffers"][1]["capacity"] = 3
    project["robots"].append({"id": "r2", "name": "Robot 2", "typeId": "amr", "nodeId": "source", "initialBatteryWh": 100})
    project["settings"]["duration"] = 120
    result = SimulationEngine(project).run()
    assert len(result["history"]) > 5
    for snapshot in result["history"]:
        resource_bounds(project, snapshot)
        assert inventory(snapshot, "part") == 7
    assert result["kpis"]["transportCompleted"] == 3
    assert result["finalState"]["buffers"][1]["inventory"]["part"] == 3


def test_snapshots_are_detached_and_replications_reset_initial_state():
    project = reference_project()
    engine = SimulationEngine(project)
    snapshot = engine.get_snapshot()
    snapshot["robots"][0]["batteryWh"] = -999
    snapshot["buffers"][0]["inventory"]["part"] = 999
    assert engine.get_snapshot()["robots"][0]["batteryWh"] == 100
    assert engine.get_snapshot()["buffers"][0]["inventory"]["part"] == 1
    first = engine.run()
    fresh = SimulationEngine(project)
    assert fresh.get_snapshot()["time"] == 0
    assert fresh.get_snapshot()["robots"][0]["distanceLoaded"] == 0
    assert fresh.run() == first


def test_changing_seed_changes_stochastic_process_completion_times():
    project = example()
    project["settings"]["duration"] = 600
    changed = deepcopy(project)
    changed["settings"]["seed"] += 1
    times = lambda result: [event["time"] for event in result["events"] if event["kind"] == "process.completed"]
    first = times(SimulationEngine(project).run())
    assert len(first) > 3
    assert times(SimulationEngine(changed).run()) != first


def test_two_opposing_directed_edges_share_physical_corridor_occupancy():
    project = reference_project()
    project["edges"][0]["bidirectional"] = False
    project["edges"].append({**project["edges"][0], "id": "reverse", "from": "destination", "to": "source"})
    project["buffers"] = [
        {"id": "a-source", "name": "A source", "nodeId": "source", "capacity": 2, "initialInventory": {"A": 1}},
        {"id": "a-destination", "name": "A destination", "nodeId": "destination", "capacity": 2, "initialInventory": {}},
        {"id": "b-source", "name": "B source", "nodeId": "destination", "capacity": 2, "initialInventory": {"B": 1}},
        {"id": "b-destination", "name": "B destination", "nodeId": "source", "capacity": 2, "initialInventory": {}},
    ]
    project["robots"].append({"id": "r2", "name": "Robot 2", "typeId": "amr", "nodeId": "destination", "initialBatteryWh": 100})
    project["transportRules"] = [
        {"id": "a", "name": "A eastbound", "sourceBufferId": "a-source", "destinationBufferId": "a-destination", "product": "A", "quantity": 1, "unitWeightKg": 1, "priority": 1},
        {"id": "b", "name": "B westbound", "sourceBufferId": "b-source", "destinationBufferId": "b-destination", "product": "B", "quantity": 1, "unitWeightKg": 1, "priority": 1},
    ]
    result = SimulationEngine(project).run()
    assert result["kpis"]["transportCompleted"] == 2
    observed_movement = observed_waiting = False
    for snapshot in result["history"]:
        resource_bounds(project, snapshot)
        moving = [r for r in snapshot["robots"] if r.get("movement") and r["status"] in ("loadedTravel", "emptyTravel")
                  and r["movement"]["startedAt"] <= snapshot["time"] < r["movement"]["endsAt"]]
        assert len(moving) <= 1, f"opposing corridor entry at {snapshot['time']}"
        observed_movement |= bool(moving)
        observed_waiting |= any(r["status"] == "trafficWait" for r in snapshot["robots"])
        assert inventory(snapshot, "A") == inventory(snapshot, "B") == 1
    assert observed_movement and observed_waiting


def test_wildcard_cargo_is_supported_but_overweight_work_is_diagnosed_before_dispatch():
    project = reference_project()
    project["robotTypes"][0]["cargoTypes"] = ["*"]
    assert SimulationEngine(project).run()["kpis"]["transportCompleted"] == 1
    project["transportRules"][0]["unitWeightKg"] = 101
    assert any(issue["code"] == "NO_CAPABLE_ROBOT" for issue in validate_project(project))
    with pytest.raises(ValueError, match="NO_CAPABLE_ROBOT"):
        SimulationEngine(project)
    assert project["buffers"][0]["initialInventory"]["part"] == 1


def test_charger_and_waiting_slot_capacity_with_three_robots():
    project = reference_project()
    project["transportRules"] = []
    project["robotTypes"][0].update(batteryCapacityWh=10, chargeBelowWh=5, chargeToWh=10)
    project["robots"] = [{"id": f"r{i}", "name": f"Robot {i}", "typeId": "amr", "nodeId": "source", "initialBatteryWh": 1} for i in range(1, 4)]
    project["chargers"] = [{"id": "charger", "name": "Shared charger", "nodeId": "source", "capacity": 1,
                            "waitingCapacity": 1, "powerW": 3600, "compatibleTypes": ["amr"], "dockTime": 1, "undockTime": 1}]
    project["settings"]["duration"] = 40
    result = SimulationEngine(project).run()
    for snapshot in result["history"]:
        resource_bounds(project, snapshot)
    assert result["kpis"]["maxChargeQueue"] == 1
    for robot in result["finalState"]["robots"]:
        assert robot["batteryWh"] == pytest.approx(10)
        assert result["kpis"]["robotStateSeconds"][robot["id"]]["charging"] == pytest.approx(9)
    assert 0 < result["kpis"]["chargerUtilization"]["charger"] <= 1


def test_battery_energy_is_clamped_and_exhaustion_diagnosed():
    project = reference_project()
    project["transportRules"] = []
    project["robotTypes"][0]["idlePowerW"] = 3600
    project["robots"][0]["initialBatteryWh"] = .5
    project["settings"]["duration"] = 2
    result = SimulationEngine(project).run()
    assert result["finalState"]["robots"][0]["batteryWh"] == 0
    assert result["finalState"]["robots"][0]["status"] == "failed"
    assert any(issue["code"] == "BATTERY_EXHAUSTED" for issue in result["diagnostics"])
    for snapshot in result["history"]:
        resource_bounds(project, snapshot)


def test_assembly_does_not_consume_partial_material_when_another_component_is_missing():
    project = reference_project()
    project["robots"] = []
    project["transportRules"] = []
    project["buffers"][0]["initialInventory"] = {"A": 2}
    project["processes"] = [process_spec(id="assembly", inputBufferId="source-buffer", inputRequirements={"A": 2, "B": 1})]
    result = SimulationEngine(project).run()
    assert result["kpis"]["productionCompleted"] == 0
    assert result["finalState"]["processes"][0]["status"] == "materialWait"
    assert result["finalState"]["buffers"][0]["inventory"]["A"] == 2
    assert result["kpis"]["processStateSeconds"]["assembly"]["materialWait"] == pytest.approx(30)


def test_assembly_resumes_only_after_delivery_of_the_missing_material():
    result = SimulationEngine(example("materialStarvation")).run()
    delivered = next(job for job in result["finalState"]["jobs"] if job["status"] == "completed")
    assembled = next(event for event in result["events"] if event["kind"] == "process.completed")
    assert assembled["time"] == pytest.approx(delivered["completedAt"] + 5)
    assert result["kpis"]["productionCompleted"] == 1
    assert result["kpis"]["processStateSeconds"]["p-assembly"]["materialWait"] > 0
    final_stock = {buffer["id"]: buffer["inventory"] for buffer in result["finalState"]["buffers"]}
    assert final_stock["b-final"]["F"] == 1
    assert final_stock["b-right"]["A"] == final_stock["b-right"]["B"] == 0


def test_full_output_buffer_stops_production_and_accounts_for_wait_time():
    project = reference_project()
    project["robots"] = []
    project["transportRules"] = []
    project["buffers"][1]["capacity"] = 1
    project["processes"] = [process_spec()]
    result = SimulationEngine(project).run()
    assert result["kpis"]["productionCompleted"] == 1
    assert result["finalState"]["processes"][0]["produced"] == 1
    assert result["finalState"]["buffers"][1]["inventory"]["part"] == 1
    assert result["kpis"]["processStateSeconds"]["producer"]["outputWait"] == pytest.approx(25)
    for snapshot in result["history"]:
        resource_bounds(project, snapshot)


def test_zero_component_requirement_does_not_introduce_nan_inventory():
    project = reference_project()
    project["robots"] = []
    project["transportRules"] = []
    project["buffers"][0]["initialInventory"] = {}
    project["buffers"][1]["capacity"] = 1
    project["processes"] = [process_spec(inputBufferId="source-buffer", inputRequirements={"A": 0})]
    result = SimulationEngine(project).run()
    assert result["kpis"]["productionCompleted"] == 1
    for snapshot in result["history"]:
        assert snapshot["buffers"][0]["inventory"].get("A", 0) == 0
        resource_bounds(project, snapshot)


def test_single_shared_worker_serializes_processes_and_releases_the_waiter():
    project = reference_project()
    project["robots"] = []
    project["transportRules"] = []
    for buffer in project["buffers"]:
        buffer.update(capacity=1, initialInventory={})
    project["equipment"] = [{"id": "worker", "name": "One worker", "capacity": 1}]
    project["processes"] = [process_spec(id=f"p{i}", nodeId=buffer["nodeId"], outputBufferId=buffer["id"], workerResourceId="worker")
                            for i, buffer in enumerate(project["buffers"])]
    project["settings"]["duration"] = 11
    result = SimulationEngine(project).run()
    assert [event["time"] for event in result["events"] if event["kind"] == "process.completed"] == [5, 10]
    assert result["kpis"]["productionCompleted"] == 2
    assert result["kpis"]["processStateSeconds"]["p1"]["equipmentWait"] == pytest.approx(5)
    assert [process["produced"] for process in result["finalState"]["processes"]] == [1, 1]


def test_robot_fault_preserves_cargo_reservations_and_corridor_then_resumes():
    project = reference_project()
    project["disruptions"] = [{"id": "robot-fault", "time": 5, "duration": 10, "targetType": "robot", "targetId": "r1"}]
    result = SimulationEngine(project).run()
    failed_history = [snapshot for snapshot in result["history"] if 5 <= snapshot["time"] < 15]
    assert failed_history
    for snapshot in result["history"]:
        resource_bounds(project, snapshot)
        assert inventory(snapshot, "part") == 1
    for snapshot in failed_history:
        assert snapshot["robots"][0]["status"] == "failed"
        assert snapshot["robots"][0]["carrying"] == {"product": "part", "quantity": 1}
        assert "r1" in snapshot["zoneOwners"].values()
        assert snapshot["buffers"][1]["reservedIn"] == 1
    assert result["finalState"]["jobs"][0]["completedAt"] == pytest.approx(22)
    assert result["finalState"]["robots"][0]["distanceLoaded"] == pytest.approx(10)
    assert result["kpis"]["robotStateSeconds"]["r1"]["failed"] == pytest.approx(10)
    assert result["finalState"]["zoneOwners"] == {}


def test_overlapping_robot_edge_faults_use_union_duration_and_keep_paused_progress():
    project = reference_project()
    project["disruptions"] = [
        {"id": "robot-fault", "time": 5, "duration": 10, "targetType": "robot", "targetId": "r1"},
        {"id": "edge-fault", "time": 8, "duration": 10, "targetType": "edge", "targetId": "corridor"},
    ]
    engine = SimulationEngine(project)
    paused = engine.run_until(5)["robots"][0]
    assert paused["movement"]["pausedAt"] == 5
    movement = paused["movement"]
    progress = (movement["pausedAt"] - movement["startedAt"]) / (movement["endsAt"] - movement["startedAt"])
    still_paused = engine.run_until(17)["robots"][0]
    assert still_paused["status"] == "failed"
    assert still_paused["movement"]["pausedAt"] == 5
    assert still_paused["distanceLoaded"] == paused["distanceLoaded"]
    resumed = engine.run_until(18)["robots"][0]
    assert resumed["status"] == "loadedTravel"
    assert "pausedAt" not in resumed["movement"]
    movement = resumed["movement"]
    assert (18 - movement["startedAt"]) / (movement["endsAt"] - movement["startedAt"]) == pytest.approx(progress)
    assert resumed["distanceLoaded"] == paused["distanceLoaded"]
    result = engine.run()
    assert result["finalState"]["jobs"][0]["completedAt"] == pytest.approx(25)
    assert result["kpis"]["robotStateSeconds"]["r1"]["failed"] == pytest.approx(13)


def test_fault_on_reverse_directed_edge_affects_the_same_physical_corridor():
    project = reference_project()
    project["edges"][0]["bidirectional"] = False
    project["edges"].append({**project["edges"][0], "id": "reverse", "from": "destination", "to": "source"})
    project["disruptions"] = [{"id": "reverse-fault", "time": 5, "duration": 10, "targetType": "edge", "targetId": "reverse"}]
    result = SimulationEngine(project).run()
    assert result["finalState"]["jobs"][0]["completedAt"] == pytest.approx(22)
    assert result["kpis"]["robotStateSeconds"]["r1"]["failed"] == pytest.approx(10)


def test_current_leg_finishes_but_entry_to_a_faulted_future_leg_waits():
    project = reference_project()
    project["nodes"].append({"id": "middle", "name": "Middle", "x": 5, "y": 0, "kind": "transit"})
    project["edges"] = [
        {"id": "first", "from": "source", "to": "middle", "length": 5, "width": 2, "speedLimit": 2, "bidirectional": True},
        {"id": "second", "from": "middle", "to": "destination", "length": 5, "width": 2, "speedLimit": 2, "bidirectional": True},
    ]
    project["disruptions"] = [{"id": "future-fault", "time": 4, "duration": 10, "targetType": "edge", "targetId": "second"}]
    engine = SimulationEngine(project)
    waiting = engine.run_until(8)["robots"][0]
    assert waiting["nodeId"] == "middle"
    assert waiting["status"] == "trafficWait"
    assert not waiting.get("movement")
    assert waiting["distanceLoaded"] == pytest.approx(5)
    result = engine.run()
    assert [event["time"] for event in result["events"] if event["kind"] == "move.enter"] == [2, 14]
    assert result["finalState"]["jobs"][0]["completedAt"] == pytest.approx(21.5)
    assert result["kpis"]["robotStateSeconds"]["r1"]["trafficWait"] == pytest.approx(7.5)


def test_exhausted_robot_keeps_cargo_zone_and_position_despite_future_callbacks_and_repair():
    project = reference_project()
    project["buffers"][0]["initialInventory"]["part"] = 2
    project["robotTypes"][0].update(idlePowerW=3600, loadedPowerW=3600)
    project["robots"].append({"id": "r2", "name": "Waiting robot", "typeId": "amr", "nodeId": "source", "initialBatteryWh": 15})
    project["disruptions"] = [{"id": "later-repair", "time": 18, "duration": 2, "targetType": "robot", "targetId": "r2"}]
    engine = SimulationEngine(project)
    exhausted = engine.run_until(15)
    stopped = next(robot for robot in exhausted["robots"] if robot["id"] == "r2")
    assert stopped["status"] == "failed"
    assert stopped["batteryWh"] == 0
    assert stopped["movement"]["pausedAt"] == 15
    assert stopped["carrying"] == {"product": "part", "quantity": 1}
    assert "r2" in exhausted["zoneOwners"].values()
    result = engine.run()
    final = next(robot for robot in result["finalState"]["robots"] if robot["id"] == "r2")
    assert final["status"] == "failed" and final["batteryWh"] == 0
    assert final["distanceLoaded"] == stopped["distanceLoaded"]
    assert final["movement"] == stopped["movement"]
    assert final["carrying"] == stopped["carrying"]
    assert "r2" in result["finalState"]["zoneOwners"].values()
    assert result["kpis"]["transportCompleted"] == 1
    assert result["kpis"]["unfinishedJobs"] == 1
    assert result["finalState"]["buffers"][1]["reservedIn"] == 1
    assert not [event for event in result["events"] if event.get("robotId") == "r2" and event["kind"] == "move.exit"]
    assert any(issue["code"] == "BATTERY_EXHAUSTED" and issue.get("entityId") == "r2" for issue in result["diagnostics"])
    for snapshot in result["history"]:
        resource_bounds(project, snapshot)
        assert inventory(snapshot, "part") == 2


def test_active_process_fault_pauses_work_without_duplicate_completion():
    project = example("equipmentFailure")
    result = SimulationEngine(project).run()
    assert [event["time"] for event in result["events"] if event["kind"] == "process.completed"] == [50, 70, 90]
    assert result["kpis"]["productionCompleted"] == 3
    assert result["kpis"]["processStateSeconds"]["p-source"]["failed"] == pytest.approx(30)


def test_early_recovered_fault_does_not_shift_a_future_absolute_process_start():
    project = reference_project()
    project["robots"] = []
    project["transportRules"] = []
    project["buffers"][1]["capacity"] = 1
    project["processes"] = [process_spec(startAt=100)]
    project["disruptions"] = [{"id": "early-fault", "time": 10, "duration": 5, "targetType": "process", "targetId": "producer"}]
    project["settings"]["duration"] = 110
    result = SimulationEngine(project).run()
    assert [event["time"] for event in result["events"] if event["kind"] == "process.started"] == [100]
    assert [event["time"] for event in result["events"] if event["kind"] == "process.completed"] == [105]


def test_warmup_excludes_time_from_state_totals_and_throughput_denominators():
    project = reference_project()
    project["settings"].update(duration=20, warmup=10)
    result = SimulationEngine(project).run()
    assert result["horizon"] == 20 and result["measurementStart"] == 10
    assert result["kpis"]["measurementSeconds"] == 10
    assert result["kpis"]["transportCompleted"] == 1
    assert result["kpis"]["transportPerHour"] == pytest.approx(360)
    times = result["kpis"]["robotStateSeconds"]["r1"]
    assert sum(times.values()) == pytest.approx(10)
    assert times["unloading"] == pytest.approx(2)
    assert times["idle"] == pytest.approx(8)


def test_pre_warmup_completion_is_preserved_in_trace_but_excluded_from_kpis():
    project = reference_project()
    project["settings"].update(duration=20, warmup=13)
    result = SimulationEngine(project).run()
    assert result["finalState"]["jobs"][0]["status"] == "completed"
    assert result["kpis"]["transportCompleted"] == result["kpis"]["transportPerHour"] == 0
    assert result["kpis"]["measurementSeconds"] == 7


def test_terminal_horizon_censors_travel_and_never_executes_future_completion():
    project = reference_project()
    project["settings"]["duration"] = 8
    result = SimulationEngine(project).run()
    assert result["horizon"] == result["finalState"]["time"] == 8
    assert result["kpis"]["transportCompleted"] == 0
    assert result["kpis"]["unfinishedJobs"] == 1
    assert result["finalState"]["robots"][0]["status"] == "loadedTravel"
    assert all(event["time"] <= 8 for event in result["events"])
    assert result["kpis"]["robotStateSeconds"]["r1"]["loading"] == pytest.approx(2)
    assert result["kpis"]["robotStateSeconds"]["r1"]["loadedTravel"] == pytest.approx(6)
    assert inventory(result["finalState"], "part") == 1


def test_partial_run_and_max_events_can_resume_to_the_same_result():
    project = reference_project()
    expected = SimulationEngine(project).run()
    paused = SimulationEngine(project)
    snapshot = paused.run_until(5)
    assert snapshot["time"] == 5 and not snapshot["finished"]
    assert snapshot["robots"][0]["status"] == "loadedTravel"
    assert paused.run() == expected
    limited = SimulationEngine(project)
    snapshot = limited.run_until(30, max_events=1)
    assert snapshot["eventCount"] == 1
    assert snapshot["time"] == 2 and not snapshot["finished"]
    assert limited.run() == expected


@pytest.mark.parametrize("name", ["singleRobot", "corridor", "charging", "bufferSaturation", "materialStarvation", "equipmentFailure"])
def test_shipped_benchmark_executes_to_horizon_with_bounded_resources(name):
    project = example(name)
    assert not [issue for issue in validate_project(project) if issue["severity"] == "error"]
    result = SimulationEngine(project).run()
    assert result["finalState"]["finished"]
    assert result["horizon"] == project["settings"]["duration"]
    assert result["events"]
    for snapshot in result["history"]:
        resource_bounds(project, snapshot)
