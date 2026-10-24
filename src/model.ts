import type { Distribution, Project, ValidationIssue } from "./types";
import { findRoute } from "./routing";
import { validateSpacePlan } from "./planning";

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;
const safeKey = (value: string) =>
  value !== "prototype" && !Object.hasOwn(Object.prototype, value);
const arrayFields = [
  "nodes",
  "edges",
  "objects",
  "buffers",
  "robotTypes",
  "robots",
  "chargers",
  "processes",
  "transportRules",
  "equipment",
  "disruptions",
] as const;

/** Validate untrusted JSON before either renderer or engine uses it. Never mutates input. */
export function validateProject(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (
    code: string,
    message: string,
    entityId?: string,
    severity: "error" | "warning" = "error",
  ) =>
    issues.push({ severity, code, message, ...(entityId ? { entityId } : {}) });
  if (!record(input))
    return [
      {
        severity: "error",
        code: "PROJECT_OBJECT",
        message: "프로젝트는 JSON 객체여야 합니다.",
      },
    ];
  const p = input;
  if (
    p.customerName !== undefined &&
    (!nonempty(p.customerName) || p.customerName.trim().length > 120)
  )
    add("CUSTOMER_NAME", "고객 이름은 1~120자로 입력하세요.");
  if (p.spacePlan !== undefined) issues.push(...validateSpacePlan(p.spacePlan));
  if (p.schemaVersion !== "1.0")
    add("SCHEMA_VERSION", '지원하는 schemaVersion은 "1.0"입니다.');
  for (const field of ["id", "name", "description", "modelVersion"]) {
    if (
      typeof p[field] !== "string" ||
      (field !== "description" && !nonempty(p[field]))
    )
      add("REQUIRED_TEXT", `${field}: 문자열이 필요합니다.`);
  }
  if (nonempty(p.id) && !safeKey(p.id))
    add("UNSAFE_KEY", "프로젝트 ID는 객체 예약 키를 사용할 수 없습니다.");
  if (
    !Array.isArray(p.assumptions) ||
    p.assumptions.some((v) => typeof v !== "string")
  )
    add("ASSUMPTIONS", "assumptions: 모델 가정 문자열 목록이 필요합니다.");
  const units: Record<string, string> = {
    distance: "m",
    time: "s",
    mass: "kg",
    energy: "Wh",
    power: "W",
  };
  if (
    p.units !== undefined &&
    (!record(p.units) ||
      Object.entries(p.units).some(([k, v]) => units[k] !== v))
  )
    add(
      "UNITS",
      "내부 단위는 m, s, kg, Wh, W만 지원합니다. 입력 전에 변환하세요.",
    );
  const rows: Record<string, Record<string, unknown>[]> = {};
  const globalIds = new Map<string, string>();
  for (const field of arrayFields) {
    const value = p[field];
    if (!Array.isArray(value)) {
      add("REQUIRED_ARRAY", `${field}: 배열이 필요합니다.`);
      rows[field] = [];
      continue;
    }
    rows[field] = [];
    value.forEach((item, index) => {
      if (!record(item)) {
        add("ENTITY_OBJECT", `${field}[${index}]: 객체가 필요합니다.`);
        return;
      }
      rows[field].push(item);
      if (!nonempty(item.id))
        add("ENTITY_ID", `${field}[${index}]: 비어 있지 않은 ID가 필요합니다.`);
      else if (!safeKey(item.id))
        add("UNSAFE_KEY", "ID는 객체 예약 키를 사용할 수 없습니다.", item.id);
      else if (globalIds.has(item.id))
        add(
          "DUPLICATE_ID",
          `중복 ID "${item.id}" (${globalIds.get(item.id)}, ${field}).`,
          item.id,
        );
      else globalIds.set(item.id, field);
      if (field !== "edges" && field !== "disruptions" && !nonempty(item.name))
        add(
          "ENTITY_NAME",
          `${field}: 이름이 필요합니다.`,
          typeof item.id === "string" ? item.id : undefined,
        );
    });
  }
  const idOf = (v: Record<string, unknown>) =>
    typeof v.id === "string" ? v.id : undefined;
  const num = (
    r: Record<string, unknown>,
    key: string,
    min: number,
    integer = false,
    exclusive = false,
  ) => {
    const v = r[key];
    if (
      !finite(v) ||
      (exclusive ? v <= min : v < min) ||
      (integer && !Number.isSafeInteger(v))
    )
      add(
        "NUMBER_RANGE",
        `${key}: ${exclusive ? min + " 초과" : min + " 이상"}의 유한한 ${integer ? "안전한 정수" : "수"}가 필요합니다.`,
        idOf(r),
      );
  };
  const text = (r: Record<string, unknown>, key: string) => {
    if (!nonempty(r[key]))
      add(
        "REQUIRED_TEXT",
        `${key}: 비어 있지 않은 문자열이 필요합니다.`,
        idOf(r),
      );
  };
  const setOf = (field: string) =>
    new Set(rows[field].map((r) => r.id).filter(nonempty));
  const sets = Object.fromEntries(arrayFields.map((f) => [f, setOf(f)]));
  const reference = (
    r: Record<string, unknown>,
    key: string,
    field: string,
    optional = false,
  ) => {
    if (optional && r[key] === undefined) return;
    if (!nonempty(r[key]) || !sets[field].has(r[key] as string))
      add(
        "MISSING_REFERENCE",
        `${key}: ${field}의 "${String(r[key])}" 참조를 찾을 수 없습니다.`,
        idOf(r),
      );
  };
  const quantityMap = (r: Record<string, unknown>, key: string) => {
    const value = r[key];
    if (!record(value)) {
      add("QUANTITY_MAP", `${key}: 품목별 수량 객체가 필요합니다.`, idOf(r));
      return;
    }
    for (const [product, quantity] of Object.entries(value)) {
      if (
        !nonempty(product) ||
        !finite(quantity) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 0
      )
        add(
          "QUANTITY_RANGE",
          `${key}.${product}: 0 이상의 안전한 정수 수량이 필요합니다.`,
          idOf(r),
        );
      if (!safeKey(product))
        add(
          "UNSAFE_KEY",
          "품목 이름은 객체 예약 키를 사용할 수 없습니다.",
          idOf(r),
        );
    }
  };
  const enumValue = (
    r: Record<string, unknown>,
    key: string,
    allowed: string[],
  ) => {
    if (!allowed.includes(String(r[key])))
      add(
        "ENUM_VALUE",
        `${key}: ${allowed.join(", ")} 중 하나여야 합니다.`,
        idOf(r),
      );
  };
  const bool = (r: Record<string, unknown>, key: string) => {
    if (typeof r[key] !== "boolean")
      add("BOOLEAN", `${key}: true 또는 false가 필요합니다.`, idOf(r));
  };
  const stringList = (
    r: Record<string, unknown>,
    key: string,
    refs?: string,
  ) => {
    const value = r[key];
    if (!Array.isArray(value) || value.some((v) => !nonempty(v))) {
      add("STRING_LIST", `${key}: 문자열 목록이 필요합니다.`, idOf(r));
      return;
    }
    if (refs)
      value.forEach((v) => {
        if (!sets[refs].has(v))
          add(
            "MISSING_REFERENCE",
            `${key}: ${refs}의 "${v}" 참조를 찾을 수 없습니다.`,
            idOf(r),
          );
      });
  };
  for (const n of rows.nodes) {
    for (const key of ["x", "y"])
      if (!finite(n[key]))
        add("COORDINATE", `${key}: 유한한 좌표가 필요합니다.`, idOf(n));
    enumValue(n, "kind", [
      "transit",
      "pickup",
      "dropoff",
      "wait",
      "charge",
      "intersection",
    ]);
    if (n.floorId !== undefined && !nonempty(n.floorId))
      add("FLOOR_ID", "floorId는 비어 있지 않은 문자열이어야 합니다.", idOf(n));
  }
  for (const e of rows.edges) {
    reference(e, "from", "nodes");
    reference(e, "to", "nodes");
    if (e.from === e.to)
      add(
        "SELF_EDGE",
        "연결 구간의 출발 노드와 도착 노드는 달라야 합니다.",
        idOf(e),
      );
    for (const key of ["length", "width", "speedLimit"])
      num(e, key, 0, false, true);
    bool(e, "bidirectional");
    if (e.disabled !== undefined) bool(e, "disabled");
    if (e.zoneId !== undefined && !nonempty(e.zoneId))
      add("ZONE_ID", "zoneId는 비어 있지 않은 문자열이어야 합니다.", idOf(e));
    if (nonempty(e.zoneId) && !safeKey(e.zoneId))
      add("UNSAFE_KEY", "zoneId는 객체 예약 키를 사용할 수 없습니다.", idOf(e));
    if (e.allowedRobotTypes !== undefined)
      stringList(e, "allowedRobotTypes", "robotTypes");
    const a = rows.nodes.find((n) => n.id === e.from),
      b = rows.nodes.find((n) => n.id === e.to);
    if (a && b && [a.x, a.y, b.x, b.y, e.length].every(finite)) {
      const straight = Math.hypot(
        (a.x as number) - (b.x as number),
        (a.y as number) - (b.y as number),
      );
      if ((e.length as number) + 1e-6 < straight)
        add(
          "EDGE_LENGTH",
          "구간 길이가 지도상 직선거리보다 짧습니다. 도면 축척 또는 이동 길이를 확인하세요.",
          idOf(e),
          "warning",
        );
      if ((a.floorId ?? "1") !== (b.floorId ?? "1"))
        add(
          "CROSS_FLOOR",
          "층간 연결은 가상 경로입니다. 엘리베이터 상세 동작은 지원하지 않습니다.",
          idOf(e),
          "warning",
        );
    }
    const duplicates = rows.edges.filter(
      (other) =>
        other !== e &&
        ((other.from === e.to && other.to === e.from) ||
          (other.from === e.from && other.to === e.to)),
    );
    if (duplicates.some((other) => e.zoneId !== other.zoneId))
      add(
        "OPPOSITE_ZONE",
        "동일 물리 통로의 연결과 zoneId가 다릅니다. 같은 물리 통로에는 같은 zoneId를 사용하세요.",
        idOf(e),
      );
  }
  for (const o of rows.objects) {
    enumValue(o, "kind", [
      "rack",
      "pallet",
      "cart",
      "line",
      "buffer",
      "wall",
      "column",
      "wait",
      "charger",
    ]);
    for (const key of ["x", "y", "rotation"])
      if (!finite(o[key]))
        add("COORDINATE", `${key}: 유한한 수가 필요합니다.`, idOf(o));
    for (const key of ["width", "height"]) num(o, key, 0, false, true);
    reference(o, "nodeId", "nodes", true);
    if (o.nodeId === undefined && !["wall", "column"].includes(String(o.kind)))
      add(
        "ACCESS_NODE",
        "운영 객체에 접근 노드가 없습니다.",
        idOf(o),
        "warning",
      );
  }
  for (const b of rows.buffers) {
    reference(b, "nodeId", "nodes");
    num(b, "capacity", 0, true, true);
    quantityMap(b, "initialInventory");
    if (
      record(b.initialInventory) &&
      Object.values(b.initialInventory).every(finite) &&
      finite(b.capacity) &&
      (Object.values(b.initialInventory) as number[]).reduce(
        (sum, v) => sum + v,
        0,
      ) > b.capacity
    )
      add("BUFFER_OVERFLOW", "초기 재고가 버퍼 용량을 초과합니다.", idOf(b));
  }
  for (const t of rows.robotTypes) {
    for (const key of [
      "width",
      "length",
      "maxPayloadKg",
      "emptySpeed",
      "loadedSpeed",
      "acceleration",
      "batteryCapacityWh",
    ])
      num(t, key, 0, false, true);
    num(t, "maxUnits", 0, true, true);
    for (const key of [
      "turnTime",
      "loadTime",
      "unloadTime",
      "idlePowerW",
      "emptyPowerW",
      "loadedPowerW",
      "reserveWh",
      "chargeBelowWh",
      "chargeToWh",
    ])
      num(t, key, 0);
    stringList(t, "cargoTypes");
    if (
      [t.reserveWh, t.chargeBelowWh, t.chargeToWh, t.batteryCapacityWh].every(
        finite,
      ) &&
      !(
        (t.reserveWh as number) <= (t.chargeBelowWh as number) &&
        (t.chargeBelowWh as number) < (t.chargeToWh as number) &&
        (t.chargeToWh as number) <= (t.batteryCapacityWh as number)
      )
    )
      add(
        "BATTERY_THRESHOLDS",
        "배터리는 reserveWh ≤ chargeBelowWh < chargeToWh ≤ batteryCapacityWh 조건이어야 합니다.",
        idOf(t),
      );
  }
  for (const r of rows.robots) {
    reference(r, "typeId", "robotTypes");
    reference(r, "nodeId", "nodes");
    num(r, "initialBatteryWh", 0);
    const type = rows.robotTypes.find((t) => t.id === r.typeId);
    if (
      type &&
      finite(type.batteryCapacityWh) &&
      finite(r.initialBatteryWh) &&
      r.initialBatteryWh > type.batteryCapacityWh
    )
      add(
        "INITIAL_BATTERY",
        "초기 배터리가 배터리 용량을 초과합니다.",
        idOf(r),
      );
  }
  for (const c of rows.chargers) {
    reference(c, "nodeId", "nodes");
    num(c, "capacity", 0, true, true);
    num(c, "waitingCapacity", 0, true);
    num(c, "powerW", 0, false, true);
    num(c, "dockTime", 0);
    num(c, "undockTime", 0);
    stringList(c, "compatibleTypes", "robotTypes");
    if (Array.isArray(c.compatibleTypes) && c.compatibleTypes.length === 0)
      add(
        "CHARGER_COMPATIBILITY",
        "지원하는 로봇 유형이 없는 충전기입니다.",
        idOf(c),
        "warning",
      );
    const node = rows.nodes.find((n) => n.id === c.nodeId);
    if (node && node.kind !== "charge")
      add(
        "CHARGER_NODE_KIND",
        "충전기의 접근 노드 용도를 charge로 지정하는 것을 권장합니다.",
        idOf(c),
        "warning",
      );
  }
  for (const e of rows.equipment) num(e, "capacity", 0, true, true);
  for (const process of rows.processes) {
    reference(process, "nodeId", "nodes");
    reference(process, "inputBufferId", "buffers", true);
    reference(process, "outputBufferId", "buffers");
    reference(process, "workerResourceId", "equipment", true);
    quantityMap(process, "inputRequirements");
    text(process, "outputProduct");
    num(process, "outputQuantity", 0, true, true);
    bool(process, "isFinal");
    if (nonempty(process.outputProduct) && !safeKey(process.outputProduct))
      add(
        "UNSAFE_KEY",
        "품목 이름은 객체 예약 키를 사용할 수 없습니다.",
        idOf(process),
      );
    if (process.startAt !== undefined) num(process, "startAt", 0);
    if (
      record(process.inputRequirements) &&
      Object.values(process.inputRequirements).some(
        (v) => finite(v) && v > 0,
      ) &&
      process.inputBufferId === undefined
    )
      add(
        "PROCESS_INPUT",
        "필요 부품이 있는 공정에는 inputBufferId가 필요합니다.",
        idOf(process),
      );
    const out = rows.buffers.find((b) => b.id === process.outputBufferId);
    if (
      out &&
      finite(out.capacity) &&
      finite(process.outputQuantity) &&
      process.outputQuantity > out.capacity
    )
      add(
        "PROCESS_BATCH",
        "공정 배출 수량이 출력 버퍼 용량을 초과합니다.",
        idOf(process),
      );
    const before = issues.length;
    validateDistribution(process.processingTime, add, idOf(process));
    if (
      before === issues.length &&
      record(process.processingTime) &&
      process.processingTime.kind === "fixed" &&
      process.processingTime.value === 0
    )
      add(
        "ZERO_PROCESS_TIME",
        "0초 반복 생산은 같은 시각 무한 반복 감지에 걸릴 수 있습니다.",
        idOf(process),
        "warning",
      );
  }
  for (const rule of rows.transportRules) {
    reference(rule, "sourceBufferId", "buffers");
    reference(rule, "destinationBufferId", "buffers");
    text(rule, "product");
    num(rule, "quantity", 0, true, true);
    num(rule, "unitWeightKg", 0);
    num(rule, "priority", 0);
    if (nonempty(rule.product) && !safeKey(rule.product))
      add(
        "UNSAFE_KEY",
        "품목 이름은 객체 예약 키를 사용할 수 없습니다.",
        idOf(rule),
      );
    if (rule.dueAfter !== undefined) num(rule, "dueAfter", 0);
    if (rule.sourceBufferId === rule.destinationBufferId)
      add(
        "SAME_BUFFER",
        "운송 출발 버퍼와 도착 버퍼는 달라야 합니다.",
        idOf(rule),
      );
    const destination = rows.buffers.find(
      (b) => b.id === rule.destinationBufferId,
    );
    if (
      destination &&
      finite(destination.capacity) &&
      finite(rule.quantity) &&
      rule.quantity > destination.capacity
    )
      add(
        "TRANSPORT_BATCH",
        "운송 수량이 도착 버퍼의 용량을 초과합니다.",
        idOf(rule),
      );
    const source = rows.buffers.find((b) => b.id === rule.sourceBufferId);
    if (
      source &&
      finite(source.capacity) &&
      finite(rule.quantity) &&
      rule.quantity > source.capacity
    )
      add(
        "TRANSPORT_BATCH",
        "운송 수량이 출발 버퍼의 용량을 초과합니다.",
        idOf(rule),
      );
  }
  for (const d of rows.disruptions) {
    num(d, "time", 0);
    num(d, "duration", 0, false, true);
    enumValue(d, "targetType", ["robot", "process", "charger", "edge"]);
    const field = (
      {
        robot: "robots",
        process: "processes",
        charger: "chargers",
        edge: "edges",
      } as Record<string, string>
    )[String(d.targetType)];
    if (field) reference(d, "targetId", field);
  }
  if (!record(p.settings))
    add("SETTINGS", "settings: 실행 조건 객체가 필요합니다.");
  else {
    num(p.settings, "duration", 0, false, true);
    num(p.settings, "warmup", 0);
    num(p.settings, "seed", -2147483648, true);
    if (finite(p.settings.seed) && !Number.isSafeInteger(p.settings.seed))
      add("SEED_RANGE", "난수 시드는 안전한 정수여야 합니다.");
    enumValue(p.settings, "dispatchPolicy", [
      "fifo",
      "priority",
      "nearest",
      "earliestFinish",
    ]);
    if (
      finite(p.settings.warmup) &&
      finite(p.settings.duration) &&
      p.settings.warmup >= p.settings.duration
    )
      add("MEASUREMENT_WINDOW", "warmup은 duration보다 작아야 합니다.");
  }
  if (p.background !== undefined) {
    if (!record(p.background))
      add("BACKGROUND", "background는 이미지와 축척 객체여야 합니다.");
    else {
      if (
        typeof p.background.dataUrl !== "string" ||
        !/^data:image\/(png|jpeg);base64,/.test(p.background.dataUrl)
      )
        add("BACKGROUND_FORMAT", "배경은 PNG/JPG data URL만 지원합니다.");
      for (const key of ["x", "y"])
        if (!finite(p.background[key]))
          add("COORDINATE", `background.${key}: 유한한 좌표가 필요합니다.`);
      for (const key of ["width", "height"])
        num(p.background, key, 0, false, true);
      num(p.background, "opacity", 0);
      if (finite(p.background.opacity) && p.background.opacity > 1)
        add("BACKGROUND_OPACITY", "배경 투명도는 0~1 범위여야 합니다.");
    }
  }
  // Only apply graph/geometric checks after structural checks. No unchecked JSON reaches the router.
  if (!issues.some((i) => i.severity === "error")) {
    const project = p as unknown as Project;
    if (project.nodes.length === 0)
      add("EMPTY_MAP", "지도에 이동 노드가 없습니다.", undefined, "warning");
    if (project.robots.length === 0 && project.transportRules.length > 0)
      add(
        "NO_ROBOTS",
        "운송 규칙이 있지만 등록된 로봇이 없습니다.",
        undefined,
        "warning",
      );
    for (const rule of project.transportRules) {
      const source = project.buffers.find((b) => b.id === rule.sourceBufferId)!;
      const destination = project.buffers.find(
        (b) => b.id === rule.destinationBufferId,
      )!;
      const types = project.robotTypes.filter(
        (t) =>
          t.maxUnits >= rule.quantity &&
          t.maxPayloadKg >= rule.unitWeightKg * rule.quantity &&
          (t.cargoTypes.includes(rule.product) || t.cargoTypes.includes("*")),
      );
      if (types.length === 0)
        add(
          "NO_CAPABLE_ROBOT",
          `"${rule.name}"의 품목·중량·수량 조건을 만족하는 로봇 유형이 없습니다.`,
          rule.id,
        );
      else if (
        !types.some((t) =>
          findRoute(project, source.nodeId, destination.nodeId, t, true),
        )
      )
        add(
          "NO_ROUTE",
          `"${rule.name}"의 출발지와 목적지를 연결하는 통행 가능한 경로가 없습니다. 통로 폭·방향·허용 유형을 확인하세요.`,
          rule.id,
        );
    }
    for (const robot of project.robots) {
      const t = project.robotTypes.find((t) => t.id === robot.typeId)!;
      const compatible = project.chargers.filter((c) =>
        c.compatibleTypes.includes(t.id),
      );
      if (!compatible.length)
        add(
          "NO_CHARGER",
          `"${robot.name}"과 호환되는 충전기가 없습니다.`,
          robot.id,
          "warning",
        );
      else if (
        !compatible.some((c) => findRoute(project, robot.nodeId, c.nodeId, t))
      )
        add(
          "CHARGER_UNREACHABLE",
          `"${robot.name}"의 초기 위치에서 접근 가능한 충전기가 없습니다.`,
          robot.id,
          "warning",
        );
    }
    for (let i = 0; i < project.objects.length; i++)
      for (let j = i + 1; j < project.objects.length; j++) {
        const a = project.objects[i],
          b = project.objects[j];
        // Rotation-aware enclosing rectangles are intentionally conservative: a review warning, not a collision certificate.
        const aBox = box(a),
          bBox = box(b);
        if (
          Math.abs(a.x - b.x) < (aBox.w + bBox.w) / 2 &&
          Math.abs(a.y - b.y) < (aBox.h + bBox.h) / 2
        )
          add(
            "OBJECT_OVERLAP",
            `"${a.name}"과 "${b.name}"의 외곽 영역이 겹칩니다. 배치 검토가 필요합니다.`,
            a.id,
            "warning",
          );
      }
    for (const obstacle of project.objects.filter((o) =>
      ["wall", "column"].includes(o.kind),
    )) {
      const bounds = box(obstacle);
      for (const node of project.nodes)
        if (
          Math.abs(node.x - obstacle.x) < bounds.w / 2 &&
          Math.abs(node.y - obstacle.y) < bounds.h / 2
        )
          add(
            "NODE_IN_OBSTACLE",
            `"${node.name}" 노드가 "${obstacle.name}" 외곽 영역 안에 있습니다.`,
            node.id,
            "warning",
          );
    }
  }
  return issues;
}

