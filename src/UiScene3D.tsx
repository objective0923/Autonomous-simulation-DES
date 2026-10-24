import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Project, Snapshot, SpacePlan } from "./types";
import { resolveVerticalGeometry } from "./planning";
import "./UiScene3D.css";

interface Props {
  project: Project;
  plan: SpacePlan;
  snapshot?: Snapshot | null;
}
interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rotation?: number;
}
interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  model: THREE.Group;
  robots: THREE.Group;
  invalidate: () => void;
  fit: () => void;
  bounds: { width: number; depth: number; height: number };
}

const safe = (
  value: number | null | undefined,
  fallback: number,
  min = 0.01,
) => (Number.isFinite(value) ? Math.max(min, value as number) : fallback);
const format = (value: number | null) =>
  value === null || !Number.isFinite(value)
    ? "미입력"
    : `${value.toLocaleString("ko-KR", { maximumFractionDigits: 3 })} m`;

function disposeGroup(group: THREE.Group) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    // Sprite's quad geometry is shared by Three.js itself, rather than this view.
    if (mesh.geometry && !(object instanceof THREE.Sprite))
      geometries.add(mesh.geometry);
    if (mesh.material)
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material])
        materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material))
      if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  textures.forEach((texture) => texture.dispose());
  geometries.forEach((geometry) => geometry.dispose());
  group.clear();
}

function boxes(
  group: THREE.Group,
  items: Box[],
  color: THREE.ColorRepresentation,
  opacity = 1,
) {
  if (!items.length) return;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.73,
    metalness: 0.08,
    transparent: opacity < 1,
    opacity,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  const object = new THREE.Object3D();
  items.forEach((item, index) => {
    object.position.set(item.x, item.y, item.z);
    object.rotation.set(0, item.rotation ?? 0, 0);
    object.scale.set(safe(item.w, 0.1), safe(item.h, 0.1), safe(item.d, 0.1));
    object.updateMatrix();
    mesh.setMatrixAt(index, object.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  group.add(mesh);
}

function rectangle(
  group: THREE.Group,
  width: number,
  depth: number,
  height: number,
  color: THREE.ColorRepresentation,
  dashed = false,
) {
  const points = [
    new THREE.Vector3(0, height, 0),
    new THREE.Vector3(width, height, 0),
    new THREE.Vector3(width, height, depth),
    new THREE.Vector3(0, height, depth),
    new THREE.Vector3(0, height, 0),
  ];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.5, gapSize: 0.3 })
    : new THREE.LineBasicMaterial({ color });
  const line = new THREE.Line(geometry, material);
  if (dashed) line.computeLineDistances();
  group.add(line);
}

function label(
  group: THREE.Group,
  text: string,
  position: THREE.Vector3,
  width: number,
  color = "#40576c",
) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "rgba(250,253,255,.91)";
  context.beginPath();
  context.roundRect(3, 8, 1018, 112, 24);
  context.fill();
  context.font = '500 47px "Noto Sans KR Variable", sans-serif';
  context.fillStyle = color;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 512, 64, 980);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      depthWrite: false,
    }),
  );
  sprite.position.copy(position);
  sprite.scale.set(width, width / 8, 1);
  group.add(sprite);
}

