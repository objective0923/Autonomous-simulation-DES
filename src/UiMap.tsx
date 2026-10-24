import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { MapObject, Project, RobotStatus, Snapshot } from "./types";
import { physicalZone } from "./routing";

export interface UiMapProps {
  project: Project;
  snapshot: Snapshot | null;
  editable: boolean;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onChange: (project: Project) => void;
  tool: "select" | "node" | "edge" | "object";
  objectKind: MapObject["kind"];
  snap: boolean;
  zoom: number;
  onZoom: (zoom: number) => void;
}

const objectNames: Record<MapObject["kind"], string> = {
  rack: "보관 랙",
  pallet: "팔레트",
  cart: "대차",
  line: "제조 설비",
  buffer: "버퍼 구역",
  wall: "벽",
  column: "기둥",
  wait: "대기 구역",
  charger: "충전 구역",
};
const statusNames: Record<RobotStatus, string> = {
  idle: "대기",
  emptyTravel: "공차 이동",
  loading: "적재",
  loadedTravel: "적재 이동",
  unloading: "하역",
  trafficWait: "교통 대기",
  equipmentWait: "설비 대기",
  chargeWait: "충전 대기",
  docking: "도킹",
  charging: "충전",
  undocking: "이탈",
  failed: "고장",
};
const robotColor = (status: RobotStatus) =>
  status === "failed"
    ? "#dc5263"
    : ["charging", "docking", "undocking"].includes(status)
      ? "#22c55e"
      : status === "trafficWait" ||
          status === "equipmentWait" ||
          status === "chargeWait"
        ? "#dc9d35"
        : status === "idle"
          ? "#60768c"
          : "#149d8a";

type Drag =
  | {
      mode: "pan";
      startClient: { x: number; y: number };
      startPan: { x: number; y: number };
    }
  | {
      mode: "objects";
      start: { x: number; y: number };
      ids: string[];
      original: Project;
    };

