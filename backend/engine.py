"""Authoritative manufacturing/AMR DES, scheduled by a real SimPy Environment.

The browser consumes immutable state records.  Time, random draws, reservations,
inventory and KPIs belong exclusively to this module.  Physical traffic uses a
conservative atomic complete-route reservation, not a continuous collision model.
"""
from __future__ import annotations

from copy import deepcopy
import math
from typing import Callable, Any

import simpy
from simpy.events import Event

from .models import parse_project, validate_project, create_random, sample_distribution
from .routing import find_route, physical_zone

ENGINE_VERSION = "simpy-0.1.0"
EPS = 1e-8
MAX_EVENTS = 50000
MAX_HISTORY = 4000
# Keep priorities numeric so ordinary SimPy Process/Timeout/Resource events can
# coexist in this Environment. The bounded fractional tie preserves the original
# model registration order when a delayed callback receives a new SimPy event ID.
PRIORITY_TIE_SCALE = 2 ** 40


def total(values: dict) -> float:
    return sum(values.values())


class SimulationEngine:
    """Deterministic SimPy execution with SI-unit JSON input/output.

    ``env`` is the sole event scheduler and clock. Rescheduling a fault-delayed
    event invalidates its previous SimPy Event by generation; no second heap or
    independent JavaScript computation is involved. A bounded fractional part of
    SimPy's numeric priority retains the original model registration tie order.
    """

    def __init__(self, project: dict):
        self.project = parse_project(project)
        self.env = simpy.Environment()
        self.finished = False
        self.processed = 0
        self.sequence = 0
        self.events: list[dict] = []
        self.history: list[dict] = []
        self.diagnostics = validate_project(self.project)
        self.pending: dict[int, dict] = {}
        self.same_time_count = 0
        self.last_event_time = -1
        self.history_stride = 1
        self._base = None
        self.specs = {field: {item["id"]: item for item in self.project[field]}
                      for field in ("nodes", "edges", "buffers", "robots", "robotTypes", "processes", "chargers", "equipment")}
        self.robots = [{"id": spec["id"], "nodeId": spec["nodeId"], "status": "idle",
                        "batteryWh": spec["initialBatteryWh"], "distanceEmpty": 0.0,
                        "distanceLoaded": 0.0, "stateSince": 0.0, "stateTimes": {}}
                       for spec in self.project["robots"]]
        self.buffers = [{"id": spec["id"], "inventory": deepcopy(spec["initialInventory"]),
                         "reservedIn": 0, "reservedOut": {}, "maxOccupancy": total(spec["initialInventory"])}
                        for spec in self.project["buffers"]]
        self.processes = [{"id": spec["id"], "status": "idle", "produced": 0,
                           "stateSince": 0.0, "stateTimes": {}} for spec in self.project["processes"]]
        self.chargers = [{"id": spec["id"], "occupants": [], "queue": [], "reserved": [],
                          "failed": False, "busySeconds": 0.0, "maxQueue": 0}
                         for spec in self.project["chargers"]]
        self.state_maps = {"robots": {r["id"]: r for r in self.robots},
                           "buffers": {b["id"]: b for b in self.buffers},
                           "processes": {p["id"]: p for p in self.processes},
                           "chargers": {c["id"]: c for c in self.chargers}}
        self.jobs: list[dict] = []
        self.zones: dict[str, str] = {}
        self.pending_trips: dict[str, dict] = {}
        self.active_trips: dict[str, dict] = {}
        self.random_streams = {}
        self.power_tokens = {}
        self.process_workers = {}
        self.paused_processes = set()
        self.robot_measured = {r["id"]: {} for r in self.robots}
        self.process_measured = {p["id"]: {} for p in self.processes}
        self.occupancy_areas = {b["id"]: 0.0 for b in self.buffers}
        self.busy_areas = {c["id"]: 0.0 for c in self.chargers}
        self.production = []
        self.distance_measured = {"empty": 0.0, "loaded": 0.0}
        self.fault_until = {}
        self.paused_status = {}
        self.paused_movements = {}
        self.robot_pause_until = {}
        self.permanently_failed = set()
        for robot in self.robots:
            self._arm_power(robot)
        for process in self.project["processes"]:
            if process.get("startAt", 0) > 0:
                self._schedule(process["startAt"], 30, "process.start", lambda: None, processId=process["id"])
        for disruption in self.project["disruptions"]:
            self._schedule(disruption["time"], 0, "failure.start",
                           lambda disruption=disruption: self._start_failure(disruption), lifecycle=True)
        self._log("simulation.started", f"SimPy 시뮬레이션 시작 · seed {self.project['settings']['seed']}")
        # Initial conditions are settled once; all subsequent consequences are
        # caused by SimPy callbacks. A zero-time failure has higher event priority.
        self._settle()
        self._assert_invariants()
        self._checkpoint()
        self._record_snapshot()

    @property
    def time(self) -> float:
        return self.env.now

    def _schedule(self, time: float, priority: int, kind: str, action: Callable, **tags) -> dict:
        if not math.isfinite(time) or time < self.time - EPS:
            raise ValueError(f"잘못된 이벤트 시각: {kind} @ {time}")
        self.sequence += 1
        record = dict(time=max(time, self.time), priority=priority, sequence=self.sequence,
                      kind=kind, action=action, generation=0, **tags)
        self.pending[self.sequence] = record
        self._schedule_generation(record)
        return record

    def _schedule_generation(self, record: dict):
        generation = record["generation"]
        event = Event(self.env)
        event._ok = True
        event._value = None
        event.callbacks.append(lambda _: self._execute(record, generation))
        self.env.schedule(event, priority=record["priority"] + record["sequence"] / PRIORITY_TIE_SCALE,
                          delay=max(0, record["time"] - self.time))

    def _delay(self, predicate: Callable, seconds: float):
        if seconds <= 0:
            return
        for record in list(self.pending.values()):
            if predicate(record):
                record["time"] += seconds
                record["generation"] += 1
                self._schedule_generation(record)

    def _execute(self, record: dict, generation: int):
        seq = record["sequence"]
        if self.finished or seq not in self.pending or generation != record["generation"]:
            return
        del self.pending[seq]
        self._advance(self.time)
        self.same_time_count = self.same_time_count + 1 if self.time == self.last_event_time else 1
        self.last_event_time = self.time
        if self.same_time_count > 10000 or self.processed >= MAX_EVENTS:
            self._diagnostic("EVENT_LIMIT", f"이벤트 반복 한도 초과: {record['kind']} @ {self.time}. 0초 처리시간·순환 요청을 확인하세요.", severity="error")
            self.finished = True
            self._record_snapshot()
            return
        self.processed += 1
        if not record.get("robotId") or record["robotId"] not in self.permanently_failed or record.get("lifecycle"):
            record["action"]()
        self._settle()
        self._assert_invariants()
        self._checkpoint()
        self._record_snapshot()

    def _log(self, kind: str, message: str, **tags):
        self.events.append(dict(sequence=len(self.events) + 1, time=self.time, kind=kind,
                                message=message, **{k: v for k, v in tags.items() if v is not None}))

    def _diagnostic(self, code: str, message: str, entity_id=None, severity="warning"):
        if any(issue["code"] == code and issue.get("entityId") == entity_id for issue in self.diagnostics):
            return
        self.diagnostics.append(dict(severity=severity, code=code, message=message,
                                     **({"entityId": entity_id} if entity_id else {})))
        self._log("diagnostic", message, resourceId=entity_id, cause=code)

    def _buffer(self, id):
        return self.state_maps["buffers"][id]

    def _robot(self, id):
        return self.state_maps["robots"][id]

    def _type(self, robot):
        return self.specs["robotTypes"][self.specs["robots"][robot["id"]]["typeId"]]

    def _route(self, robot, origin, target, loaded=False):
        return find_route(self.project, origin, target, self._type(robot), loaded)

    def _fault(self, kind, id):
        return self.fault_until.get(f"{kind}:{id}", 0) > self.time + EPS

    def _edge_fault_until(self, edge_id):
        zone = physical_zone(self.specs["edges"][edge_id])
        return max([0] + [self.fault_until.get(f"edge:{edge['id']}", 0)
                          for edge in self.project["edges"] if physical_zone(edge) == zone])

    def _free(self, buffer, product):
        return buffer["inventory"].get(product, 0) - buffer["reservedOut"].get(product, 0)

    def _space(self, buffer):
        return self.specs["buffers"][buffer["id"]]["capacity"] - total(buffer["inventory"]) - buffer["reservedIn"]

    def _power(self, robot):
        kind = self._type(robot)
        status = robot["status"]
        if status == "failed":
            return 0
        if status == "charging":
            return -self.specs["chargers"][robot["chargerId"]]["powerW"]
        return kind["emptyPowerW"] if status == "emptyTravel" else kind["loadedPowerW"] if status == "loadedTravel" else kind["idlePowerW"]

    def _transition(self, robot, status):
        if robot["status"] == status:
            return
        before = robot["status"]
        robot["status"], robot["stateSince"] = status, self.time
        self._log("robot.state", f"{robot['id']}: {before} → {status}", robotId=robot["id"], jobId=robot.get("jobId"))
        self._arm_power(robot)

    def _process_transition(self, process, status):
        if process["status"] != status:
            before = process["status"]
            process["status"], process["stateSince"] = status, self.time
            self._log("process.state", f"{process['id']}: {before} → {status}", resourceId=process["id"])

    def _arm_power(self, robot):
        id = robot["id"]
        token = self.power_tokens.get(id, 0) + 1
        self.power_tokens[id] = token
        power, kind = self._power(robot), self._type(robot)
        if power <= 0 or robot["status"] == "failed":
            return
        if robot["status"] == "idle" and robot["batteryWh"] > kind["chargeBelowWh"] + EPS:
            def threshold():
                if self.power_tokens.get(id) == token and robot["status"] == "idle":
                    self._want_charge(robot)
                    self._arm_power(robot)
            self._schedule(self.time + (robot["batteryWh"] - kind["chargeBelowWh"]) * 3600 / power,
                           5, "battery.threshold", threshold, robotId=id)
        def empty():
            if self.power_tokens.get(id) != token or self._power(robot) <= 0:
                return
            robot["batteryWh"] = 0
            self.permanently_failed.add(id)
            if robot.get("movement"):
                robot["movement"]["pausedAt"] = self.time
            self._transition(robot, "failed")
            self._diagnostic("BATTERY_EXHAUSTED", f"{id} 배터리 고갈: 운송물·위치·점유를 보존한 채 복구가 필요합니다.", id, "error")
        self._schedule(self.time + max(0, robot["batteryWh"]) * 3600 / power, 1, "battery.empty", empty, robotId=id)

    def _advance(self, target):
        base = self._base
        if base is None or target <= base["time"]:
            return
        dt = target - base["time"]
        measured = max(0, target - max(base["time"], self.project["settings"]["warmup"]))
        self.robot_measured = deepcopy(base["robotMeasured"])
        self.process_measured = deepcopy(base["processMeasured"])
        self.occupancy_areas = deepcopy(base["occupancyAreas"])
        self.busy_areas = deepcopy(base["busyAreas"])
        self.distance_measured = deepcopy(base["distanceMeasured"])
        for robot, previous in zip(self.robots, base["robots"]):
            status = robot["status"]
            robot["stateTimes"] = deepcopy(previous["stateTimes"])
            robot["stateTimes"][status] = robot["stateTimes"].get(status, 0) + dt
            times = self.robot_measured[robot["id"]]
            times[status] = times.get(status, 0) + measured
            robot["batteryWh"] = max(0, min(self._type(robot)["batteryCapacityWh"], previous["batteryWh"] - self._power(robot) * dt / 3600))
            robot["distanceEmpty"], robot["distanceLoaded"] = previous["distanceEmpty"], previous["distanceLoaded"]
            trip = self.active_trips.get(robot["id"])
            leg = trip["route"]["legs"][trip["index"]] if trip and trip["index"] < len(trip["route"]["legs"]) else None
            if leg and status in ("emptyTravel", "loadedTravel") and leg["time"] > 0:
                loaded = trip["loaded"]
                robot["distanceLoaded" if loaded else "distanceEmpty"] += leg["length"] * dt / leg["time"]
                self.distance_measured["loaded" if loaded else "empty"] += leg["length"] * measured / leg["time"]
        for process, previous in zip(self.processes, base["processes"]):
            process["stateTimes"] = deepcopy(previous["stateTimes"])
            status = process["status"]
            process["stateTimes"][status] = process["stateTimes"].get(status, 0) + dt
            times = self.process_measured[process["id"]]
            times[status] = times.get(status, 0) + measured
        for buffer in self.buffers:
            self.occupancy_areas[buffer["id"]] += total(buffer["inventory"]) * measured
        for charger, previous in zip(self.chargers, base["chargers"]):
            charger["busySeconds"] = previous["busySeconds"] + len(charger["occupants"]) * dt
            self.busy_areas[charger["id"]] += len(charger["occupants"]) * measured

    def _checkpoint(self):
        self._base = deepcopy(dict(time=self.time, robots=self.robots, processes=self.processes,
                                   chargers=self.chargers, robotMeasured=self.robot_measured,
                                   processMeasured=self.process_measured, occupancyAreas=self.occupancy_areas,
                                   busyAreas=self.busy_areas, distanceMeasured=self.distance_measured))

    def _settle(self):
        for process in self.project["processes"]:
            self._try_process(process)
        self._generate_requests()
        for charger in self.chargers:
            self._start_queued_charges(charger)
        for robot in self.robots:
            if robot["status"] == "idle" and robot["batteryWh"] <= self._type(robot)["chargeBelowWh"] + EPS:
                self._want_charge(robot)
        self._dispatch()
        for id, trip in list(self.pending_trips.items()):
            self._try_trip(self._robot(id), trip)

    def _try_process(self, spec):
        state = self.state_maps["processes"][spec["id"]]
        if state["status"] == "processing" or self._fault("process", spec["id"]) or self.time + EPS < spec.get("startAt", 0):
            return
        input_buffer = self._buffer(spec["inputBufferId"]) if spec.get("inputBufferId") else None
        if any(q > 0 and (input_buffer is None or self._free(input_buffer, product) + EPS < q)
               for product, q in spec["inputRequirements"].items()):
            self._process_transition(state, "materialWait")
            return
        output = self._buffer(spec["outputBufferId"])
        released = total(spec["inputRequirements"]) if input_buffer is not None and input_buffer["id"] == output["id"] else 0
        if self._space(output) + released + EPS < spec["outputQuantity"]:
            self._process_transition(state, "outputWait")
            return
        worker = spec.get("workerResourceId")
        if worker:
            if self.process_workers.get(worker, 0) >= self.specs["equipment"][worker]["capacity"]:
                self._process_transition(state, "equipmentWait")
                return
            self.process_workers[worker] = self.process_workers.get(worker, 0) + 1
        if input_buffer is not None:
            for product, quantity in spec["inputRequirements"].items():
                input_buffer["inventory"][product] = input_buffer["inventory"].get(product, 0) - quantity
        quantity = spec["outputQuantity"]
        output["reservedIn"] += quantity
        self._process_transition(state, "processing")
        if spec["id"] not in self.random_streams:
            self.random_streams[spec["id"]] = create_random(self.project["settings"]["seed"], f"process:{spec['id']}")
        duration = sample_distribution(spec["processingTime"], self.random_streams[spec["id"]])
        self._log("process.started", f"{spec['name']} 가공 시작 ({duration:.3f} s)", resourceId=spec["id"])
        def completed():
            output["reservedIn"] -= quantity
            product = spec["outputProduct"]
            output["inventory"][product] = output["inventory"].get(product, 0) + quantity
            output["maxOccupancy"] = max(output["maxOccupancy"], total(output["inventory"]))
            state["produced"] += quantity
            if spec["isFinal"]:
                self.production.append(dict(time=self.time, quantity=quantity))
            if worker:
                self.process_workers[worker] -= 1
            self._process_transition(state, "idle")
            self._log("process.completed", f"{spec['name']}: {product} {quantity}개 생산", resourceId=spec["id"])
        self._schedule(self.time + duration, 20, "process.completed", completed, processId=spec["id"])

    def _generate_requests(self):
        for rule in self.project["transportRules"]:
            source = self._buffer(rule["sourceBufferId"])
            count = 0
            while self._free(source, rule["product"]) + EPS >= rule["quantity"]:
                count += 1
                if count > 10000:
                    raise ValueError(f"{rule['id']}: 한 번의 운송 요청 수가 너무 많습니다.")
                job = {key: rule[key] for key in ("sourceBufferId", "destinationBufferId", "product", "quantity", "unitWeightKg", "priority")}
                job.update(id=f"job-{len(self.jobs)+1:06}", ruleId=rule["id"], requestedAt=self.time, status="waiting")
                if rule.get("dueAfter") is not None:
                    job["dueAt"] = self.time + rule["dueAfter"]
                source["reservedOut"][rule["product"]] = source["reservedOut"].get(rule["product"], 0) + rule["quantity"]
                self.jobs.append(job)
                self._log("transport.requested", f"{rule['name']}: {rule['product']} {rule['quantity']}개 운송 요청", jobId=job["id"], resourceId=source["id"])

    def _candidate(self, robot, job):
        kind = self._type(robot)
        if job["quantity"] > kind["maxUnits"] or job["quantity"] * job["unitWeightKg"] > kind["maxPayloadKg"] or (job["product"] not in kind["cargoTypes"] and "*" not in kind["cargoTypes"]):
            return None
        source, dest = self.specs["buffers"][job["sourceBufferId"]], self.specs["buffers"][job["destinationBufferId"]]
        empty, loaded = self._route(robot, robot["nodeId"], source["nodeId"]), self._route(robot, source["nodeId"], dest["nodeId"], True)
        if empty is None or loaded is None:
            return None
        return_energy = 0
        if self.chargers:
            routes = [self._route(robot, dest["nodeId"], charger["nodeId"])
                      for charger in self.project["chargers"] if kind["id"] in charger["compatibleTypes"]]
            routes = [route for route in routes if route is not None]
            if not routes:
                return None
            return_energy = min(route["time"] * kind["emptyPowerW"] / 3600 for route in routes)
        energy = (empty["time"] * kind["emptyPowerW"] + loaded["time"] * kind["loadedPowerW"] + (kind["loadTime"] + kind["unloadTime"]) * kind["idlePowerW"]) / 3600 + return_energy + kind["reserveWh"]
        policy = self.project["settings"]["dispatchPolicy"]
        score = empty["distance"] if policy == "nearest" else empty["time"] + loaded["time"] + kind["loadTime"] + kind["unloadTime"] if policy == "earliestFinish" else self.robots.index(robot)
        return dict(empty=empty, loaded=loaded, energy=energy, score=score)

    def _dispatch(self):
        waiting = [job for job in self.jobs if job["status"] == "waiting"]
        if self.project["settings"]["dispatchPolicy"] == "priority":
            waiting.sort(key=lambda job: (-job["priority"], job["requestedAt"], job["id"]))
        for job in waiting:
            destination = self._buffer(job["destinationBufferId"])
            if self._space(destination) + EPS < job["quantity"]:
                job["reason"] = "목적지 버퍼 용량 부족"
                continue
            candidates = []
            for robot in self.robots:
                if robot["status"] == "idle" and not self._fault("robot", robot["id"]):
                    plan = self._candidate(robot, job)
                    if plan is not None:
                        candidates.append((robot, plan))
            candidates.sort(key=lambda item: (item[1]["score"], item[0]["id"]))
            chosen = next((item for item in candidates if item[0]["batteryWh"] + EPS >= item[1]["energy"]), None)
            if chosen is None:
                job["reason"] = "작업·충전소 복귀·예비 배터리 부족" if candidates else "적합한 가용 로봇 또는 연결 경로 없음"
                for robot, _ in candidates:
                    self._want_charge(robot)
                continue
            robot, plan = chosen
            destination["reservedIn"] += job["quantity"]
            job.update(status="assigned", robotId=robot["id"], assignedAt=self.time)
            job.pop("reason", None)
            robot["jobId"] = job["id"]
            self._log("transport.assigned", f"{job['id']} → {robot['id']}", robotId=robot["id"], jobId=job["id"])
            self._travel(robot, plan["empty"], False,
                         lambda robot=robot, job=job, loaded=plan["loaded"]: self._load(robot, job, loaded))

    def _load(self, robot, job, loaded_route):
        job["status"] = "loading"
        self._transition(robot, "loading")
        def loaded():
            source = self._buffer(job["sourceBufferId"])
            source["inventory"][job["product"]] -= job["quantity"]
            source["reservedOut"][job["product"]] -= job["quantity"]
            robot["carrying"] = dict(product=job["product"], quantity=job["quantity"])
            job["status"] = "transporting"
            self._log("transport.loaded", f"{job['id']}: {job['product']} {job['quantity']}개 적재 완료", robotId=robot["id"], jobId=job["id"], resourceId=source["id"])
            self._travel(robot, loaded_route, True, lambda: self._unload(robot, job))
        self._schedule(self.time + self._type(robot)["loadTime"], 20, "transport.loaded", loaded, robotId=robot["id"])

    def _unload(self, robot, job):
        job["status"] = "unloading"
        self._transition(robot, "unloading")
        def completed():
            destination = self._buffer(job["destinationBufferId"])
            destination["reservedIn"] -= job["quantity"]
            destination["inventory"][job["product"]] = destination["inventory"].get(job["product"], 0) + job["quantity"]
            destination["maxOccupancy"] = max(destination["maxOccupancy"], total(destination["inventory"]))
            robot.pop("carrying", None)
            robot.pop("jobId", None)
            job.update(status="completed", completedAt=self.time)
            self._transition(robot, "idle")
            self._log("transport.completed", f"{job['id']}: {job['product']} {job['quantity']}개 인계 완료", robotId=robot["id"], jobId=job["id"], resourceId=destination["id"])
        self._schedule(self.time + self._type(robot)["unloadTime"], 20, "transport.completed", completed, robotId=robot["id"])

    def _trip_zones(self, route):
        zones = {leg["zoneId"] for leg in route["legs"]}
        zones.update(f"node:{id}" for id in route["nodes"] if self.specs["nodes"][id]["kind"] == "intersection")
        return sorted(zones)

    def _travel(self, robot, route, loaded, done):
        trip = dict(route=route, loaded=loaded, done=done, zones=self._trip_zones(route), index=0)
        self.pending_trips[robot["id"]] = trip
        self._try_trip(robot, trip)

    def _try_trip(self, robot, trip):
        if robot["id"] not in self.pending_trips or self._fault("robot", robot["id"]) or robot["status"] == "failed":
            return
        blocked = any(self._edge_fault_until(leg["edgeId"]) > self.time + EPS for leg in trip["route"]["legs"])
        blocked = blocked or any(zone in self.zones and self.zones[zone] != robot["id"] for zone in trip["zones"])
        if blocked:
            self._transition(robot, "trafficWait")
            return
        del self.pending_trips[robot["id"]]
        for zone in trip["zones"]:
            self.zones[zone] = robot["id"]
        self.active_trips[robot["id"]] = trip
        self._log("route.reserved", f"{robot['id']} 경로 자원 {len(trip['zones'])}개 예약", robotId=robot["id"], jobId=robot.get("jobId"))
        self._next_leg(robot, trip)

    def _next_leg(self, robot, trip):
        if trip["index"] >= len(trip["route"]["legs"]):
            for zone in trip["zones"]:
                if self.zones.get(zone) == robot["id"]:
                    del self.zones[zone]
            self.active_trips.pop(robot["id"], None)
            robot.pop("movement", None)
            robot.pop("edgeId", None)
            self._log("route.released", f"{robot['id']} 경로 자원 해제", robotId=robot["id"], jobId=robot.get("jobId"))
            trip["done"]()
            return
        leg = trip["route"]["legs"][trip["index"]]
        if self._edge_fault_until(leg["edgeId"]) > self.time + EPS:
            self._transition(robot, "trafficWait")
            self._schedule(self._edge_fault_until(leg["edgeId"]), 10, "move.waitRecovery", lambda: self._next_leg(robot, trip), robotId=robot["id"])
            return
        self._transition(robot, "loadedTravel" if trip["loaded"] else "emptyTravel")
        robot["edgeId"] = leg["edgeId"]
        robot["movement"] = {"from": leg["from"], "to": leg["to"], "startedAt": self.time, "endsAt": self.time + leg["time"]}
        self._log("move.enter", f"{robot['id']}: {leg['from']} → {leg['to']}", robotId=robot["id"], jobId=robot.get("jobId"), resourceId=leg["zoneId"])
        def exited():
            robot["nodeId"] = leg["to"]
            robot.pop("movement", None)
            robot.pop("edgeId", None)
            self._log("move.exit", f"{robot['id']}: {leg['to']} 도착", robotId=robot["id"], jobId=robot.get("jobId"), resourceId=leg["zoneId"])
            trip["index"] += 1
            self._next_leg(robot, trip)
        self._schedule(self.time + leg["time"], 10, "move.exit", exited, robotId=robot["id"], edgeId=leg["edgeId"])

    def _want_charge(self, robot):
        if robot["status"] != "idle" or self._fault("robot", robot["id"]):
            return False
        kind = self._type(robot)
        if robot["batteryWh"] >= kind["chargeToWh"] - EPS:
            return False
        choices = []
        for state in self.chargers:
            spec = self.specs["chargers"][state["id"]]
            route = self._route(robot, robot["nodeId"], spec["nodeId"])
            if state["failed"] or kind["id"] not in spec["compatibleTypes"] or route is None or len(state["occupants"]) + len(state["queue"]) + len(state["reserved"]) >= spec["capacity"] + spec["waitingCapacity"] or robot["batteryWh"] + EPS < route["time"] * kind["emptyPowerW"] / 3600:
                continue
            wait = (len(state["occupants"]) + len(state["queue"]) + len(state["reserved"])) * kind["batteryCapacityWh"] * 3600 / (spec["powerW"] * spec["capacity"])
            choices.append((route["time"] + wait, spec["id"], state, spec, route))
        if not choices:
            return False
        _, _, state, spec, route = min(choices, key=lambda item: (item[0], item[1]))
        state["reserved"].append(robot["id"])
        robot["chargerId"] = state["id"]
        self._log("charge.reserved", f"{robot['id']} → {spec['name']} 충전 예약", robotId=robot["id"], resourceId=spec["id"])
        def arrived():
            state["reserved"].remove(robot["id"])
            state["queue"].append(robot["id"])
            state["maxQueue"] = max(state["maxQueue"], max(0, len(state["queue"]) - max(0, spec["capacity"] - len(state["occupants"]))))
            self._transition(robot, "chargeWait")
            self._log("charge.queued", f"{robot['id']} 충전 대기", robotId=robot["id"], resourceId=spec["id"])
            self._start_queued_charges(state)
        self._travel(robot, route, False, arrived)
        return True

    def _start_queued_charges(self, state):
        spec = self.specs["chargers"][state["id"]]
        if state["failed"]:
            return
        while len(state["occupants"]) < spec["capacity"] and state["queue"]:
            id = next((id for id in state["queue"] if not self._fault("robot", id) and self._robot(id)["status"] != "failed"), None)
            if id is None:
                return
            state["queue"].remove(id)
            state["occupants"].append(id)
            self._begin_charge(self._robot(id), state, spec)

    def _begin_charge(self, robot, state, spec):
        self._transition(robot, "docking")
        def started():
            self._transition(robot, "charging")
            target = min(self._type(robot)["batteryCapacityWh"], self._type(robot)["chargeToWh"])
            self._log("charge.started", f"{robot['id']} 충전 시작", robotId=robot["id"], resourceId=spec["id"])
            def finished():
                robot["batteryWh"] = target
                self._transition(robot, "undocking")
                def released():
                    state["occupants"].remove(robot["id"])
                    robot.pop("chargerId", None)
                    self._transition(robot, "idle")
                    self._log("charge.completed", f"{robot['id']} 충전 완료 ({robot['batteryWh']:.2f} Wh)", robotId=robot["id"], resourceId=spec["id"])
                self._schedule(self.time + spec["undockTime"], 15, "charge.released", released, robotId=robot["id"], chargerId=spec["id"])
            self._schedule(self.time + max(0, target - robot["batteryWh"]) * 3600 / spec["powerW"], 15, "charge.finished", finished, robotId=robot["id"], chargerId=spec["id"])
        self._schedule(self.time + spec["dockTime"], 15, "charge.started", started, robotId=robot["id"], chargerId=spec["id"])

    def _start_failure(self, disruption):
        kind, id = disruption["targetType"], disruption["targetId"]
        key = f"{kind}:{id}"
        old_end = self.fault_until.get(key, self.time)
        end = max(old_end, self.time + disruption["duration"])
        extension = end - max(old_end, self.time)
        self.fault_until[key] = end
        self._log("failure.started", f"{kind} {id} 장애 ({disruption['duration']} s)", resourceId=id, cause=disruption["id"])
        robots = []
        if kind == "robot":
            robots.append(self._robot(id))
        elif kind == "charger":
            charger = self.state_maps["chargers"][id]
            charger["failed"] = True
            robots.extend(self._robot(robot_id) for robot_id in charger["occupants"])
        elif kind == "edge":
            zone = physical_zone(self.specs["edges"][id])
            robots.extend(robot for robot in self.robots if robot.get("edgeId") and physical_zone(self.specs["edges"][robot["edgeId"]]) == zone)
        for robot in robots:
            self._pause_robot(robot, end)
        if kind == "process":
            state = self.state_maps["processes"][id]
            self._delay(lambda e: not e.get("lifecycle") and e.get("processId") == id and e["kind"] == "process.completed", extension)
            if state["status"] == "processing":
                self.paused_processes.add(id)
            self._process_transition(state, "failed")
        def recovered():
            if self.fault_until.get(key) != end:
                return
            del self.fault_until[key]
            if kind == "charger":
                self.state_maps["chargers"][id]["failed"] = False
            if kind == "process":
                self._process_transition(self.state_maps["processes"][id], "processing" if id in self.paused_processes else "idle")
                self.paused_processes.discard(id)
            self._log("failure.recovered", f"{kind} {id} 복구", resourceId=id, cause=disruption["id"])
        self._schedule(end, 0, "failure.recovered", recovered, lifecycle=True)

    def _pause_robot(self, robot, until):
        id = robot["id"]
        if id in self.permanently_failed:
            return
        old_end = self.robot_pause_until.get(id, self.time)
        end = max(old_end, until)
        extension = end - max(old_end, self.time)
        self.robot_pause_until[id] = end
        if id not in self.paused_status:
            self.paused_status[id] = robot["status"]
            if robot.get("movement"):
                self.paused_movements[id] = deepcopy(robot["movement"])
                robot["movement"]["pausedAt"] = self.time
            self._transition(robot, "failed")
        self._delay(lambda e: not e.get("lifecycle") and e.get("robotId") == id, extension)
        movement = self.paused_movements.get(id)
        if movement:
            movement["startedAt"] += extension
            movement["endsAt"] += extension
        def resumed():
            if self.robot_pause_until.get(id) != end or id in self.permanently_failed:
                return
            del self.robot_pause_until[id]
            if id in self.paused_status:
                status = self.paused_status.pop(id)
                movement = self.paused_movements.pop(id, None)
                if movement:
                    robot["movement"] = movement
                self._transition(robot, status)
        self._schedule(end, 2, "robot.resumed", resumed, lifecycle=True)

    def _assert_invariants(self):
        for buffer in self.buffers:
            quantities = list(buffer["inventory"].values()) + list(buffer["reservedOut"].values()) + [buffer["reservedIn"]]
            if any(not math.isfinite(v) or v < -EPS for v in quantities) or total(buffer["inventory"]) + buffer["reservedIn"] > self.specs["buffers"][buffer["id"]]["capacity"] + EPS or any(q + EPS < buffer["reservedOut"].get(product, 0) for product, q in buffer["inventory"].items()):
                raise RuntimeError(f"{buffer['id']}: 재고 또는 용량 불변식 위반")
        for robot in self.robots:
            if not math.isfinite(robot["batteryWh"]) or not -EPS <= robot["batteryWh"] <= self._type(robot)["batteryCapacityWh"] + EPS:
                raise RuntimeError(f"{robot['id']}: 배터리 불변식 위반")
        for charger in self.chargers:
            spec = self.specs["chargers"][charger["id"]]
            if len(charger["occupants"]) > spec["capacity"] or len(charger["queue"]) > spec["waitingCapacity"]:
                raise RuntimeError(f"{charger['id']}: 충전 자원 용량 불변식 위반")

    def _record_snapshot(self):
        if len(self.history) >= MAX_HISTORY:
            self.history = self.history[::2]
            self.history_stride *= 2
            self._diagnostic("HISTORY_SAMPLED", "긴 실행의 상태 이력은 간격을 늘려 보관합니다. 전체 이벤트 로그는 유지됩니다.")
        if self.finished or self.processed % self.history_stride == 0:
            self.history.append(self.get_snapshot())

    def _clock_to(self, target):
        if target <= self.time:
            self._advance(target)
            return
        # A clock-only SimPy event advances an empty interval. It does not create
        # a model event, draw randomness, or establish a new integration base.
        event = Event(self.env)
        event._ok = True
        event._value = None
        event.callbacks.append(lambda _: self._advance(self.time))
        self.env.schedule(event, priority=100 + (self.sequence + 1) / PRIORITY_TIE_SCALE, delay=target - self.time)
        while self.env.peek() <= target:
            self.env.step()

    def step(self):
        if not self.finished:
            before = self.processed
            while not self.finished and self.processed == before and self.env.peek() <= self.project["settings"]["duration"]:
                self.env.step()
            if not self.finished and self.env.peek() > self.project["settings"]["duration"]:
                self._finish()
        return self.get_snapshot()

    def run_until(self, time: float, max_events=math.inf):
        if not isinstance(time, (int, float)) or not math.isfinite(time) or time < self.time:
            raise ValueError("실행 종료 시각은 현재 시각 이상의 유한한 수여야 합니다.")
        if self.finished:
            return self.get_snapshot()
        target = min(time, self.project["settings"]["duration"])
        before = self.processed
        while not self.finished and self.env.peek() <= target and self.processed - before < max_events:
            self.env.step()
        if not self.finished and self.processed - before < max_events:
            self._clock_to(target)
            if target >= self.project["settings"]["duration"]:
                self._finish()
        return self.get_snapshot()

    def run(self, until=None):
        self.run_until(self.project["settings"]["duration"] if until is None else until)
        return self.get_result()

    def _finish(self):
        if self.finished:
            return
        self._clock_to(self.project["settings"]["duration"])
        self.finished = True
        waiting = [job for job in self.jobs if job["status"] not in ("completed", "cancelled")]
        if waiting and not any(robot["status"] in ("emptyTravel", "loadedTravel", "loading", "unloading", "charging", "docking", "undocking") for robot in self.robots):
            reasons = ", ".join(dict.fromkeys(job.get("reason", "자원 대기 또는 장애") for job in waiting))
            self._diagnostic("UNFINISHED_JOBS", f"{len(waiting)}개 작업 미완료: {reasons}")
        self._log("simulation.finished", f"SimPy 시뮬레이션 종료 · {self.time:.3f} s")
        self._record_snapshot()

    def get_snapshot(self):
        return deepcopy(dict(time=self.time, eventCount=self.processed, lastEventSequence=len(self.events), robots=self.robots,
                             buffers=self.buffers, processes=self.processes, chargers=self.chargers,
                             jobs=self.jobs, zoneOwners=self.zones, diagnostics=self.diagnostics, finished=self.finished))

    def _kpis(self):
        start = self.project["settings"]["warmup"]
        seconds = max(0, self.time - start)
        completed = [job for job in self.jobs if job["status"] == "completed" and job["completedAt"] >= start]
        leads = sorted(job["completedAt"] - job["requestedAt"] for job in completed)
        mean = lambda values: sum(values) / len(values) if values else 0
        production = sum(item["quantity"] for item in self.production if item["time"] >= start)
        hourly = 3600 / seconds if seconds > 0 else 0
        moved = total(self.distance_measured)
        return dict(productionCompleted=production, transportCompleted=len(completed),
                    productionPerHour=production * hourly, transportPerHour=len(completed) * hourly,
                    meanLeadTime=mean(leads), p95LeadTime=leads[math.ceil(len(leads) * .95) - 1] if leads else 0,
                    meanDispatchWait=mean([job["assignedAt"] - job["requestedAt"] for job in completed]),
                    overdueJobs=sum(1 for job in self.jobs if job.get("dueAt") is not None and job.get("completedAt", self.time) > job["dueAt"] and job.get("completedAt", self.time) >= start),
                    unfinishedJobs=sum(1 for job in self.jobs if job["status"] not in ("completed", "cancelled")),
                    emptyDistanceRatio=self.distance_measured["empty"] / moved if moved > 0 else 0,
                    measurementSeconds=seconds, robotStateSeconds=deepcopy(self.robot_measured),
                    processStateSeconds=deepcopy(self.process_measured),
                    chargerUtilization={c["id"]: self.busy_areas[c["id"]] / (seconds * self.specs["chargers"][c["id"]]["capacity"]) if seconds > 0 else 0 for c in self.chargers},
                    bufferOccupancy={b["id"]: self.occupancy_areas[b["id"]] / (seconds * self.specs["buffers"][b["id"]]["capacity"]) if seconds > 0 else 0 for b in self.buffers},
                    maxChargeQueue=max([0] + [c["maxQueue"] for c in self.chargers]))

    def get_result(self):
        assumptions = self.project["assumptions"] + [
            "Python SimPy Environment가 시간·이벤트·상태·수량·KPI를 계산합니다. 브라우저는 기록을 재생합니다.",
            "이동 경로 전체 통로·교차로를 원자적으로 예약하는 보수적 교통 모델입니다.",
            "구간별 정지·가감속 및 중간 노드 회전시간을 적용합니다. 물리적 연속 충돌 검증은 하지 않습니다.",
            "충전기가 없으면 작업 에너지와 예비잔량만 검사합니다.",
            "충전 이용률은 도킹·충전·이탈 포트 점유 / (측정 시간 × 포트 수)입니다.",
            "버퍼 이용률은 실제 재고 시간 적분 / (측정 시간 × 용량)이며 예약은 제외합니다.",
            "완료 기준 지연시간은 측정 구간에 완료한 작업의 전체 요청→완료 시간입니다.",
            "최대 충전 대기열은 안정화 구간을 포함한 전체 실행 기준입니다.",
        ]
        return deepcopy(dict(runId=f"{self.project['id']}-seed{self.project['settings']['seed']}-t{self.time}",
                             projectId=self.project["id"], scenarioId=self.project["id"],
                             engineVersion=ENGINE_VERSION, engineName="Python SimPy", modelVersion=self.project["modelVersion"],
                             seed=self.project["settings"]["seed"], horizon=self.time, measurementStart=self.project["settings"]["warmup"],
                             assumptions=assumptions, kpis=self._kpis(), events=self.events, history=self.history,
                             finalState=self.get_snapshot(), diagnostics=self.diagnostics))
