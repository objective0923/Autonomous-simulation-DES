import type { Project, RobotType } from "./types";

export const STANDARD_AMR: RobotType = {
  id: "type-pallet",
  name: "팔레트 AMR · 300 kg",
  width: 0.85,
  length: 1.15,
  maxPayloadKg: 300,
  maxUnits: 4,
  cargoTypes: ["A", "B", "F"],
  emptySpeed: 1.4,
  loadedSpeed: 1,
  acceleration: 0.7,
  turnTime: 1.5,
  loadTime: 8,
  unloadTime: 6,
  batteryCapacityWh: 240,
  idlePowerW: 20,
  emptyPowerW: 300,
  loadedPowerW: 500,
  reserveWh: 18,
  chargeBelowWh: 65,
  chargeToWh: 210,
};

/** All numbers are illustrative test assumptions, not calibrated factory data. */
export function createExampleProject(): Project {
  return {
    schemaVersion: "1.0",
    id: "crois-demo",
    name: "CROIS 조립·출하 라인",
    modelVersion: "0.1.0",
    description:
      "A 부품 2개와 B 부품 1개를 조립하여 완제품 F를 출하 창고로 이송합니다. 2대의 AMR이 중앙 공유 통로와 충전기 1기를 함께 사용합니다.",
    assumptions: [
      "예시 수치는 기능 검증용 가정이며 실측 보정 결과가 아닙니다.",
      "단위: 거리 m, 시간 s, 질량 kg, 에너지 Wh, 출력 W. 모든 층은 동일 평면입니다.",
      "공정은 출력 공간을 먼저 예약한 뒤 부품을 소비합니다. 출력 공간 부족 시 생산 시작을 기다립니다.",
      "운송은 출발 재고와 도착 공간을 예약합니다. 실제 재고는 상차·하차 완료 시에만 이동합니다.",
      "이동은 정지-출발 구간별 가감속과 중간 노드 회전 여유시간을 포함합니다. 경로 통과 여부는 차체 폭 기준입니다.",
      "교통은 경로 전체의 통로·교차로를 원자적으로 예약하는 보수적 방식입니다. 실제 차체 충돌·안전 성능 검증이 아닙니다.",
      "지도 객체는 배치 표현입니다. 벽·기둥 회피는 사용자가 통행 노드와 연결을 구성해야 합니다.",
      "충전은 일정 출력이며 충전 곡선·충전 손실·배터리 노화는 모델링하지 않습니다.",
      "운송용기는 수량으로 집계하며 개별 팔레트 식별·반납 순환은 후속 범위입니다.",
    ],
    nodes: [
      {
        id: "n-a",
        name: "A 부품 배출",
        x: 4,
        y: 4,
        kind: "pickup",
        floorId: "1",
      },
      {
        id: "n-b",
        name: "B 부품 배출",
        x: 4,
        y: 14,
        kind: "pickup",
        floorId: "1",
      },
      {
        id: "n-west",
        name: "서측 교차로",
        x: 12,
        y: 9,
        kind: "intersection",
        floorId: "1",
      },
      {
        id: "n-east",
        name: "동측 교차로",
        x: 24,
        y: 9,
        kind: "intersection",
        floorId: "1",
      },
      {
        id: "n-assembly",
        name: "조립 인계",
        x: 31,
        y: 5,
        kind: "dropoff",
        floorId: "1",
      },
      {
        id: "n-store",
        name: "출하 창고",
        x: 37,
        y: 14,
        kind: "dropoff",
        floorId: "1",
      },
      {
        id: "n-charge",
        name: "충전 도킹",
        x: 14,
        y: 17,
        kind: "charge",
        floorId: "1",
      },
      {
        id: "n-park",
        name: "로봇 대기",
        x: 4,
        y: 19,
        kind: "wait",
        floorId: "1",
      },
    ],
    edges: [
      {
        id: "e-a-west",
        from: "n-a",
        to: "n-west",
        length: 10,
        width: 1.8,
        speedLimit: 1.4,
        bidirectional: true,
      },
      {
        id: "e-b-west",
        from: "n-b",
        to: "n-west",
        length: 10,
        width: 1.8,
        speedLimit: 1.4,
        bidirectional: true,
      },
      {
        id: "e-spine",
        from: "n-west",
        to: "n-east",
        length: 12,
        width: 1.2,
        speedLimit: 1.2,
        bidirectional: true,
        zoneId: "central-corridor",
      },
      {
        id: "e-east-assembly",
        from: "n-east",
        to: "n-assembly",
        length: 8.1,
        width: 1.8,
        speedLimit: 1.2,
        bidirectional: true,
      },
      {
        id: "e-east-store",
        from: "n-east",
        to: "n-store",
        length: 14,
        width: 1.8,
        speedLimit: 1.4,
        bidirectional: true,
      },
      {
        id: "e-west-charge",
        from: "n-west",
        to: "n-charge",
        length: 8.3,
        width: 1.8,
        speedLimit: 1,
        bidirectional: true,
      },
      {
        id: "e-b-park",
        from: "n-b",
        to: "n-park",
        length: 5,
        width: 1.8,
        speedLimit: 1,
        bidirectional: true,
      },
    ],
    objects: [
      {
        id: "obj-a",
        name: "A 가공 설비",
        kind: "line",
        x: 3.8,
        y: 1.9,
        width: 4.8,
        height: 2.2,
        rotation: 0,
        nodeId: "n-a",
      },
      {
        id: "obj-b",
        name: "B 가공 설비",
        kind: "line",
        x: 3.8,
        y: 11.5,
        width: 4.8,
        height: 2.2,
        rotation: 0,
        nodeId: "n-b",
      },
      {
        id: "obj-assembly",
        name: "조립 셀",
        kind: "line",
        x: 31,
        y: 2.3,
        width: 6.5,
        height: 2.6,
        rotation: 0,
        nodeId: "n-assembly",
      },
      {
        id: "obj-store",
        name: "출하 랙",
        kind: "rack",
        x: 37,
        y: 17.1,
        width: 4,
        height: 3.5,
        rotation: 0,
        nodeId: "n-store",
      },
      {
        id: "obj-charge",
        name: "충전기 C1",
        kind: "charger",
        x: 14,
        y: 19.1,
        width: 3,
        height: 1.6,
        rotation: 0,
        nodeId: "n-charge",
      },
      {
        id: "obj-wait",
        name: "대기 구역",
        kind: "wait",
        x: 4,
        y: 21,
        width: 3,
        height: 1.3,
        rotation: 0,
        nodeId: "n-park",
      },
      {
        id: "obj-column",
        name: "기둥",
        kind: "column",
        x: 19,
        y: 3,
        width: 1,
        height: 1,
        rotation: 0,
      },
    ],
    buffers: [
      {
        id: "buf-a",
        name: "A 출력 버퍼",
        nodeId: "n-a",
        capacity: 8,
        initialInventory: { A: 2 },
      },
      {
        id: "buf-b",
        name: "B 출력 버퍼",
        nodeId: "n-b",
        capacity: 6,
        initialInventory: { B: 1 },
      },
      {
        id: "buf-input",
        name: "조립 입력 버퍼",
        nodeId: "n-assembly",
        capacity: 12,
        initialInventory: { A: 0, B: 0 },
      },
      {
        id: "buf-finished",
        name: "완제품 출력 버퍼",
        nodeId: "n-assembly",
        capacity: 4,
        initialInventory: { F: 0 },
      },
      {
        id: "buf-store",
        name: "출하 재고",
        nodeId: "n-store",
        capacity: 60,
        initialInventory: { F: 0 },
      },
    ],
    robotTypes: [structuredClone(STANDARD_AMR)],
    robots: [
      {
        id: "amr-01",
        name: "AMR 01",
        typeId: "type-pallet",
        nodeId: "n-park",
        initialBatteryWh: 115,
      },
      {
        id: "amr-02",
        name: "AMR 02",
        typeId: "type-pallet",
        nodeId: "n-charge",
        initialBatteryWh: 100,
      },
    ],
    chargers: [
      {
        id: "charger-1",
        name: "충전기 C1",
        nodeId: "n-charge",
        capacity: 1,
        waitingCapacity: 2,
        powerW: 900,
        compatibleTypes: ["type-pallet"],
        dockTime: 5,
        undockTime: 3,
      },
    ],
    processes: [
      {
        id: "process-a",
        name: "A 가공",
        nodeId: "n-a",
        inputRequirements: {},
        outputBufferId: "buf-a",
        outputProduct: "A",
        outputQuantity: 2,
        processingTime: { kind: "uniform", min: 20, max: 30 },
        isFinal: false,
      },
      {
        id: "process-b",
        name: "B 가공",
        nodeId: "n-b",
        inputRequirements: {},
        outputBufferId: "buf-b",
        outputProduct: "B",
        outputQuantity: 1,
        processingTime: { kind: "triangular", min: 30, mode: 40, max: 50 },
        isFinal: false,
      },
      {
        id: "process-assembly",
        name: "A×2 + B×1 조립",
        nodeId: "n-assembly",
        inputBufferId: "buf-input",
        inputRequirements: { A: 2, B: 1 },
        outputBufferId: "buf-finished",
        outputProduct: "F",
        outputQuantity: 1,
        processingTime: { kind: "fixed", value: 18 },
        isFinal: true,
        workerResourceId: "operator-1",
      },
    ],
    transportRules: [
      {
        id: "rule-a",
        name: "A 부품 보충",
        sourceBufferId: "buf-a",
        destinationBufferId: "buf-input",
        product: "A",
        quantity: 2,
        unitWeightKg: 8,
        priority: 1,
        dueAfter: 240,
      },
      {
        id: "rule-b",
        name: "B 부품 보충",
        sourceBufferId: "buf-b",
        destinationBufferId: "buf-input",
        product: "B",
        quantity: 1,
        unitWeightKg: 10,
        priority: 2,
        dueAfter: 240,
      },
      {
        id: "rule-finished",
        name: "완제품 출하",
        sourceBufferId: "buf-finished",
        destinationBufferId: "buf-store",
        product: "F",
        quantity: 1,
        unitWeightKg: 26,
        priority: 3,
        dueAfter: 300,
      },
    ],
    equipment: [{ id: "operator-1", name: "조립 작업자", capacity: 1 }],
    disruptions: [],
    settings: { duration: 1800, seed: 42, dispatchPolicy: "fifo", warmup: 0 },
  };
}

