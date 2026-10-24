"""Server-side project validation and independently seeded process distributions.

The HTTP client is untrusted: the Python engine always validates its own input.
The project JSON is retained verbatim after validation, including planning metadata.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import math
import random
from typing import Any, Callable

from .routing import find_route

ARRAY_FIELDS = ('nodes', 'edges', 'objects', 'buffers', 'robotTypes', 'robots', 'chargers', 'processes', 'transportRules', 'equipment', 'disruptions')
UNSAFE_KEYS = {'__proto__', 'prototype', 'constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'}
MAX_SAFE_INTEGER = 9007199254740991


def finite(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def safe_integer(value: Any) -> bool:
    return finite(value) and float(value).is_integer() and abs(value) <= MAX_SAFE_INTEGER


def nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_distribution(value: Any) -> list[str]:
    if not isinstance(value, dict):
        return ['processingTime: 분포 객체가 필요합니다.']
    errors = []
    kind = value.get('kind')

    def number(key: str, positive: bool = False) -> None:
        number_value = value.get(key)
        if not finite(number_value) or (number_value <= 0 if positive else number_value < 0):
            errors.append(f'{kind}.{key}: {"0 초과" if positive else "0 이상"}의 유한한 초 단위 값이 필요합니다.')

    if kind == 'fixed':
        number('value')
    elif kind in ('uniform', 'triangular'):
        number('min'); number('max')
        if finite(value.get('min')) and finite(value.get('max')) and value['min'] > value['max']:
            errors.append('분포 min ≤ max 조건이 필요합니다.')
        if kind == 'triangular':
            number('mode')
            if all(finite(value.get(k)) for k in ('min', 'mode', 'max')) and not value['min'] <= value['mode'] <= value['max']:
                errors.append('삼각분포 min ≤ mode ≤ max 조건이 필요합니다.')
    elif kind == 'normal':
        if not finite(value.get('mean')):
            errors.append('절단 정규분포 평균은 유한해야 합니다.')
        number('sd'); number('min'); number('max')
        if finite(value.get('min')) and finite(value.get('max')) and value['min'] > value['max']:
            errors.append('절단 정규분포 min ≤ max 조건이 필요합니다.')
        if value.get('sd') == 0 and all(finite(value.get(k)) for k in ('mean', 'min', 'max')) and not value['min'] <= value['mean'] <= value['max']:
            errors.append('표준편차 0의 평균은 절단 범위 안에 있어야 합니다.')
    elif kind == 'lognormal':
        if not finite(value.get('mu')):
            errors.append('로그정규 mu는 로그 공간의 유한한 평균이어야 합니다.')
        number('sigma')
        if finite(value.get('mu')) and finite(value.get('sigma')) and value['mu'] + 8 * value['sigma'] > 700:
            errors.append('로그정규분포 매개변수의 수치 범위를 초과합니다.')
    elif kind == 'exponential':
        number('mean', True)
    elif kind == 'empirical':
        values = value.get('values')
        if not isinstance(values, list) or not values or any(not finite(v) or v < 0 for v in values):
            errors.append('실측 샘플은 비어 있지 않은 0 이상 초 단위 값 목록이어야 합니다.')
    else:
        errors.append('지원하지 않는 분포 종류입니다.')
    return errors


def validate_project(value: Any) -> list[dict]:
    issues: list[dict] = []

    def add(code: str, message: str, entity_id: str | None = None, severity: str = 'error') -> None:
        issue = {'severity': severity, 'code': code, 'message': message}
        if entity_id:
            issue['entityId'] = entity_id
        issues.append(issue)

    if not isinstance(value, dict):
        add('PROJECT_OBJECT', '프로젝트는 JSON 객체여야 합니다.')
        return issues
    p = value
    # Reject non-JSON/non-finite leaves even in optional metadata, before serialization.
    def inspect_json(item: Any, path: str = 'project', depth: int = 0) -> None:
        if depth > 100:
            add('JSON_DEPTH', f'{path}: JSON 중첩이 너무 깊습니다.')
        elif isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str):
                    add('JSON_KEY', f'{path}: JSON 키는 문자열이어야 합니다.')
                inspect_json(child, f'{path}.{key}', depth + 1)
        elif isinstance(item, list):
            for index, child in enumerate(item):
                inspect_json(child, f'{path}[{index}]', depth + 1)
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            if not finite(item):
                add('NON_FINITE', f'{path}: NaN 또는 무한수를 사용할 수 없습니다.')
        elif item is not None and not isinstance(item, (str, bool)):
            add('JSON_VALUE', f'{path}: 지원하지 않는 JSON 값입니다.')
    inspect_json(p)
    if p.get('schemaVersion') != '1.0':
        add('SCHEMA_VERSION', '지원하는 schemaVersion은 "1.0"입니다.')
    for field in ('id', 'name', 'description', 'modelVersion'):
        if not isinstance(p.get(field), str) or (field != 'description' and not nonempty(p.get(field))):
            add('REQUIRED_TEXT', f'{field}: 문자열이 필요합니다.')
    if isinstance(p.get('id'), str) and p['id'] in UNSAFE_KEYS:
        add('UNSAFE_KEY', '프로젝트 ID는 객체 예약 키를 사용할 수 없습니다.')
    if not isinstance(p.get('assumptions'), list) or any(not isinstance(x, str) for x in p.get('assumptions', [])):
        add('ASSUMPTIONS', 'assumptions: 모델 가정 문자열 목록이 필요합니다.')
    units = {'distance': 'm', 'time': 's', 'mass': 'kg', 'energy': 'Wh', 'power': 'W'}
    if 'units' in p and (not isinstance(p['units'], dict) or any(units.get(k) != v for k, v in p['units'].items())):
        add('UNITS', '내부 단위는 m, s, kg, Wh, W만 지원합니다.')
    rows: dict[str, list[dict]] = {}
    global_ids: dict[str, str] = {}
    for field in ARRAY_FIELDS:
        if not isinstance(p.get(field), list):
            add('REQUIRED_ARRAY', f'{field}: 배열이 필요합니다.')
            rows[field] = []
            continue
        rows[field] = []
        for index, row in enumerate(p[field]):
            if not isinstance(row, dict):
                add('ENTITY_OBJECT', f'{field}[{index}]: 객체가 필요합니다.')
                continue
            rows[field].append(row)
            ident = row.get('id')
            if not nonempty(ident):
                add('ENTITY_ID', f'{field}[{index}]: 비어 있지 않은 ID가 필요합니다.')
            elif ident in UNSAFE_KEYS:
                add('UNSAFE_KEY', 'ID는 객체 예약 키를 사용할 수 없습니다.', ident)
            elif ident in global_ids:
                add('DUPLICATE_ID', f'중복 ID "{ident}" ({global_ids[ident]}, {field}).', ident)
            else:
                global_ids[ident] = field
            if field not in ('edges', 'disruptions') and not nonempty(row.get('name')):
                add('ENTITY_NAME', f'{field}: 이름이 필요합니다.', ident if isinstance(ident, str) else None)
    sets = {field: {row['id'] for row in items if nonempty(row.get('id'))} for field, items in rows.items()}

    def entity_id(row: dict) -> str | None:
        return row.get('id') if isinstance(row.get('id'), str) else None

    def number(row: dict, key: str, minimum: float = 0, integer: bool = False, exclusive: bool = False) -> None:
        v = row.get(key)
        if (not finite(v) or (v <= minimum if exclusive else v < minimum) or (integer and not safe_integer(v))):
            add('NUMBER_RANGE', f'{key}: {minimum} {"초과" if exclusive else "이상"}의 유한한 {"안전한 정수" if integer else "수"}가 필요합니다.', entity_id(row))

    def text(row: dict, key: str, safe: bool = False) -> None:
        if not nonempty(row.get(key)):
            add('REQUIRED_TEXT', f'{key}: 비어 있지 않은 문자열이 필요합니다.', entity_id(row))
        elif safe and row[key] in UNSAFE_KEYS:
            add('UNSAFE_KEY', f'{key}: 객체 예약 키를 사용할 수 없습니다.', entity_id(row))

    def reference(row: dict, key: str, field: str, optional: bool = False) -> None:
        if optional and key not in row:
            return
        if not nonempty(row.get(key)) or row[key] not in sets[field]:
            add('MISSING_REFERENCE', f'{key}: {field}의 "{row.get(key)}" 참조를 찾을 수 없습니다.', entity_id(row))

    def enum(row: dict, key: str, choices: tuple | list) -> None:
        if row.get(key) not in choices:
            add('ENUM_VALUE', f'{key}: {", ".join(choices)} 중 하나여야 합니다.', entity_id(row))

    def boolean(row: dict, key: str) -> None:
        if not isinstance(row.get(key), bool):
            add('BOOLEAN', f'{key}: true 또는 false가 필요합니다.', entity_id(row))

    def string_list(row: dict, key: str, refs: str | None = None) -> None:
        values = row.get(key)
        if not isinstance(values, list) or any(not nonempty(v) for v in values):
            add('STRING_LIST', f'{key}: 문자열 목록이 필요합니다.', entity_id(row))
        elif refs:
            for v in values:
                if v not in sets[refs]:
                    add('MISSING_REFERENCE', f'{key}: {refs}의 "{v}" 참조를 찾을 수 없습니다.', entity_id(row))

    def quantity_map(row: dict, key: str) -> None:
        if not isinstance(row.get(key), dict):
            add('QUANTITY_MAP', f'{key}: 품목별 수량 객체가 필요합니다.', entity_id(row))
            return
        for product, quantity in row[key].items():
            if not nonempty(product) or not safe_integer(quantity) or quantity < 0:
                add('QUANTITY_RANGE', f'{key}.{product}: 0 이상의 안전한 정수 수량이 필요합니다.', entity_id(row))
            if isinstance(product, str) and product in UNSAFE_KEYS:
                add('UNSAFE_KEY', '품목 이름은 객체 예약 키를 사용할 수 없습니다.', entity_id(row))

    for row in rows['nodes']:
        for key in ('x', 'y'):
            if not finite(row.get(key)):
                add('COORDINATE', f'{key}: 유한한 좌표가 필요합니다.', entity_id(row))
        enum(row, 'kind', ('transit', 'pickup', 'dropoff', 'wait', 'charge', 'intersection'))
        if 'floorId' in row and not nonempty(row['floorId']):
            add('FLOOR_ID', 'floorId는 비어 있지 않은 문자열이어야 합니다.', entity_id(row))
    for row in rows['edges']:
        reference(row, 'from', 'nodes'); reference(row, 'to', 'nodes')
        if row.get('from') == row.get('to'):
            add('SELF_EDGE', '출발 노드와 도착 노드는 달라야 합니다.', entity_id(row))
        for key in ('length', 'width', 'speedLimit'):
            number(row, key, exclusive=True)
        boolean(row, 'bidirectional')
        if 'disabled' in row:
            boolean(row, 'disabled')
        if 'zoneId' in row:
            text(row, 'zoneId', safe=True)
        if 'allowedRobotTypes' in row:
            string_list(row, 'allowedRobotTypes', 'robotTypes')
        duplicates = [other for other in rows['edges'] if other is not row and ((other.get('from') == row.get('to') and other.get('to') == row.get('from')) or (other.get('from') == row.get('from') and other.get('to') == row.get('to')))]
        if any(row.get('zoneId') != other.get('zoneId') for other in duplicates):
            add('OPPOSITE_ZONE', '동일 물리 통로에는 같은 zoneId를 사용하세요.', entity_id(row))
    for row in rows['objects']:
        enum(row, 'kind', ('rack', 'pallet', 'cart', 'line', 'buffer', 'wall', 'column', 'wait', 'charger'))
        for key in ('x', 'y', 'rotation'):
            if not finite(row.get(key)):
                add('COORDINATE', f'{key}: 유한한 값이 필요합니다.', entity_id(row))
        for key in ('width', 'height'):
            number(row, key, exclusive=True)
        reference(row, 'nodeId', 'nodes', True)
        if 'nodeId' not in row and row.get('kind') not in ('wall', 'column'):
            add('ACCESS_NODE', '운영 객체에 접근 노드가 없습니다.', entity_id(row), 'warning')
    for row in rows['buffers']:
        reference(row, 'nodeId', 'nodes'); number(row, 'capacity', integer=True, exclusive=True); quantity_map(row, 'initialInventory')
        inventory = row.get('initialInventory')
        if isinstance(inventory, dict) and all(finite(v) for v in inventory.values()) and finite(row.get('capacity')) and sum(inventory.values()) > row['capacity']:
            add('BUFFER_OVERFLOW', '초기 재고가 버퍼 용량을 초과합니다.', entity_id(row))
    for row in rows['robotTypes']:
        for key in ('width', 'length', 'maxPayloadKg', 'emptySpeed', 'loadedSpeed', 'acceleration', 'batteryCapacityWh'):
            number(row, key, exclusive=True)
        number(row, 'maxUnits', integer=True, exclusive=True)
        for key in ('turnTime', 'loadTime', 'unloadTime', 'idlePowerW', 'emptyPowerW', 'loadedPowerW', 'reserveWh', 'chargeBelowWh', 'chargeToWh'):
            number(row, key)
        string_list(row, 'cargoTypes')
        if all(finite(row.get(k)) for k in ('reserveWh', 'chargeBelowWh', 'chargeToWh', 'batteryCapacityWh')) and not row['reserveWh'] <= row['chargeBelowWh'] < row['chargeToWh'] <= row['batteryCapacityWh']:
            add('BATTERY_THRESHOLDS', 'reserveWh ≤ chargeBelowWh < chargeToWh ≤ batteryCapacityWh 조건이어야 합니다.', entity_id(row))
    for row in rows['robots']:
        reference(row, 'typeId', 'robotTypes'); reference(row, 'nodeId', 'nodes'); number(row, 'initialBatteryWh')
        robot_type = next((t for t in rows['robotTypes'] if t.get('id') == row.get('typeId')), None)
        if robot_type and finite(robot_type.get('batteryCapacityWh')) and finite(row.get('initialBatteryWh')) and row['initialBatteryWh'] > robot_type['batteryCapacityWh']:
            add('INITIAL_BATTERY', '초기 배터리가 배터리 용량을 초과합니다.', entity_id(row))
    for row in rows['chargers']:
        reference(row, 'nodeId', 'nodes'); number(row, 'capacity', integer=True, exclusive=True); number(row, 'waitingCapacity', integer=True)
        number(row, 'powerW', exclusive=True); number(row, 'dockTime'); number(row, 'undockTime'); string_list(row, 'compatibleTypes', 'robotTypes')
        if row.get('compatibleTypes') == []:
            add('CHARGER_COMPATIBILITY', '지원하는 로봇 유형이 없는 충전기입니다.', entity_id(row), 'warning')
    for row in rows['equipment']:
        number(row, 'capacity', integer=True, exclusive=True)
    for row in rows['processes']:
        reference(row, 'nodeId', 'nodes'); reference(row, 'inputBufferId', 'buffers', True); reference(row, 'outputBufferId', 'buffers'); reference(row, 'workerResourceId', 'equipment', True)
        quantity_map(row, 'inputRequirements'); text(row, 'outputProduct', True); number(row, 'outputQuantity', integer=True, exclusive=True); boolean(row, 'isFinal')
        if 'startAt' in row:
            number(row, 'startAt')
        if isinstance(row.get('inputRequirements'), dict) and any(finite(v) and v > 0 for v in row['inputRequirements'].values()) and 'inputBufferId' not in row:
            add('PROCESS_INPUT', '필요 부품이 있는 공정에는 inputBufferId가 필요합니다.', entity_id(row))
        out = next((b for b in rows['buffers'] if b.get('id') == row.get('outputBufferId')), None)
        if out and finite(out.get('capacity')) and finite(row.get('outputQuantity')) and row['outputQuantity'] > out['capacity']:
            add('PROCESS_BATCH', '공정 배출 수량이 출력 버퍼 용량을 초과합니다.', entity_id(row))
        for message in validate_distribution(row.get('processingTime')):
            add('DISTRIBUTION', message, entity_id(row))
        if isinstance(row.get('processingTime'), dict) and row['processingTime'].get('kind') == 'fixed' and row['processingTime'].get('value') == 0:
            add('ZERO_PROCESS_TIME', '0초 반복 생산은 같은 시각 무한 반복 감지에 걸릴 수 있습니다.', entity_id(row), 'warning')
    for row in rows['transportRules']:
        reference(row, 'sourceBufferId', 'buffers'); reference(row, 'destinationBufferId', 'buffers'); text(row, 'product', True)
        number(row, 'quantity', integer=True, exclusive=True); number(row, 'unitWeightKg'); number(row, 'priority')
        if 'dueAfter' in row:
            number(row, 'dueAfter')
        if row.get('sourceBufferId') == row.get('destinationBufferId'):
            add('SAME_BUFFER', '운송 출발 버퍼와 도착 버퍼는 달라야 합니다.', entity_id(row))
        for key in ('sourceBufferId', 'destinationBufferId'):
            buffer = next((b for b in rows['buffers'] if b.get('id') == row.get(key)), None)
            if buffer and finite(buffer.get('capacity')) and finite(row.get('quantity')) and row['quantity'] > buffer['capacity']:
                add('TRANSPORT_BATCH', '운송 수량이 버퍼 용량을 초과합니다.', entity_id(row))
    for row in rows['disruptions']:
        number(row, 'time'); number(row, 'duration', exclusive=True); enum(row, 'targetType', ('robot', 'process', 'charger', 'edge'))
        target_type = row.get('targetType')
        targets = {'robot': 'robots', 'process': 'processes', 'charger': 'chargers', 'edge': 'edges'}
        if isinstance(target_type, str) and target_type in targets:
            reference(row, 'targetId', targets[target_type])
    settings = p.get('settings')
    if not isinstance(settings, dict):
        add('SETTINGS', 'settings: 실행 조건 객체가 필요합니다.')
    else:
        number(settings, 'duration', exclusive=True); number(settings, 'warmup'); number(settings, 'seed', -2147483648, integer=True)
        enum(settings, 'dispatchPolicy', ('fifo', 'priority', 'nearest', 'earliestFinish'))
        if finite(settings.get('warmup')) and finite(settings.get('duration')) and settings['warmup'] >= settings['duration']:
            add('MEASUREMENT_WINDOW', 'warmup은 duration보다 작아야 합니다.')
    if 'background' in p:
        background = p['background']
        if not isinstance(background, dict):
            add('BACKGROUND', 'background는 이미지와 축척 객체여야 합니다.')
        else:
            if not isinstance(background.get('dataUrl'), str) or not background['dataUrl'].startswith(('data:image/png;base64,', 'data:image/jpeg;base64,')):
                add('BACKGROUND_FORMAT', '배경은 PNG/JPG data URL만 지원합니다.')
            for key in ('x', 'y'):
                if not finite(background.get(key)):
                    add('COORDINATE', f'background.{key}: 유한한 좌표가 필요합니다.')
            for key in ('width', 'height'):
                number(background, key, exclusive=True)
            number(background, 'opacity')
            if finite(background.get('opacity')) and background['opacity'] > 1:
                add('BACKGROUND_OPACITY', '배경 투명도는 0~1 범위여야 합니다.')
    if not any(issue['severity'] == 'error' for issue in issues):
        buffers = {b['id']: b for b in p['buffers']}
        nodes = {n['id']: n for n in p['nodes']}
        for edge in p['edges']:
            start, end = nodes[edge['from']], nodes[edge['to']]
            straight = math.hypot(start['x'] - end['x'], start['y'] - end['y'])
            if edge['length'] + 1e-6 < straight:
                add('EDGE_LENGTH', '구간 길이가 지도상 직선거리보다 짧습니다. 도면 축척 또는 실제 이동 길이를 확인하세요.', edge['id'], 'warning')
            if start.get('floorId', '1') != end.get('floorId', '1'):
                add('CROSS_FLOOR', '층간 연결은 가상 경로입니다. 엘리베이터 상세 동작은 지원하지 않습니다.', edge['id'], 'warning')
        for charger in p['chargers']:
            if nodes[charger['nodeId']]['kind'] != 'charge':
                add('CHARGER_NODE_KIND', '충전기의 접근 노드 용도를 charge로 지정하는 것을 권장합니다.', charger['id'], 'warning')
        for rule in p['transportRules']:
            types = [t for t in p['robotTypes'] if t['maxUnits'] >= rule['quantity'] and t['maxPayloadKg'] >= rule['quantity'] * rule['unitWeightKg'] and (rule['product'] in t['cargoTypes'] or '*' in t['cargoTypes'])]
            if not types:
                add('NO_CAPABLE_ROBOT', f'"{rule["name"]}"의 품목·중량·수량을 만족하는 로봇 유형이 없습니다.', rule['id'])
            elif not any(find_route(p, buffers[rule['sourceBufferId']]['nodeId'], buffers[rule['destinationBufferId']]['nodeId'], t, True) for t in types):
                add('NO_ROUTE', f'"{rule["name"]}"의 출발지와 목적지를 연결하는 통행 가능한 경로가 없습니다.', rule['id'])
        type_map = {t['id']: t for t in p['robotTypes']}
        for robot in p['robots']:
            compatible = [c for c in p['chargers'] if robot['typeId'] in c['compatibleTypes']]
            if not compatible:
                add('NO_CHARGER', f'"{robot["name"]}"과 호환되는 충전기가 없습니다.', robot['id'], 'warning')
            elif not any(find_route(p, robot['nodeId'], c['nodeId'], type_map[robot['typeId']]) for c in compatible):
                add('CHARGER_UNREACHABLE', f'"{robot["name"]}"의 초기 위치에서 접근 가능한 충전기가 없습니다.', robot['id'], 'warning')
        if not p['nodes']:
            add('EMPTY_MAP', '지도에 이동 노드가 없습니다.', severity='warning')
        if not p['robots'] and p['transportRules']:
            add('NO_ROBOTS', '운송 규칙이 있지만 등록된 로봇이 없습니다.', severity='warning')
        def bounds(obj: dict) -> tuple[float, float]:
            angle = math.radians(obj['rotation'])
            return (abs(math.cos(angle)) * obj['width'] + abs(math.sin(angle)) * obj['height'],
                    abs(math.sin(angle)) * obj['width'] + abs(math.cos(angle)) * obj['height'])
        for index, first in enumerate(p['objects']):
            width_a, height_a = bounds(first)
            for second in p['objects'][index + 1:]:
                width_b, height_b = bounds(second)
                if abs(first['x'] - second['x']) < (width_a + width_b) / 2 and abs(first['y'] - second['y']) < (height_a + height_b) / 2:
                    add('OBJECT_OVERLAP', f'"{first["name"]}"과 "{second["name"]}"의 외곽 영역이 겹칩니다. 배치 검토가 필요합니다.', first['id'], 'warning')
            if first['kind'] in ('wall', 'column'):
                for node in p['nodes']:
                    if abs(node['x'] - first['x']) < width_a / 2 and abs(node['y'] - first['y']) < height_a / 2:
                        add('NODE_IN_OBSTACLE', f'"{node["name"]}" 노드가 "{first["name"]}" 외곽 영역 안에 있습니다.', node['id'], 'warning')
    return issues


def parse_project(value: Any) -> dict:
    errors = [issue for issue in validate_project(value) if issue['severity'] == 'error']
    if errors:
        raise ValueError('\n'.join(f'{issue["code"]}: {issue["message"]}' for issue in errors))
    return deepcopy(value)


def create_random(seed: int, stream: str) -> random.Random:
    if not safe_integer(seed):
        raise ValueError('난수 시드는 안전한 정수여야 합니다.')
    digest = hashlib.sha256(f'{int(seed)}:{stream}'.encode('utf-8')).digest()
    return random.Random(int.from_bytes(digest, 'big'))


def sample_distribution(distribution: dict, rng: random.Random | Callable[[], float]) -> float:
    errors = validate_distribution(distribution)
    if errors:
        raise ValueError('\n'.join(errors))
    source = rng.random if hasattr(rng, 'random') else rng

    def draw() -> float:
        value = source()
        if not finite(value) or not 0 <= value < 1:
            raise ValueError('난수 생성기는 [0, 1) 값을 반환해야 합니다.')
        return value

    def normal() -> float:
        return math.sqrt(-2 * math.log1p(-draw())) * math.cos(2 * math.pi * draw())

    d = distribution
    kind = d['kind']
    if kind == 'fixed':
        result = d['value']
    elif kind == 'uniform':
        result = d['min'] + (d['max'] - d['min']) * draw()
    elif kind == 'triangular':
        lower, mode, upper = d['min'], d['mode'], d['max']
        if lower == upper:
            return lower
        u = draw()
        result = lower + math.sqrt(u * (upper - lower) * (mode - lower)) if u < (mode - lower) / (upper - lower) else upper - math.sqrt((1 - u) * (upper - lower) * (upper - mode))
    elif kind == 'normal':
        if d['sd'] == 0:
            return d['mean']
        if d['min'] == d['max']:
            return d['min']
        for _ in range(10000):
            result = d['mean'] + d['sd'] * normal()
            if d['min'] <= result <= d['max']:
                break
        else:
            raise ValueError('절단 정규분포 추출 한도 초과: 평균·표준편차·절단 범위를 검토하세요.')
    elif kind == 'lognormal':
        try:
            result = math.exp(d['mu'] + d['sigma'] * normal())
        except OverflowError as error:
            raise ValueError('로그정규분포 결과가 수치 범위를 초과합니다.') from error
    elif kind == 'exponential':
        result = -d['mean'] * math.log1p(-draw())
    elif kind == 'empirical':
        result = d['values'][int(draw() * len(d['values']))]
    else:
        raise ValueError('지원하지 않는 분포입니다.')
    if not finite(result) or result < 0:
        raise ValueError('분포 결과는 유한한 비음수여야 합니다.')
    return result