function box(o: { width: number; height: number; rotation: number }) {
  const rad = (o.rotation * Math.PI) / 180;
  return {
    w: Math.abs(Math.cos(rad)) * o.width + Math.abs(Math.sin(rad)) * o.height,
    h: Math.abs(Math.sin(rad)) * o.width + Math.abs(Math.cos(rad)) * o.height,
  };
}

type AddIssue = (
  code: string,
  message: string,
  entityId?: string,
  severity?: "error" | "warning",
) => void;
function validateDistribution(input: unknown, add: AddIssue, id?: string) {
  if (!record(input)) {
    add("DISTRIBUTION", "processingTime: 분포 객체가 필요합니다.", id);
    return;
  }
  const d = input;
  const positive = (key: string, allowZero = true) => {
    if (
      !finite(d[key]) ||
      (allowZero ? (d[key] as number) < 0 : (d[key] as number) <= 0)
    )
      add(
        "DISTRIBUTION_RANGE",
        `${d.kind}.${key}: ${allowZero ? "0 이상" : "0 초과"}의 유한한 값이 필요합니다. 시간 단위는 초입니다.`,
        id,
      );
  };
  switch (d.kind) {
    case "fixed":
      positive("value");
      break;
    case "uniform":
      positive("min");
      positive("max");
      if (finite(d.min) && finite(d.max) && d.min > d.max)
        add("DISTRIBUTION_ORDER", "균등분포 min ≤ max 조건이 필요합니다.", id);
      break;
    case "triangular":
      positive("min");
      positive("mode");
      positive("max");
      if (
        [d.min, d.mode, d.max].every(finite) &&
        !(
          (d.min as number) <= (d.mode as number) &&
          (d.mode as number) <= (d.max as number)
        )
      )
        add(
          "DISTRIBUTION_ORDER",
          "삼각분포 min ≤ mode ≤ max 조건이 필요합니다.",
          id,
        );
      break;
    case "normal":
      if (!finite(d.mean))
        add(
          "DISTRIBUTION_RANGE",
          "절단 정규분포 평균은 유한한 값이어야 합니다.",
          id,
        );
      positive("sd");
      positive("min");
      positive("max");
      if (finite(d.min) && finite(d.max) && d.min > d.max)
        add(
          "DISTRIBUTION_ORDER",
          "절단 정규분포 min ≤ max 조건이 필요합니다.",
          id,
        );
      if (
        d.sd === 0 &&
        finite(d.mean) &&
        finite(d.min) &&
        finite(d.max) &&
        (d.mean < d.min || d.mean > d.max)
      )
        add(
          "DISTRIBUTION_DEGENERATE",
          "표준편차가 0일 때 평균은 절단 구간 안에 있어야 합니다.",
          id,
        );
      break;
    case "lognormal":
      if (!finite(d.mu))
        add(
          "DISTRIBUTION_RANGE",
          "로그정규분포 mu는 로그 공간의 유한한 평균이어야 합니다.",
          id,
        );
      positive("sigma");
      if (finite(d.mu) && finite(d.sigma) && d.mu + 8 * d.sigma > 700)
        add(
          "DISTRIBUTION_OVERFLOW",
          "로그정규분포 매개변수가 수치 범위를 초과할 수 있습니다.",
          id,
        );
      break;
    case "exponential":
      positive("mean", false);
      break;
    case "empirical":
      if (
        !Array.isArray(d.values) ||
        !d.values.length ||
        d.values.some((v) => !finite(v) || v < 0)
      )
        add(
          "DISTRIBUTION_SAMPLES",
          "실측 샘플은 0 이상의 유한한 초 단위 값으로 구성된 비어 있지 않은 배열이어야 합니다.",
          id,
        );
      break;
    default:
      add("DISTRIBUTION_KIND", "지원하지 않는 분포 종류입니다.", id);
  }
}

export function parseProject(input: unknown): Project {
  const errors = validateProject(input).filter((i) => i.severity === "error");
  if (errors.length)
    throw new Error(
      errors
        .map((i) => `${i.entityId ? `[${i.entityId}] ` : ""}${i.message}`)
        .join("\n"),
    );
  return cloneProject(input as Project);
}

export function cloneProject(project: Project): Project {
  return structuredClone(project);
}

// Kept visible to consumers documenting the exact supported family of process-time inputs.
export type { Distribution };