function baseBenchmark(id: string, name: string): Project {
  const p = createExampleProject();
  return {
    ...p,
    id,
    name,
    description: `${name} 기준 검증 시나리오. 모든 수치는 검증용 가정입니다.`,
    nodes: [
      { id: "n-left", name: "왼쪽", x: 3, y: 6, kind: "pickup" },
      { id: "n-right", name: "오른쪽", x: 15, y: 6, kind: "dropoff" },
      { id: "n-charger", name: "충전기", x: 3, y: 14, kind: "charge" },
    ],
    edges: [
      {
        id: "e-corridor",
        from: "n-left",
        to: "n-right",
        length: 12,
        width: 1.2,
        speedLimit: 1,
        bidirectional: true,
      },
      {
        id: "e-charger",
        from: "n-left",
        to: "n-charger",
        length: 8,
        width: 1.2,
        speedLimit: 1,
        bidirectional: true,
      },
    ],
    objects: [],
    buffers: [
      {
        id: "b-left",
        name: "출발 버퍼",
        nodeId: "n-left",
        capacity: 10,
        initialInventory: { A: 1 },
      },
      {
        id: "b-right",
        name: "도착 버퍼",
        nodeId: "n-right",
        capacity: 10,
        initialInventory: { A: 0 },
      },
    ],
    robotTypes: [
      {
        ...STANDARD_AMR,
        id: "type-basic",
        name: "기준 AMR",
        cargoTypes: ["A", "B", "F"],
        loadTime: 2,
        unloadTime: 2,
        turnTime: 0,
        idlePowerW: 5,
        emptyPowerW: 100,
        loadedPowerW: 150,
        chargeBelowWh: 30,
        reserveWh: 10,
        chargeToWh: 200,
      },
    ],
    robots: [
      {
        id: "robot-1",
        name: "기준 로봇 1",
        typeId: "type-basic",
        nodeId: "n-left",
        initialBatteryWh: 200,
      },
    ],
    chargers: [
      {
        id: "charge-1",
        name: "기준 충전기",
        nodeId: "n-charger",
        capacity: 1,
        waitingCapacity: 2,
        powerW: 1200,
        compatibleTypes: ["type-basic"],
        dockTime: 2,
        undockTime: 2,
      },
    ],
    processes: [],
    transportRules: [
      {
        id: "transfer",
        name: "단일 이송",
        sourceBufferId: "b-left",
        destinationBufferId: "b-right",
        product: "A",
        quantity: 1,
        unitWeightKg: 10,
        priority: 1,
      },
    ],
    equipment: [],
    disruptions: [],
    settings: { duration: 180, seed: 42, dispatchPolicy: "fifo", warmup: 0 },
  };
}