/** A renderer only: no frame callback mutates the DES engine or planning inputs. */
export default function UiScene3D({ project, plan, snapshot = null }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const context = useRef<SceneContext | null>(null);
  const viewKey = useRef("");
  const [rendererState, setRendererState] = useState<
    "initializing" | "webgl" | "fallback"
  >("initializing");
  const [failure, setFailure] = useState("");
  const levels = Math.min(
    100,
    Math.max(1, Math.floor(plan.layout.requestedLevels)),
  );
  const vertical = resolveVerticalGeometry(plan, levels);
  const geometryValid =
    [vertical.pitch, vertical.totalHeight, vertical.topLoadHeight].every(
      Number.isFinite,
    ) &&
    vertical.pitch > 0 &&
    vertical.totalHeight > 0;
  const topLoad = vertical.topLoadHeight;
  const requiredHeight = vertical.totalHeight + plan.rack.topClearance;
  const rackCeilingExceeded =
    plan.building.clearHeight !== null &&
    requiredHeight > plan.building.clearHeight;
  const robotCeilingExceeded =
    plan.robot.overallHeight !== null &&
    plan.building.clearHeight !== null &&
    plan.robot.overallHeight > plan.building.clearHeight;
  const ceilingExceeded = rackCeilingExceeded || robotCeilingExceeded;
  const pitchTooSmall =
    geometryValid && vertical.pitch + 1e-9 < vertical.minPitch;
  const previewOnly = plan.layout.placements.length === 0;
  const renderLimit = Math.min(2000, Math.max(1, Math.floor(20000 / levels)));
  const placements = useMemo(
    () =>
      previewOnly
        ? [
            {
              id: "preview-rack",
              x: plan.building.width / 2,
              y: plan.building.depth / 2,
              width: plan.rack.width,
              depth: plan.rack.depth,
              rotation: 0 as const,
            },
          ]
        : plan.layout.placements.slice(0, renderLimit),
    [
      plan.layout.placements,
      previewOnly,
      plan.building.width,
      plan.building.depth,
      plan.rack.width,
      plan.rack.depth,
      renderLimit,
    ],
  );
  const modelKey = JSON.stringify({
    plan,
    objects: project.objects,
    nodes: project.nodes,
    edges: project.edges,
    background: project.background,
  });

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer | undefined;
    let frame = 0;
    let observer: ResizeObserver | undefined;
    let controls: OrbitControls | undefined;
    let lost: ((event: Event) => void) | undefined;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "low-power",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.25;
      renderer.domElement.setAttribute(
        "aria-label",
        "랙과 물류 공간 3D 검토 화면",
      );
      renderer.domElement.setAttribute("role", "img");
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      element.append(renderer.domElement);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#edf3f6");
      scene.add(new THREE.HemisphereLight(0xffffff, 0x8192a1, 2.5));
      const light = new THREE.DirectionalLight(0xffffff, 2.8);
      light.position.set(15, 35, 22);
      scene.add(light);
      const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 10000);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.maxPolarAngle = Math.PI / 2 - 0.035;
      controls.minDistance = 0.5;
      const model = new THREE.Group(),
        robots = new THREE.Group();
      scene.add(model, robots);
      let dirty = true;
      const ctx: SceneContext = {
        scene,
        camera,
        renderer,
        controls,
        model,
        robots,
        bounds: { width: 40, depth: 24, height: 7 },
        invalidate: () => {
          dirty = true;
        },
        fit: () => {
          const { width, depth, height } = ctx.bounds;
          const extent = Math.max(width, depth, height * 2);
          camera.position.set(
            width / 2 + extent * 0.72,
            height * 0.35 + extent * 0.72,
            depth / 2 + extent * 0.82,
          );
          controls!.target.set(width / 2, height * 0.3, depth / 2);
          controls!.maxDistance = Math.max(20, extent * 4);
          camera.near = Math.max(0.01, extent / 10000);
          camera.far = Math.max(100, extent * 20);
          camera.updateProjectionMatrix();
          controls!.update();
          dirty = true;
        },
      };
      controls.addEventListener("change", ctx.invalidate);
      observer = new ResizeObserver(() => {
        const width = Math.max(1, element.clientWidth),
          height = Math.max(1, element.clientHeight);
        renderer!.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        dirty = true;
      });
      observer.observe(element);
      lost = (event) => {
        event.preventDefault();
        setFailure(
          "브라우저의 WebGL 컨텍스트가 중단되었습니다. 화면을 다시 열거나 그래픽 가속 설정을 확인하세요.",
        );
        setRendererState("fallback");
      };
      renderer.domElement.addEventListener("webglcontextlost", lost);
      context.current = ctx;
      viewKey.current = "";
      const animate = () => {
        controls!.update();
        if (dirty) {
          renderer!.render(scene, camera);
          dirty = false;
        }
        frame = window.requestAnimationFrame(animate);
      };
      animate();
      setRendererState("webgl");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setRendererState("fallback");
    }
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      controls?.dispose();
      if (context.current) {
        disposeGroup(context.current.model);
        disposeGroup(context.current.robots);
      }
      context.current = null;
      if (renderer) {
        if (lost)
          renderer.domElement.removeEventListener("webglcontextlost", lost);
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      }
    };
  }, []);

  useEffect(() => {
    const ctx = context.current;
    if (!ctx || rendererState !== "webgl") return;
    disposeGroup(ctx.model);
    const width = safe(plan.building.width, 40),
      depth = safe(plan.building.depth, 24);
    const visibleTop = safe(requiredHeight, 5);
    const ceiling = plan.building.clearHeight;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshStandardMaterial({
        color: "#f6fafb",
        roughness: 1,
        side: THREE.DoubleSide,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(width / 2, -0.025, depth / 2);
    ctx.model.add(floor);
    const grid = new THREE.GridHelper(
      Math.max(width, depth),
      Math.min(120, Math.max(10, Math.ceil(Math.max(width, depth)))),
      "#bed0da",
      "#dde7ec",
    );
    grid.position.set(width / 2, 0.005, depth / 2);
    ctx.model.add(grid);
    rectangle(ctx.model, width, depth, 0.035, "#668d9b");
    if (ceiling !== null && ceiling > 0) {
      const ceilingMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(width, depth),
        new THREE.MeshBasicMaterial({
          color: ceilingExceeded ? "#df6b74" : "#8eb4c7",
          transparent: true,
          opacity: 0.065,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      ceilingMesh.rotation.x = -Math.PI / 2;
      ceilingMesh.position.set(width / 2, ceiling, depth / 2);
      ctx.model.add(ceilingMesh);
      rectangle(
        ctx.model,
        width,
        depth,
        ceiling,
        ceilingExceeded ? "#d15e69" : "#8faabb",
        true,
      );
      const vertical = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, ceiling, 0),
          new THREE.Vector3(width, 0, 0),
          new THREE.Vector3(width, ceiling, 0),
          new THREE.Vector3(width, 0, depth),
          new THREE.Vector3(width, ceiling, depth),
          new THREE.Vector3(0, 0, depth),
          new THREE.Vector3(0, ceiling, depth),
        ]),
        new THREE.LineDashedMaterial({
          color: "#adc0ca",
          dashSize: 0.3,
          gapSize: 0.25,
        }),
      );
      vertical.computeLineDistances();
      ctx.model.add(vertical);
      label(
        ctx.model,
        `유효 천장 높이 ${format(ceiling)}`,
        new THREE.Vector3(width / 2, ceiling + 0.3, 0),
        Math.max(5, Math.min(10, width / 2)),
        ceilingExceeded ? "#b94a57" : "#486e85",
      );
    }
    const uprights: Box[] = [],
      shelves: Box[] = [],
      loads: Box[] = [],
      conflictingLoads: Box[] = [];
    for (const placement of placements) {
      const w = safe(placement.width, 1.2),
        d = safe(placement.depth, 1.1),
        theta = (placement.rotation * Math.PI) / 180;
      const post = Math.max(0.045, Math.min(0.085, w * 0.045));
      if (!geometryValid) continue;
      const frameHeight = vertical.totalHeight;
      const add = (
        target: Box[],
        lx: number,
        y: number,
        lz: number,
        bw: number,
        bh: number,
        bd: number,
      ) =>
        target.push({
          x: placement.x + Math.cos(theta) * lx - Math.sin(theta) * lz,
          y,
          z: placement.y + Math.sin(theta) * lx + Math.cos(theta) * lz,
          w: bw,
          h: bh,
          d: bd,
          rotation: -theta,
        });
      for (const x of [-1, 1])
        for (const z of [-1, 1])
          add(
            uprights,
            (x * (w - post)) / 2,
            frameHeight / 2,
            (z * (d - post)) / 2,
            post,
            frameHeight,
            post,
          );
      for (let level = 0; level < levels; level++) {
        const h = safe(
          plan.rack.firstShelfHeight + level * vertical.pitch,
          0.1,
          0,
        );
        const beam = safe(plan.rack.beamThickness, 0.05, 0.001);
        // Input shelf height denotes the supporting surface, not deck centre.
        add(shelves, 0, h - beam / 2, 0, w, beam, d);
        for (const z of [-1, 1])
          add(uprights, 0, h - beam / 2, (z * (d - post)) / 2, w, beam, post);
        const blocked =
          pitchTooSmall ||
          (ceiling !== null &&
            h + plan.rack.loadHeight + plan.rack.topClearance > ceiling);
        add(
          blocked ? conflictingLoads : loads,
          0,
          h + safe(plan.rack.loadHeight, 0.8) / 2,
          0,
          w * 0.81,
          safe(plan.rack.loadHeight, 0.8),
          d * 0.8,
        );
      }
      // The supplied vertical core includes the upper beam in structure totalHeight.
      const capBeam = safe(plan.rack.beamThickness, 0.05, 0.001);
      add(shelves, 0, vertical.totalHeight - capBeam / 2, 0, w, capBeam, d);
    }
    boxes(ctx.model, uprights, "#526c7c");
    boxes(ctx.model, shelves, "#a7bdc9");
    boxes(
      ctx.model,
      loads,
      previewOnly ? "#9ec7bf" : "#d1b893",
      previewOnly ? 0.7 : 1,
    );
    boxes(ctx.model, conflictingLoads, "#e47b80", 0.93);
    // The dimensional review robot is distinct from the DES fleet visualisation.
    // Only provided footprint/transfer values are used for its measured parts.
    const robotPlan = plan.robot;
    let robotVisualizationTop = 0;
    if (
      robotPlan.width !== null &&
      robotPlan.length !== null &&
      robotPlan.width > 0 &&
      robotPlan.length > 0
    ) {
      const centerX = previewOnly
        ? width / 2 + plan.rack.width / 2 + robotPlan.length / 2 + 0.65
        : Math.min(
            width - robotPlan.length / 2,
            Math.max(robotPlan.length / 2, width * 0.12),
          );
      const centerZ = previewOnly
        ? depth / 2
        : Math.max(
            robotPlan.width / 2,
            Math.min(depth - robotPlan.width / 2, depth * 0.12),
          );
      const bodyHeight =
        robotPlan.overallHeight !== null
          ? Math.max(0.01, Math.min(0.28, robotPlan.overallHeight))
          : 0.28;
      boxes(
        ctx.model,
        [
          {
            x: centerX,
            y: bodyHeight / 2,
            z: centerZ,
            w: robotPlan.length,
            h: bodyHeight,
            d: robotPlan.width,
          },
        ],
        robotCeilingExceeded ? "#cf5e6c" : "#1b998e",
      );
      const platformBoxes: Box[] = [],
        mastBoxes: Box[] = [];
      let robotTop = 0.28;
      if (
        robotPlan.transferMode === "fixedLevels" &&
        robotPlan.firstShelfHeight !== null &&
        robotPlan.shelfPitch !== null &&
        robotPlan.shelfCount !== null &&
        robotPlan.shelfPitch > 0
      ) {
        const shelfCount = Math.max(
          1,
          Math.min(100, Math.floor(robotPlan.shelfCount)),
        );
        for (let level = 0; level < shelfCount; level++) {
          const elevation = Math.max(
            0,
            robotPlan.firstShelfHeight + level * robotPlan.shelfPitch,
          );
          platformBoxes.push({
            x: centerX,
            y: elevation - 0.0225,
            z: centerZ,
            w: robotPlan.length * 0.92,
            h: 0.045,
            d: robotPlan.width * 0.92,
          });
          robotTop = Math.max(robotTop, elevation + 0.1);
        }
      } else if (
        robotPlan.transferMode === "liftRange" &&
        robotPlan.minTransferHeight !== null &&
        robotPlan.maxLiftHeight !== null &&
        robotPlan.maxLiftHeight >= robotPlan.minTransferHeight
      ) {
        robotTop = Math.max(0.28, robotPlan.maxLiftHeight);
        platformBoxes.push({
          x: centerX,
          y: Math.max(0, robotPlan.minTransferHeight) - 0.0225,
          z: centerZ,
          w: robotPlan.length * 0.92,
          h: 0.045,
          d: robotPlan.width * 0.92,
        });
        platformBoxes.push({
          x: centerX,
          y: robotPlan.maxLiftHeight - 0.0225,
          z: centerZ,
          w: robotPlan.length * 0.92,
          h: 0.045,
          d: robotPlan.width * 0.92,
        });
      }
      const mastHeight = robotPlan.overallHeight ?? robotTop;
      if (platformBoxes.length || robotPlan.overallHeight !== null) {
        for (const side of [-1, 1])
          mastBoxes.push({
            x: centerX - robotPlan.length * 0.35,
            y: mastHeight / 2,
            z: centerZ + side * robotPlan.width * 0.36,
            w: 0.055,
            h: mastHeight,
            d: 0.055,
          });
        boxes(
          ctx.model,
          mastBoxes,
          robotCeilingExceeded ? "#cf5e6c" : "#297c79",
        );
        boxes(ctx.model, platformBoxes, "#60b4ab", 0.88);
      }
      robotVisualizationTop = Math.max(robotTop, mastHeight) + 0.5;
      label(
        ctx.model,
        `${robotPlan.kind === "ctu" ? "CTU" : robotPlan.kind === "lowProfile" ? "저상형" : "팔레트 AMR"} · 전고 ${format(robotPlan.overallHeight)}`,
        new THREE.Vector3(centerX, robotVisualizationTop, centerZ),
        Math.max(4.8, Math.min(8, width / 3)),
        robotCeilingExceeded ? "#b94a57" : "#177e74",
      );
    }
    const obstacleBoxes: Box[] = [];
    for (const object of project.objects) {
      if (["wait", "buffer", "pallet", "cart", "charger"].includes(object.kind))
        continue;
      // Applied 2D copies of these exact generated racks must not render twice.
      if (
        object.kind === "rack" &&
        placements.some(
          (p) =>
            Math.abs(p.x - object.x) < 0.001 &&
            Math.abs(p.y - object.y) < 0.001,
        )
      )
        continue;
      const height =
        object.kind === "column"
          ? safe(ceiling, 2.8)
          : object.kind === "wall"
            ? 2.5
            : 1.6;
      obstacleBoxes.push({
        x: object.x,
        y: height / 2,
        z: object.y,
        w: safe(object.width, 1),
        h: height,
        d: safe(object.height, 1),
        rotation: (-object.rotation * Math.PI) / 180,
      });
    }
    boxes(ctx.model, obstacleBoxes, "#becbd5", 0.72);
    const nodeMap = new Map(project.nodes.map((n) => [n.id, n]));
    const routePoints: THREE.Vector3[] = [];
    for (const edge of project.edges) {
      const from = nodeMap.get(edge.from),
        to = nodeMap.get(edge.to);
      if (from && to && !edge.disabled)
        routePoints.push(
          new THREE.Vector3(from.x, 0.045, from.y),
          new THREE.Vector3(to.x, 0.045, to.y),
        );
    }
    if (routePoints.length) {
      const routes = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(routePoints),
        new THREE.LineDashedMaterial({
          color: "#78bdb6",
          dashSize: 0.4,
          gapSize: 0.25,
        }),
      );
      routes.computeLineDistances();
      ctx.model.add(routes);
    }
    label(
      ctx.model,
      `가로 ${format(width)}`,
      new THREE.Vector3(width / 2, 0.2, depth + 0.75),
      Math.max(4, Math.min(8, width / 3)),
    );
    label(
      ctx.model,
      `깊이 ${format(depth)}`,
      new THREE.Vector3(width + 0.7, 0.2, depth / 2),
      Math.max(4, Math.min(8, depth / 3)),
    );
    if (previewOnly)
      label(
        ctx.model,
        `${levels}단 단일 랙 미리보기`,
        new THREE.Vector3(width / 2, visibleTop + 0.65, depth / 2),
        Math.max(5, Math.min(9, width / 3)),
        "#157d71",
      );
    const background = project.background;
    let active = true;
    let texture: THREE.Texture | undefined;
    if (background?.dataUrl && background.width > 0 && background.height > 0) {
      texture = new THREE.TextureLoader().load(background.dataUrl, (loaded) => {
        if (!active) {
          loaded.dispose();
          return;
        }
        loaded.colorSpace = THREE.SRGBColorSpace;
        const image = new THREE.Mesh(
          new THREE.PlaneGeometry(background.width, background.height),
          new THREE.MeshBasicMaterial({
            map: loaded,
            transparent: true,
            opacity: Math.max(0, Math.min(1, background.opacity)),
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        image.rotation.x = -Math.PI / 2;
        image.position.set(
          background.x + background.width / 2,
          0.015,
          background.y + background.height / 2,
        );
        ctx.model.add(image);
        ctx.invalidate();
      });
    }
    ctx.bounds = {
      width,
      depth,
      height: Math.max(
        visibleTop,
        safe(ceiling, visibleTop),
        robotVisualizationTop,
      ),
    };
    const fitKey = [
      width,
      depth,
      visibleTop,
      ceiling,
      robotVisualizationTop,
      placements.length,
      levels,
    ].join(":");
    if (viewKey.current !== fitKey) {
      viewKey.current = fitKey;
      ctx.fit();
    }
    ctx.invalidate();
    return () => {
      active = false;
      texture?.dispose();
    };
    // A content key avoids rebuilding geometry on unrelated React renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey, rendererState]);

  useEffect(() => {
    const ctx = context.current;
    if (!ctx || rendererState !== "webgl") return;
    disposeGroup(ctx.robots);
    const nodeMap = new Map(project.nodes.map((node) => [node.id, node]));
    const colors = new Map<string, Box[]>();
    for (const robot of project.robots) {
      const type = project.robotTypes.find((t) => t.id === robot.typeId),
        state = snapshot?.robots.find((r) => r.id === robot.id);
      const node = nodeMap.get(state?.nodeId ?? robot.nodeId);
      if (!type || !node) continue;
      let x = node.x,
        z = node.y,
        rotation = 0;
      if (state?.movement && snapshot) {
        const from = nodeMap.get(state.movement.from),
          to = nodeMap.get(state.movement.to);
        if (from && to) {
          const seconds = state.movement.endsAt - state.movement.startedAt;
          const fraction =
            seconds > 0
              ? Math.max(
                  0,
                  Math.min(
                    1,
                    ((state.movement.pausedAt ?? snapshot.time) -
                      state.movement.startedAt) /
                      seconds,
                  ),
                )
              : 1;
          x = from.x + (to.x - from.x) * fraction;
          z = from.y + (to.y - from.y) * fraction;
          rotation = -Math.atan2(to.y - from.y, to.x - from.x);
        }
      }
      const color =
        state?.status === "failed"
          ? "#cf5e6c"
          : state?.status === "charging"
            ? "#60aa6f"
            : "#159c91";
      const list = colors.get(color) ?? [];
      list.push({
        x,
        y: 0.18,
        z,
        w: type.length,
        h: 0.36,
        d: type.width,
        rotation,
      });
      colors.set(color, list);
      if (state?.carrying)
        boxes(
          ctx.robots,
          [
            {
              x,
              y: 0.65,
              z,
              w: type.length * 0.78,
              h: 0.55,
              d: type.width * 0.8,
              rotation,
            },
          ],
          "#d9bc86",
        );
    }
    for (const [color, items] of colors) boxes(ctx.robots, items, color);
    ctx.invalidate();
  }, [
    project.nodes,
    project.robots,
    project.robotTypes,
    snapshot,
    rendererState,
  ]);

  return (
    <section
      className="scene3d-shell"
      data-testid="planning-3d"
      data-renderer={rendererState}
      data-rack-total-height={geometryValid ? vertical.totalHeight : "unknown"}
      data-rack-pitch={geometryValid ? vertical.pitch : "unknown"}
      data-robot-overall-height={plan.robot.overallHeight ?? "unknown"}
    >
      <div className="scene3d-title">
        <div>
          <span className="scene3d-dot" />
          THREE.JS · 공간 · 높이 검토
        </div>
        <button
          className="button small"
          type="button"
          onClick={() => context.current?.fit()}
          disabled={rendererState !== "webgl"}
        >
          3D 화면 맞춤
        </button>
      </div>
      <div className="scene3d-stage">
        <div ref={host} className="scene3d-canvas" />
        {rendererState === "fallback" && (
          <div className="scene3d-fallback" role="status">
            <strong>이 브라우저에서 3D를 표시할 수 없습니다.</strong>
            <p>
              WebGL 2와 그래픽 가속을 지원하는 브라우저에서 다시 열어 주세요.
              치수 검토와 2D 편집은 계속 사용할 수 있습니다.
            </p>
            <small>{failure}</small>
          </div>
        )}
        {rendererState === "initializing" && (
          <div className="scene3d-loading">3D 검토 화면 준비 중…</div>
        )}
        <div className="scene3d-height-card">
          <span>{levels}단 랙 · 상부 빔 포함 구조 전체</span>
          <strong
            className={
              rackCeilingExceeded || pitchTooSmall ? "scene3d-conflict" : ""
            }
          >
            {format(vertical.totalHeight)}
          </strong>
          <small>
            해석 피치 {format(vertical.pitch)} · 적재물 상단 {format(topLoad)}
          </small>
          <small>천장 여유 포함 요구높이 {format(requiredHeight)}</small>
          <small>
            로봇 전고 {format(plan.robot.overallHeight)} · 유효 천장{" "}
            {format(plan.building.clearHeight)}
            {ceilingExceeded ? " · 높이 조건 초과" : ""}
          </small>
          {pitchTooSmall && (
            <small className="scene3d-conflict">
              제품·승강 여유·빔을 위한 최소 피치 부족
            </small>
          )}
        </div>
        <div className="scene3d-orbit-hint">
          드래그 회전 · 오른쪽 드래그 이동 · 휠 확대
        </div>
        {previewOnly && (
          <div className="scene3d-preview-tag">
            단일 랙 형상 미리보기 · 자동 배치 결과가 아닙니다
          </div>
        )}
      </div>
      <div className="scene3d-legend">
        <span>
          <i style={{ background: "#d1b893" }} />
          적재물
        </span>
        <span>
          <i style={{ background: "#526c7c" }} />랙 프레임
        </span>
        <span>
          <i style={{ background: "#e47b80" }} />
          높이·피치 조건 초과
        </span>
        <span>
          <i style={{ background: "#159c91" }} />
          로봇 표시
        </span>
        <span className="scene3d-axis">수평 X/Z · 높이 Y · m</span>
      </div>
      <p className="scene3d-note">
        {!geometryValid
          ? "유효한 높이 입력 전에는 랙 구조를 표시하지 않습니다. "
          : previewOnly
            ? "입력 랙 1개의 형상을 참고로 표시합니다. "
            : `배치 후보 ${plan.layout.placements.length.toLocaleString("ko-KR")}개를 표시합니다. `}
        {plan.layout.placements.length > renderLimit
          ? `현재 단수에서 렌더링은 앞 ${renderLimit.toLocaleString("ko-KR")}개 랙으로 제한됩니다. `
          : ""}
        랙 구조와 상부 빔은 공통 수직 검증 코어의 해석 치수를 사용합니다. 로봇
        전고는 입력값이며 인계 범위·선반 높이와 구별합니다. 기존 DES 설비·차체
        높이는 표시용 가정입니다. 검토 결과는 치수·사양 확인 상태와 함께
        판단하세요.
      </p>
    </section>
  );
}
