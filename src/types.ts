/** SI units: m, s, kg, Wh, W. Schema and renderer are independent of the engine. */
export type Distribution =
  | { kind: "fixed"; value: number }
  | { kind: "uniform"; min: number; max: number }
  | { kind: "triangular"; min: number; mode: number; max: number }
  | { kind: "normal"; mean: number; sd: number; min: number; max: number }
  | { kind: "lognormal"; mu: number; sigma: number }
  | { kind: "exponential"; mean: number }
  | { kind: "empirical"; values: number[] };
export interface MapNode {
  id: string;
  name: string;
  x: number;
  y: number;
  kind: "transit" | "pickup" | "dropoff" | "wait" | "charge" | "intersection";
  floorId?: string;
}
export interface MapEdge {
  id: string;
  from: string;
  to: string;
  length: number;
  width: number;
  speedLimit: number;
  bidirectional: boolean;
  zoneId?: string;
  allowedRobotTypes?: string[];
  disabled?: boolean;
}
export interface MapObject {
  id: string;
  name: string;
  kind:
    | "rack"
    | "pallet"
    | "cart"
    | "line"
    | "buffer"
    | "wall"
    | "column"
    | "wait"
    | "charger";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  nodeId?: string;
}
export interface BufferSpec {
  id: string;
  name: string;
  nodeId: string;
  capacity: number;
  initialInventory: Record<string, number>;
}
export interface RobotType {
  id: string;
  name: string;
  width: number;
  length: number;
  maxPayloadKg: number;
  maxUnits: number;
  cargoTypes: string[];
  emptySpeed: number;
  loadedSpeed: number;
  acceleration: number;
  turnTime: number;
  loadTime: number;
  unloadTime: number;
  batteryCapacityWh: number;
  idlePowerW: number;
  emptyPowerW: number;
  loadedPowerW: number;
  reserveWh: number;
  chargeBelowWh: number;
  chargeToWh: number;
}
export interface RobotSpec {
  id: string;
  name: string;
  typeId: string;
  nodeId: string;
  initialBatteryWh: number;
}
export interface ChargerSpec {
  id: string;
  name: string;
  nodeId: string;
  capacity: number;
  waitingCapacity: number;
  powerW: number;
  compatibleTypes: string[];
  dockTime: number;
  undockTime: number;
}
export interface ProcessSpec {
  id: string;
  name: string;
  nodeId: string;
  inputBufferId?: string;
  inputRequirements: Record<string, number>;
  outputBufferId: string;
  outputProduct: string;
  outputQuantity: number;
  processingTime: Distribution;
  isFinal: boolean;
  startAt?: number;
  workerResourceId?: string;
}
export interface TransportRule {
  id: string;
  name: string;
  sourceBufferId: string;
  destinationBufferId: string;
  product: string;
  quantity: number;
  unitWeightKg: number;
  priority: number;
  dueAfter?: number;
}
export interface EquipmentSpec {
  id: string;
  name: string;
  capacity: number;
}
export interface Disruption {
  id: string;
  time: number;
  duration: number;
  targetType: "robot" | "process" | "charger" | "edge";
  targetId: string;
}
/** Pre-design inputs. Unconfirmed values never establish engineering approval. */
export interface SpacePlan {
  source?: {
    name: string;
    type: "image" | "pdf";
    page: number;
    dataUrl: string;
    widthPx: number;
    heightPx: number;
  };
  calibration: {
    referencePixels: number | null;
    referenceMeters: number | null;
    confirmed: boolean;
    evidence: string;
    points?: [{ x: number; y: number }, { x: number; y: number }];
  };
  building: {
    width: number;
    depth: number;
    clearHeight: number | null;
    confirmed: boolean;
    evidence: string;
  };
  robot: {
    kind: "ctu" | "lowProfile" | "pallet";
    width: number | null;
    length: number | null;
    minAisleWidth: number | null;
    minTransferHeight: number | null;
    maxLiftHeight: number | null;
    overallHeight: number | null;
    firstShelfHeight: number | null;
    shelfPitch: number | null;
    shelfCount: number | null;
    transferMode: "liftRange" | "fixedLevels";
    alignmentTolerance: number;
    maxPayloadKg: number | null;
    confirmed: boolean;
    evidence: string;
  };
  rack: {
    width: number;
    depth: number;
    firstShelfHeight: number;
    shelfPitch: number;
    loadHeight: number;
    topClearance: number;
    liftClearance: number;
    beamThickness: number;
    heightMode: "pitch" | "totalHeight" | "minimum";
    totalHeight: number | null;
    unitLoadKg: number;
    shelfCapacityKg: number;
    confirmed: boolean;
    evidence: string;
  };
  layout: {
    margin: number;
    crossAisle: number;
    requestedLevels: number;
    placements: Array<{
      id: string;
      x: number;
      y: number;
      width: number;
      depth: number;
      rotation: 0 | 90;
    }>;
  };
}
export interface Project {
  customerName?: string;
  schemaVersion: "1.0";
  id: string;
  name: string;
  description: string;
  modelVersion: string;
  assumptions: string[];
  nodes: MapNode[];
  edges: MapEdge[];
  objects: MapObject[];
  buffers: BufferSpec[];
  robotTypes: RobotType[];
  robots: RobotSpec[];
  chargers: ChargerSpec[];
  processes: ProcessSpec[];
  transportRules: TransportRule[];
  equipment: EquipmentSpec[];
  disruptions: Disruption[];
  settings: {
    duration: number;
    seed: number;
    dispatchPolicy: "fifo" | "priority" | "nearest" | "earliestFinish";
    warmup: number;
  };
  background?: {
    dataUrl: string;
    x: number;
    y: number;
    width: number;
    height: number;
    opacity: number;
  };
  spacePlan?: SpacePlan;
}
export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  entityId?: string;
}
export type RobotStatus =
  | "idle"
  | "emptyTravel"
  | "loading"
  | "loadedTravel"
  | "unloading"
  | "trafficWait"
  | "equipmentWait"
  | "chargeWait"
  | "docking"
  | "charging"
  | "undocking"
  | "failed";
