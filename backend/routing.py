"""Pure graph routing; physical corridor reservations belong to the SimPy engine."""
from __future__ import annotations

import math


def segment_travel_time(length: float, speed: float, acceleration: float) -> float:
    if not all(math.isfinite(v) for v in (length, speed, acceleration)) or length < 0 or speed <= 0 or acceleration <= 0:
        return math.inf
    acceleration_distance = speed * speed / acceleration
    return (2 * math.sqrt(length / acceleration) if length <= acceleration_distance
            else 2 * speed / acceleration + (length - acceleration_distance) / speed)


def physical_zone(edge: dict) -> str:
    return edge.get('zoneId') or 'corridor:' + ':'.join(sorted((edge['from'], edge['to'])))


def find_route(project: dict, from_id: str, to_id: str, robot_type: dict, loaded: bool = False) -> dict | None:
    """Deterministic shortest-time path with conservative stop-to-stop travel."""
    node_ids = [node['id'] for node in project['nodes']]
    node_set = set(node_ids)
    if from_id not in node_set or to_id not in node_set:
        return None
    if from_id == to_id:
        return {'nodes': [from_id], 'legs': [], 'distance': 0.0, 'time': 0.0}
    base_speed = robot_type['loadedSpeed'] if loaded else robot_type['emptySpeed']
    if base_speed <= 0 or robot_type['acceleration'] <= 0 or robot_type['width'] <= 0:
        return None
    outgoing: dict[str, list[dict]] = {}
    for edge in project['edges']:
        if (edge.get('disabled') or edge['from'] not in node_set or edge['to'] not in node_set
                or edge['width'] < robot_type['width'] or edge['length'] <= 0 or edge['speedLimit'] <= 0):
            continue
        if 'allowedRobotTypes' in edge and robot_type['id'] not in edge['allowedRobotTypes']:
            continue
        duration = segment_travel_time(edge['length'], min(edge['speedLimit'], base_speed), robot_type['acceleration'])
        if not math.isfinite(duration):
            continue
        directions = [(edge['from'], edge['to'])]
        if edge['bidirectional']:
            directions.append((edge['to'], edge['from']))
        for start, end in directions:
            outgoing.setdefault(start, []).append({'edgeId': edge['id'], 'from': start, 'to': end,
                                                   'length': edge['length'], 'time': duration, 'zoneId': physical_zone(edge)})
    distances = {from_id: 0.0}
    previous: dict[str, dict] = {}
    remaining = set(node_ids)
    while remaining:
        # Declaration order is the explicit, stable equal-cost tie breaker.
        current = min((node for node in node_ids if node in remaining), key=lambda node: distances.get(node, math.inf))
        best = distances.get(current, math.inf)
        if not math.isfinite(best) or current == to_id:
            break
        remaining.remove(current)
        for original in outgoing.get(current, []):
            if original['to'] not in remaining:
                continue
            leg = dict(original)
            leg['time'] += 0 if current == from_id else max(0, robot_type['turnTime'])
            next_cost = best + leg['time']
            if next_cost < distances.get(leg['to'], math.inf):
                distances[leg['to']] = next_cost
                previous[leg['to']] = leg
    if to_id not in previous:
        return None
    legs = []
    cursor = to_id
    while cursor != from_id:
        leg = previous.get(cursor)
        if leg is None:
            return None
        legs.insert(0, leg)
        cursor = leg['from']
    return {'nodes': [from_id] + [leg['to'] for leg in legs], 'legs': legs,
            'distance': sum(leg['length'] for leg in legs), 'time': sum(leg['time'] for leg in legs)}