/** SVG is a view of engine-owned state. Moving map decorations never changes stock. */
export default function UiMap({
  project,
  snapshot,
  editable,
  selected,
  onSelect,
  onChange,
  tool,
  objectKind,
  snap,
  zoom,
  onZoom,
}: UiMapProps) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<Project | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [edgeStart, setEdgeStart] = useState<string | null>(null);
  const view = preview ?? project;
  const bounds = useMemo(() => {
    const xs = project.nodes.map((n) => n.x);
    const ys = project.nodes.map((n) => n.y);
    for (const object of project.objects) {
      xs.push(object.x - object.width / 2, object.x + object.width / 2);
      ys.push(object.y - object.height / 2, object.y + object.height / 2);
    }
    const minX = Math.min(0, ...xs) - 5;
    const minY = Math.min(0, ...ys) - 5;
    const width = Math.max(30, Math.max(25, ...xs) + 5 - minX);
    const height = Math.max(22, Math.max(17, ...ys) + 5 - minY);
    return { cx: minX + width / 2, cy: minY + height / 2, width, height };
  }, [project.nodes, project.objects]);
  const safeZoom = Math.max(0.25, Math.min(5, zoom));
  const viewBox = {
    x: bounds.cx - bounds.width / safeZoom / 2 + pan.x,
    y: bounds.cy - bounds.height / safeZoom / 2 + pan.y,
    width: bounds.width / safeZoom,
    height: bounds.height / safeZoom,
  };
  const nodes = new Map(view.nodes.map((n) => [n.id, n]));
  const coord = (clientX: number, clientY: number) => {
    const matrix = svg.current?.getScreenCTM();
    if (!svg.current || !matrix) return { x: 0, y: 0 };
    const point = svg.current.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  };
  const quantize = (n: number) =>
    snap ? Math.round(n * 2) / 2 : Math.round(n * 100) / 100;
  const nextId = (prefix: string) => {
    const ids = new Set(
      [
        ...project.nodes,
        ...project.edges,
        ...project.objects,
        ...project.buffers,
        ...project.robots,
        ...project.chargers,
        ...project.processes,
        ...project.transportRules,
        ...project.robotTypes,
        ...project.equipment,
        ...project.disruptions,
      ].map((x) => x.id),
    );
    let i = 1;
    while (ids.has(`${prefix}-${i}`)) i++;
    return `${prefix}-${i}`;
  };
  const beginEntity = (
    event: ReactPointerEvent<SVGGElement | SVGPathElement>,
    id: string,
    movable: boolean,
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (editable && tool === "edge" && project.nodes.some((n) => n.id === id)) {
      if (!edgeStart) {
        setEdgeStart(id);
        onSelect([id]);
      } else if (edgeStart !== id) {
        const from = project.nodes.find((n) => n.id === edgeStart)!;
        const to = project.nodes.find((n) => n.id === id)!;
        const changed = structuredClone(project);
        const newId = nextId("edge");
        changed.edges.push({
          id: newId,
          from: from.id,
          to: to.id,
          length: Number(Math.hypot(to.x - from.x, to.y - from.y).toFixed(2)),
          width: 2,
          speedLimit: 1.5,
          bidirectional: true,
        });
        onChange(changed);
        onSelect([newId]);
        setEdgeStart(null);
      }
      return;
    }
    const ids = event.shiftKey
      ? selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id]
      : selected.includes(id)
        ? selected
        : [id];
    onSelect(ids);
    if (editable && tool === "select" && movable && ids.includes(id)) {
      drag.current = {
        mode: "objects",
        start: coord(event.clientX, event.clientY),
        ids,
        original: project,
      };
      svg.current?.setPointerCapture(event.pointerId);
    }
  };
  const beginBlank = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (
      event.button === 1 ||
      event.button === 2 ||
      (event.button === 0 && tool === "select")
    ) {
      event.preventDefault();
      if (event.button === 0 && !event.shiftKey) onSelect([]);
      setEdgeStart(null);
      drag.current = {
        mode: "pan",
        startClient: { x: event.clientX, y: event.clientY },
        startPan: pan,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (!editable || event.button !== 0) return;
    const point = coord(event.clientX, event.clientY);
    const changed = structuredClone(project);
    if (tool === "node") {
      const id = nextId("node");
      changed.nodes.push({
        id,
        name: `노드 ${changed.nodes.length + 1}`,
        x: quantize(point.x),
        y: quantize(point.y),
        kind: "transit",
      });
      onChange(changed);
      onSelect([id]);
    } else if (tool === "object") {
      const id = nextId(objectKind);
      const nearest = [...project.nodes].sort(
        (a, b) =>
          Math.hypot(a.x - point.x, a.y - point.y) -
          Math.hypot(b.x - point.x, b.y - point.y),
      )[0];
      changed.objects.push({
        id,
        name: `${objectNames[objectKind]} ${changed.objects.length + 1}`,
        kind: objectKind,
        x: quantize(point.x),
        y: quantize(point.y),
        width: objectKind === "column" ? 1 : 3,
        height: objectKind === "wall" ? 0.4 : 2,
        rotation: 0,
        ...(nearest ? { nodeId: nearest.id } : {}),
      });
      onChange(changed);
      onSelect([id]);
    }
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (!active) return;
    if (active.mode === "pan") {
      const matrix = svg.current?.getScreenCTM();
      if (!matrix) return;
      const scaleX = Math.hypot(matrix.a, matrix.b);
      const scaleY = Math.hypot(matrix.c, matrix.d);
      setPan({
        x: active.startPan.x - (event.clientX - active.startClient.x) / scaleX,
        y: active.startPan.y - (event.clientY - active.startClient.y) / scaleY,
      });
    } else {
      const point = coord(event.clientX, event.clientY);
      const dx = point.x - active.start.x;
      const dy = point.y - active.start.y;
      const changed = structuredClone(active.original);
      changed.nodes = changed.nodes.map((node) =>
        active.ids.includes(node.id)
          ? { ...node, x: quantize(node.x + dx), y: quantize(node.y + dy) }
          : node,
      );
      changed.objects = changed.objects.map((object) =>
        active.ids.includes(object.id)
          ? {
              ...object,
              x: quantize(object.x + dx),
              y: quantize(object.y + dy),
            }
          : object,
      );
      setPreview(changed);
    }
  };
  const finish = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (
      drag.current?.mode === "objects" &&
      preview &&
      JSON.stringify(preview) !== JSON.stringify(project)
    )
      onChange(preview);
    drag.current = null;
    setPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const selectedStroke = (id: string) =>
    selected.includes(id) ? "#0d9e90" : "#b8c9d1";
  const statusAt = (id: string) => snapshot?.robots.find((r) => r.id === id);

  return (
    <div
      className="map-surface"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 360,
        overflow: "hidden",
        background: "#f5f8fa",
      }}
    >
      <svg
        ref={svg}
        aria-label="제조라인 2D 배치도"
        role="img"
        data-testid="factory-map"
        width="100%"
        height="100%"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        style={{
          display: "block",
          minHeight: 360,
          touchAction: "none",
          userSelect: "none",
          cursor:
            editable && tool !== "select"
              ? "crosshair"
              : drag.current?.mode === "pan"
                ? "grabbing"
                : "default",
        }}
        onPointerDown={beginBlank}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={() => {
          drag.current = null;
          setPreview(null);
        }}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) {
            setPan({ x: 0, y: 0 });
            onZoom(1);
          }
        }}
        onWheel={(e) => {
          e.preventDefault();
          onZoom(
            Math.max(0.25, Math.min(5, safeZoom * (e.deltaY > 0 ? 0.9 : 1.1))),
          );
        }}
      >
        <defs>
          <pattern
            id="crois-grid-small"
            width="1"
            height="1"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 1 0 L 0 0 0 1"
              fill="none"
              stroke="#e1e9ed"
              strokeWidth="0.026"
            />
          </pattern>
          <pattern
            id="crois-grid"
            width="5"
            height="5"
            patternUnits="userSpaceOnUse"
          >
            <rect width="5" height="5" fill="url(#crois-grid-small)" />
            <path
              d="M 5 0 L 0 0 0 5"
              fill="none"
              stroke="#cddce3"
              strokeWidth="0.05"
            />
          </pattern>
          <marker
            id="crois-arrow"
            markerWidth="5"
            markerHeight="5"
            refX="4"
            refY="2.5"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L5,2.5 L0,5" fill="#8ba1af" />
          </marker>
          <filter
            id="crois-shadow"
            x="-40%"
            y="-40%"
            width="180%"
            height="180%"
          >
            <feDropShadow
              dx="0"
              dy="0.11"
              stdDeviation="0.1"
              floodOpacity="0.15"
            />
          </filter>
        </defs>
        <rect
          x={viewBox.x - 100}
          y={viewBox.y - 100}
          width={viewBox.width + 200}
          height={viewBox.height + 200}
          fill="url(#crois-grid)"
          pointerEvents="none"
        />
        {view.background && (
          <image
            href={view.background.dataUrl}
            x={view.background.x}
            y={view.background.y}
            width={view.background.width}
            height={view.background.height}
            opacity={view.background.opacity}
            preserveAspectRatio="none"
            pointerEvents="none"
          />
        )}
        {view.edges.map((edge) => {
          const from = nodes.get(edge.from),
            to = nodes.get(edge.to);
          if (!from || !to) return null;
          const zone = physicalZone(edge);
          const occupied = snapshot?.zoneOwners[zone];
          return (
            <g
              key={edge.id}
              onPointerDown={(e) => beginEntity(e, edge.id, false)}
              style={{ cursor: editable ? "pointer" : "default" }}
            >
              <title>
                {edge.id} · {edge.length} m · 폭 {edge.width} m
                {occupied ? ` · 예약 ${occupied}` : ""}
              </title>
              <path
                d={`M${from.x},${from.y} L${to.x},${to.y}`}
                fill="none"
                stroke={
                  selected.includes(edge.id)
                    ? "#b6ece5"
                    : edge.disabled
                      ? "#f3dddd"
                      : occupied
                        ? "#c9e7e3"
                        : "#e2e9ed"
                }
                strokeWidth={Math.min(2.3, Math.max(0.7, edge.width))}
                strokeLinecap="round"
              />
              <path
                d={`M${from.x},${from.y} L${to.x},${to.y}`}
                fill="none"
                stroke={
                  edge.disabled
                    ? "#ce6973"
                    : selected.includes(edge.id)
                      ? "#0d9e90"
                      : "#9fb1bd"
                }
                strokeWidth={0.06}
                strokeDasharray={edge.disabled ? "0.2 0.15" : "0.45 0.3"}
                markerEnd={edge.bidirectional ? undefined : "url(#crois-arrow)"}
              />
              <text
                x={(from.x + to.x) / 2}
                y={(from.y + to.y) / 2 - 0.38}
                fontSize="0.55"
                fill="#6e8595"
                textAnchor="middle"
                stroke="#f5f8fa"
                strokeWidth="0.1"
                paintOrder="stroke"
                pointerEvents="none"
              >
                {edge.length} m
              </text>
            </g>
          );
        })}
        {view.objects.map((object) => {
          const fill =
            object.kind === "line"
              ? "#e4edfa"
              : object.kind === "charger"
                ? "#eee8fb"
                : object.kind === "rack"
                  ? "#f3e8d5"
                  : object.kind === "wall" || object.kind === "column"
                    ? "#a2b1bb"
                    : object.kind === "wait"
                      ? "#e7edf1"
                      : "#dceded";
          const ink =
            object.kind === "line"
              ? "#6684ac"
              : object.kind === "charger"
                ? "#9271bf"
                : object.kind === "rack"
                  ? "#bb9866"
                  : "#7ca5a7";
          return (
            <g
              key={object.id}
              transform={`translate(${object.x} ${object.y}) rotate(${object.rotation})`}
              onPointerDown={(e) => beginEntity(e, object.id, true)}
              style={{
                cursor: editable && tool === "select" ? "move" : "pointer",
              }}
            >
              <title>
                {object.name} · {object.width} × {object.height} m · 장식 배치
              </title>
              <rect
                x={-object.width / 2}
                y={-object.height / 2}
                width={object.width}
                height={object.height}
                rx={object.kind === "wall" ? 0 : 0.13}
                fill={fill}
                stroke={selectedStroke(object.id)}
                strokeWidth={selected.includes(object.id) ? 0.12 : 0.065}
                strokeDasharray={
                  object.kind === "wait" || object.kind === "buffer"
                    ? "0.22 0.12"
                    : undefined
                }
              />
              {object.kind === "rack" &&
                [0.25, 0.5, 0.75].map((x) => (
                  <line
                    key={x}
                    x1={-object.width / 2 + object.width * x}
                    y1={-object.height / 2 + 0.12}
                    x2={-object.width / 2 + object.width * x}
                    y2={object.height / 2 - 0.12}
                    stroke={ink}
                    strokeWidth="0.045"
                  />
                ))}
              {object.kind === "line" && (
                <>
                  <rect
                    x={-object.width * 0.39}
                    y={-object.height * 0.28}
                    width={object.width * 0.78}
                    height={object.height * 0.56}
                    rx="0.08"
                    fill="none"
                    stroke={ink}
                    strokeWidth="0.05"
                  />
                  <line
                    x1={-object.width * 0.28}
                    y1="0"
                    x2={object.width * 0.28}
                    y2="0"
                    stroke={ink}
                    strokeWidth="0.06"
                    strokeDasharray="0.15 0.15"
                  />
                </>
              )}
              {object.kind === "charger" && (
                <path
                  d="M0.12,-0.6 L-0.35,0.12 L0.02,0.12 L-0.12,0.6 L0.4,-0.12 L0,-0.12 Z"
                  fill={ink}
                />
              )}
              <text
                y={object.height / 2 + 0.8}
                textAnchor="middle"
                fontSize="0.7"
                fill="#526675"
                paintOrder="stroke"
                stroke="#f5f8fa"
                strokeWidth="0.09"
                pointerEvents="none"
              >
                {object.name}
              </text>
              {selected.includes(object.id) &&
                [
                  [-1, -1],
                  [1, -1],
                  [1, 1],
                  [-1, 1],
                ].map(([x, y]) => (
                  <rect
                    key={`${x},${y}`}
                    x={(x * object.width) / 2 - 0.08}
                    y={(y * object.height) / 2 - 0.08}
                    width="0.16"
                    height="0.16"
                    fill="white"
                    stroke="#0d9e90"
                    strokeWidth="0.04"
                    pointerEvents="none"
                  />
                ))}
            </g>
          );
        })}
        {view.nodes.map((node) => (
          <g
            key={node.id}
            transform={`translate(${node.x} ${node.y})`}
            onPointerDown={(e) => beginEntity(e, node.id, true)}
            style={{
              cursor: editable && tool === "select" ? "move" : "pointer",
            }}
          >
            <title>
              {node.name} · ({node.x}, {node.y}) m · {node.id}
            </title>
            {(selected.includes(node.id) ||
              (tool === "edge" && edgeStart === node.id)) && (
              <circle
                r="0.63"
                fill="#0d9e9018"
                stroke="#0d9e90"
                strokeWidth="0.05"
                strokeDasharray="0.12 0.1"
              />
            )}
            {node.kind === "intersection" ? (
              <rect
                x="-0.26"
                y="-0.26"
                width="0.52"
                height="0.52"
                rx="0.07"
                fill="white"
                stroke={selected.includes(node.id) ? "#0d9e90" : "#7d94a4"}
                strokeWidth="0.08"
                transform="rotate(45)"
              />
            ) : (
              <circle
                r={node.kind === "transit" ? 0.2 : 0.29}
                fill={
                  node.kind === "charge"
                    ? "#eee8fb"
                    : node.kind === "pickup" || node.kind === "dropoff"
                      ? "#d6eeea"
                      : "white"
                }
                stroke={selected.includes(node.id) ? "#0d9e90" : "#73989c"}
                strokeWidth="0.07"
              />
            )}
            <text
              y="1.1"
              textAnchor="middle"
              fontSize="0.7"
              fill="#617789"
              stroke="#f5f8fa"
              strokeWidth="0.11"
              paintOrder="stroke"
              pointerEvents="none"
            >
              {node.name}
            </text>
          </g>
        ))}
        {view.buffers.map((buffer) => {
          const node = nodes.get(buffer.nodeId);
          if (!node) return null;
          const current = snapshot?.buffers.find((b) => b.id === buffer.id);
          const inventory = current?.inventory ?? buffer.initialInventory;
          const count = Object.values(inventory).reduce((sum, x) => sum + x, 0);
          const ratio = Math.min(1, count / Math.max(1, buffer.capacity));
          return (
            <g
              key={buffer.id}
              transform={`translate(${node.x - 2.4} ${node.y - 2.6})`}
              onPointerDown={(e) => beginEntity(e, buffer.id, false)}
              style={{ cursor: "pointer" }}
            >
              <title>
                {buffer.name} · 재고 {count}/{buffer.capacity} · 입고 예약{" "}
                {current?.reservedIn ?? 0}
              </title>
              <rect
                x="0"
                y="0"
                width="4.8"
                height="1.55"
                rx="0.16"
                fill={ratio >= 1 ? "#fff0d8" : "#ffffff"}
                stroke={selected.includes(buffer.id) ? "#0d9e90" : "#b5c9ce"}
                strokeWidth="0.05"
              />
              <rect
                x="0.15"
                y="1.31"
                width={4.5 * ratio}
                height="0.11"
                rx="0.03"
                fill={ratio >= 1 ? "#e5a747" : "#34ac9c"}
              />
              <text
                x="2.4"
                y="0.62"
                fontSize="0.65"
                textAnchor="middle"
                fill="#435e6e"
                pointerEvents="none"
              >
                {buffer.name.slice(0, 7)}
                <tspan x="2.4" dy="0.57" fontSize="0.55">
                  {count} / {buffer.capacity}
                </tspan>
              </text>
            </g>
          );
        })}
        {view.chargers.map((charger) => {
          const node = nodes.get(charger.nodeId);
          if (!node) return null;
          const state = snapshot?.chargers.find((c) => c.id === charger.id);
          return (
            <g
              key={charger.id}
              transform={`translate(${node.x - 2.2} ${node.y + 1.5})`}
              onPointerDown={(e) => beginEntity(e, charger.id, false)}
              style={{ cursor: "pointer" }}
            >
              <title>
                {charger.name} · 충전 {state?.occupants.length ?? 0}/
                {charger.capacity} · 대기 {state?.queue.length ?? 0}/
                {charger.waitingCapacity}
              </title>
              <rect
                width="4.4"
                height="0.95"
                rx="0.15"
                fill={state?.failed ? "#fbe7e8" : "#eee8fb"}
                stroke={selected.includes(charger.id) ? "#0d9e90" : "#bbabd6"}
                strokeWidth="0.05"
              />
              <text
                x="2.2"
                y="0.65"
                fontSize="0.62"
                textAnchor="middle"
                fill="#7958a8"
                pointerEvents="none"
              >
                ϟ {state?.occupants.length ?? 0}/{charger.capacity} · 대기{" "}
                {state?.queue.length ?? 0}
              </text>
            </g>
          );
        })}
        {view.robots.map((spec, index) => {
          const robot = statusAt(spec.id);
          const node = nodes.get(robot?.nodeId ?? spec.nodeId);
          if (!node) return null;
          const type = view.robotTypes.find((t) => t.id === spec.typeId);
          const status = robot?.status ?? "idle";
          const battery = robot?.batteryWh ?? spec.initialBatteryWh;
          let x = node.x,
            y = node.y,
            angle = 0;
          if (robot?.movement && snapshot) {
            const from = nodes.get(robot.movement.from),
              to = nodes.get(robot.movement.to);
            if (from && to) {
              const duration = robot.movement.endsAt - robot.movement.startedAt;
              const movementTime =
                robot.movement.pausedAt ??
                (robot.status === "failed" ? robot.stateSince : snapshot.time);
              const progress =
                duration > 0
                  ? Math.max(
                      0,
                      Math.min(
                        1,
                        (movementTime - robot.movement.startedAt) / duration,
                      ),
                    )
                  : 1;
              x = from.x + (to.x - from.x) * progress;
              y = from.y + (to.y - from.y) * progress;
              angle =
                (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
            }
          } else {
            // Distinct parking offsets make co-located initial robots visible.
            const peers = view.robots.filter(
              (r) =>
                (statusAt(r.id)?.nodeId ?? r.nodeId) ===
                (robot?.nodeId ?? spec.nodeId),
            );
            if (peers.length > 1) {
              const peer = peers.findIndex((r) => r.id === spec.id);
              x += (peer - (peers.length - 1) / 2) * 0.85;
              y -= 0.55;
            }
          }
          const color = robotColor(status);
          return (
            <g
              key={spec.id}
              transform={`translate(${x} ${y})`}
              onPointerDown={(e) => beginEntity(e, spec.id, false)}
              style={{ cursor: "pointer" }}
            >
              <title>
                {spec.name} · {statusNames[status]} · {battery.toFixed(1)} Wh
                {robot?.jobId ? ` · ${robot.jobId}` : ""}
                {robot?.carrying
                  ? ` · ${robot.carrying.product} ${robot.carrying.quantity}개`
                  : ""}
              </title>
              {selected.includes(spec.id) && (
                <circle
                  r="0.8"
                  fill={`${color}18`}
                  stroke={color}
                  strokeDasharray="0.14 0.1"
                  strokeWidth="0.05"
                />
              )}
              <g transform={`rotate(${angle})`} filter="url(#crois-shadow)">
                <rect
                  x="-0.54"
                  y="-0.4"
                  width="1.08"
                  height="0.8"
                  rx="0.19"
                  fill={color}
                  stroke="white"
                  strokeWidth="0.065"
                />
                <rect
                  x="-0.32"
                  y="-0.24"
                  width="0.53"
                  height="0.48"
                  rx="0.08"
                  fill={robot?.carrying ? "#f1d1a0" : "#ffffff35"}
                />
                <path
                  d="M0.33,-0.12 L0.47,0 L0.33,0.12"
                  fill="none"
                  stroke="white"
                  strokeWidth="0.065"
                />
                <rect
                  x="-0.31"
                  y="-0.44"
                  width="0.22"
                  height="0.08"
                  rx="0.03"
                  fill="#364f5f"
                />
                <rect
                  x="-0.31"
                  y="0.36"
                  width="0.22"
                  height="0.08"
                  rx="0.03"
                  fill="#364f5f"
                />
              </g>
              <text
                y="-0.95"
                textAnchor="middle"
                fontSize="0.7"
                fontWeight="600"
                fill={color}
                stroke="#f5f8fa"
                strokeWidth="0.1"
                paintOrder="stroke"
                pointerEvents="none"
              >
                {spec.name || `AMR ${index + 1}`}
              </text>
              <rect
                x="-0.38"
                y="0.55"
                width="0.76"
                height="0.1"
                rx="0.04"
                fill="#d7e2e8"
                pointerEvents="none"
              />
              <rect
                x="-0.38"
                y="0.55"
                width={
                  0.76 *
                  Math.max(
                    0,
                    Math.min(1, battery / (type?.batteryCapacityWh || 1)),
                  )
                }
                height="0.1"
                rx="0.04"
                fill={color}
                pointerEvents="none"
              />
            </g>
          );
        })}
      </svg>
      {editable && tool === "edge" && (
        <div
          className="map-tool-hint"
          style={{
            position: "absolute",
            top: 14,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "9px 14px",
            background: "#142d3eee",
            color: "#fff",
            fontSize: 12,
            borderRadius: 7,
            pointerEvents: "none",
          }}
        >
          {edgeStart
            ? "도착 노드를 선택하세요"
            : "출발 노드와 도착 노드를 차례로 선택하세요"}
        </div>
      )}
    </div>
  );
}