export interface RobotState {
  id: string;
  nodeId: string;
  status: RobotStatus;
  batteryWh: number;
  jobId?: string;
  chargerId?: string;
  carrying?: { product: string; quantity: number };
  distanceEmpty: number;
  distanceLoaded: number;
  stateSince: number;
  stateTimes: Partial<Record<RobotStatus, number>>;
  movement?: {
    from: string;
    to: string;
    startedAt: number;
    endsAt: number;
    pausedAt?: number;
  };
  edgeId?: string;
}
export interface BufferState {
  id: string;
  inventory: Record<string, number>;
  reservedIn: number;
  reservedOut: Record<string, number>;
  maxOccupancy: number;
}
export interface ProcessState {
  id: string;
  status:
    | "idle"
    | "processing"
    | "materialWait"
    | "outputWait"
    | "equipmentWait"
    | "failed";
  produced: number;
  stateSince: number;
  stateTimes: Record<string, number>;
}
export interface ChargerState {
  id: string;
  occupants: string[];
  queue: string[];
  reserved: string[];
  failed: boolean;
  busySeconds: number;
  maxQueue: number;
}
export type JobStatus =
  | "waiting"
  | "assigned"
  | "loading"
  | "transporting"
  | "unloading"
  | "completed"
  | "failed"
  | "cancelled";
export interface Job {
  id: string;
  ruleId: string;
  sourceBufferId: string;
  destinationBufferId: string;
  product: string;
  quantity: number;
  unitWeightKg: number;
  priority: number;
  requestedAt: number;
  dueAt?: number;
  status: JobStatus;
  robotId?: string;
  assignedAt?: number;
  completedAt?: number;
  reason?: string;
}
export interface EventRecord {
  sequence: number;
  time: number;
  kind: string;
  message: string;
  robotId?: string;
  jobId?: string;
  resourceId?: string;
  cause?: string;
}
export interface Snapshot {
  time: number;
  eventCount: number;
  lastEventSequence?: number;
  robots: RobotState[];
  buffers: BufferState[];
  processes: ProcessState[];
  chargers: ChargerState[];
  jobs: Job[];
  zoneOwners: Record<string, string>;
  diagnostics: ValidationIssue[];
  finished: boolean;
}
export interface Kpis {
  productionCompleted: number;
  transportCompleted: number;
  productionPerHour: number;
  transportPerHour: number;
  meanLeadTime: number;
  p95LeadTime: number;
  meanDispatchWait: number;
  overdueJobs: number;
  unfinishedJobs: number;
  emptyDistanceRatio: number;
  measurementSeconds: number;
  robotStateSeconds: Record<string, Partial<Record<RobotStatus, number>>>;
  chargerUtilization: Record<string, number>;
  bufferOccupancy: Record<string, number>;
  processStateSeconds: Record<string, Record<string, number>>;
  maxChargeQueue: number;
}
export interface SimulationResult {
  runId: string;
  projectId: string;
  scenarioId: string;
  engineVersion: string;
  modelVersion: string;
  seed: number;
  horizon: number;
  measurementStart: number;
  assumptions: string[];
  kpis: Kpis;
  events: EventRecord[];
  history: Snapshot[];
  finalState: Snapshot;
  diagnostics: ValidationIssue[];
}