export function createBenchmarkProjects(): Record<string, Project> {
  const singleRobot = baseBenchmark("benchmark-single", "로봇 1대 · 단일 경로");
  const corridor = baseBenchmark(
    "benchmark-corridor",
    "단일 통로 · 양방향 경쟁",
  );
  corridor.buffers.push({
    id: "b-return",
    name: "귀환 도착 버퍼",
    nodeId: "n-left",
    capacity: 10,
    initialInventory: { B: 0 },
  });
  corridor.buffers[1].initialInventory = { B: 1 };
  corridor.robots.push({
    id: "robot-2",
    name: "기준 로봇 2",
    typeId: "type-basic",
    nodeId: "n-right",
    initialBatteryWh: 200,
  });
  corridor.transportRules.push({
    id: "return",
    name: "반대 방향 이송",
    sourceBufferId: "b-right",
    destinationBufferId: "b-return",
    product: "B",
    quantity: 1,
    unitWeightKg: 10,
    priority: 1,
  });
  const charging = baseBenchmark(
    "benchmark-charging",
    "충전기 1기 · 충전 경쟁",
  );
  charging.transportRules = [];
  charging.buffers[0].initialInventory = {};
  charging.robots = [
    {
      id: "robot-1",
      name: "충전 대기 로봇 1",
      typeId: "type-basic",
      nodeId: "n-charger",
      initialBatteryWh: 20,
    },
    {
      id: "robot-2",
      name: "충전 대기 로봇 2",
      typeId: "type-basic",
      nodeId: "n-left",
      initialBatteryWh: 22,
    },
  ];
  charging.settings.duration = 1400;
  const bufferSaturation = baseBenchmark(
    "benchmark-buffer",
    "유한 버퍼 · 생산 정지",
  );
  bufferSaturation.transportRules = [];
  bufferSaturation.buffers[0] = {
    ...bufferSaturation.buffers[0],
    capacity: 2,
    initialInventory: {},
  };
  bufferSaturation.processes = [
    {
      id: "p-source",
      name: "버퍼 포화 생산",
      nodeId: "n-left",
      inputRequirements: {},
      outputBufferId: "b-left",
      outputProduct: "A",
      outputQuantity: 1,
      processingTime: { kind: "fixed", value: 10 },
      isFinal: true,
    },
  ];
  bufferSaturation.settings.duration = 100;
  const materialStarvation = baseBenchmark(
    "benchmark-starvation",
    "부품 부족 · 보충 후 조립 재개",
  );
  materialStarvation.buffers.push({
    id: "b-final",
    name: "조립 배출",
    nodeId: "n-right",
    capacity: 5,
    initialInventory: {},
  });
  materialStarvation.buffers[1].initialInventory = { B: 1 };
  materialStarvation.processes = [
    {
      id: "p-assembly",
      name: "A+B 조립",
      nodeId: "n-right",
      inputBufferId: "b-right",
      inputRequirements: { A: 1, B: 1 },
      outputBufferId: "b-final",
      outputProduct: "F",
      outputQuantity: 1,
      processingTime: { kind: "fixed", value: 5 },
      isFinal: true,
    },
  ];
  const equipmentFailure = baseBenchmark(
    "benchmark-failure",
    "설비 고장 · 복구 후 생산 재개",
  );
  equipmentFailure.transportRules = [];
  equipmentFailure.buffers[0].initialInventory = {};
  equipmentFailure.buffers[0].capacity = 100;
  equipmentFailure.processes = [
    {
      id: "p-source",
      name: "장애 대상 설비",
      nodeId: "n-left",
      inputRequirements: {},
      outputBufferId: "b-left",
      outputProduct: "A",
      outputQuantity: 1,
      processingTime: { kind: "fixed", value: 20 },
      isFinal: true,
    },
  ];
  equipmentFailure.disruptions = [
    {
      id: "failure-1",
      time: 10,
      duration: 30,
      targetType: "process",
      targetId: "p-source",
    },
  ];
  equipmentFailure.settings.duration = 100;
  return {
    singleRobot,
    corridor,
    charging,
    bufferSaturation,
    materialStarvation,
    equipmentFailure,
  };
}
