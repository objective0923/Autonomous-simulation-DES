import type { MapEdge, Project, RobotType } from "./types";

export interface RouteLeg {
  edgeId: string;
  from: string;
  to: string;
  length: number;
  time: number;
  zoneId: string;
}
export interface Route {
  nodes: string[];
  legs: RouteLeg[];
  distance: number;
  time: number;
}

/** Time for a conservative stop-to-stop segment, including acceleration. */
export function segmentTravelTime(
  length: number,
  speed: number,
  acceleration: number,
): number {
  if (
    ![length, speed, acceleration].every(Number.isFinite) ||
    length < 0 ||
    speed <= 0 ||
    acceleration <= 0
  )
    return Infinity;
  const accelerationDistance = (speed * speed) / acceleration;
  return length <= accelerationDistance
    ? 2 * Math.sqrt(length / acceleration)
    : (2 * speed) / acceleration + (length - accelerationDistance) / speed;
}

/** Opposite representations of one physical corridor share the same default lock. */
export function physicalZone(edge: MapEdge): string {
  return edge.zoneId ?? `corridor:${[edge.from, edge.to].sort().join(":")}`;
}

/** Pure shortest-time routing. Reservations are the DES engine's responsibility. */
export function findRoute(
  project: Project,
  from: string,
  to: string,
  robotType: RobotType,
  loaded = false,
): Route | null {
  const nodes = new Set(project.nodes.map((node) => node.id));
  if (!nodes.has(from) || !nodes.has(to)) return null;
  if (from === to) return { nodes: [from], legs: [], distance: 0, time: 0 };
  const baseSpeed = loaded ? robotType.loadedSpeed : robotType.emptySpeed;
  if (
    !(baseSpeed > 0) ||
    !(robotType.acceleration > 0) ||
    !(robotType.width > 0)
  )
    return null;
  const outgoing = new Map<string, RouteLeg[]>();
  for (const edge of project.edges) {
    if (
      edge.disabled ||
      !nodes.has(edge.from) ||
      !nodes.has(edge.to) ||
      edge.width < robotType.width ||
      !(edge.length > 0) ||
      !(edge.speedLimit > 0)
    )
      continue;
    if (
      edge.allowedRobotTypes &&
      !edge.allowedRobotTypes.includes(robotType.id)
    )
      continue;
    const time = segmentTravelTime(
      edge.length,
      Math.min(edge.speedLimit, baseSpeed),
      robotType.acceleration,
    );
    if (!Number.isFinite(time)) continue;
    const add = (start: string, end: string) => {
      const leg: RouteLeg = {
        edgeId: edge.id,
        from: start,
        to: end,
        length: edge.length,
        time,
        zoneId: physicalZone(edge),
      };
      const list = outgoing.get(start) ?? [];
      list.push(leg);
      outgoing.set(start, list);
    };
    add(edge.from, edge.to);
    if (edge.bidirectional) add(edge.to, edge.from);
  }
  // Stable declaration order breaks equal-distance ties reproducibly.
  const distances = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, RouteLeg>();
  const unvisited = new Set(nodes);
  while (unvisited.size > 0) {
    let current: string | undefined;
    let best = Infinity;
    for (const id of unvisited) {
      const cost = distances.get(id) ?? Infinity;
      if (cost < best) {
        current = id;
        best = cost;
      }
    }
    if (current === undefined || current === to) break;
    unvisited.delete(current);
    for (const original of outgoing.get(current) ?? []) {
      if (!unvisited.has(original.to)) continue;
      // Stop/turn allowance is deliberately conservative at every intermediate node.
      const leg = {
        ...original,
        time:
          original.time +
          (current === from ? 0 : Math.max(0, robotType.turnTime)),
      };
      const nextCost = best + leg.time;
      if (nextCost < (distances.get(leg.to) ?? Infinity)) {
        distances.set(leg.to, nextCost);
        previous.set(leg.to, leg);
      }
    }
  }
  if (!previous.has(to)) return null;
  const legs: RouteLeg[] = [];
  let cursor = to;
  while (cursor !== from) {
    const leg = previous.get(cursor);
    if (!leg) return null;
    legs.unshift(leg);
    cursor = leg.from;
  }
  return {
    nodes: [from, ...legs.map((leg) => leg.to)],
    legs,
    distance: legs.reduce((sum, leg) => sum + leg.length, 0),
    time: legs.reduce((sum, leg) => sum + leg.time, 0),
  };
}
