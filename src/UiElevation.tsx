import { useMemo, useRef, useState } from "react";
import type { SpacePlan } from "./types";
import { buildElevationRows } from "./elevation";
import { resolveVerticalGeometry } from "./planning";
import { csvCell } from "./analysis";
import "./UiElevation.css";

export default function UiElevation({
  plan,
  levels = plan.layout.requestedLevels,
}: {
  plan: SpacePlan;
  levels?: number;
}) {
  const [unit, setUnit] = useState<"mm" | "m">("mm");
  const svgRef = useRef<SVGSVGElement>(null);
  const rows = useMemo(() => buildElevationRows(plan, levels), [plan, levels]);
  const format = (m: number | null) =>
    m === null
      ? "미입력"
      : (unit === "mm" ? m * 1000 : m).toLocaleString("ko-KR", {
          maximumFractionDigits: unit === "mm" ? 1 : 3,
        });
  const robot = plan.robot,
    rack = plan.rack;
  const geometry = resolveVerticalGeometry(plan, levels);
  const robotHeights =
    robot.firstShelfHeight !== null &&
    robot.shelfPitch !== null &&
    robot.shelfCount !== null
      ? Array.from(
          { length: Math.max(0, Math.min(100, Math.floor(robot.shelfCount))) },
          (_, i) => robot.firstShelfHeight! + i * robot.shelfPitch!,
        )
      : [];
  const requiredHeight = geometry.totalHeight + rack.topClearance;
  const maxHeight = Math.max(
    1,
    requiredHeight,
    plan.building.clearHeight ?? 0,
    robot.maxLiftHeight ?? 0,
    robot.overallHeight ?? 0,
    ...robotHeights,
  );
  const height = Math.min(
    1600,
    Math.max(570, Math.max(rows.length, robotHeights.length) * 34 + 150),
  );
  const floor = height - 75,
    scale = (height - 165) / (maxHeight * 1.08);
  const y = (m: number) => floor - m * scale;
  const stateColor = (status: string) =>
    status === "fail" ? "#dc5263" : status === "pass" ? "#109c89" : "#d1952b";
  const save = (name: string, content: string, type: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const svgExport = () => {
    if (svgRef.current)
      save(
        `CROIS-${rows.length}단-인계높이.svg`,
        new XMLSerializer().serializeToString(svgRef.current),
        "image/svg+xml",
      );
  };
  const csvExport = () => {
    const records: unknown[][] = [
      [
        "tier",
        "rack_handoff_m",
        "load_top_m",
        "robot_internal_shelf_m",
        "robot_minus_rack_m",
        "status",
        "reason",
      ],
      ...rows.map((r) => [
        r.tier,
        r.rackHeight,
        r.loadTop,
        r.robotShelfHeight,
        r.difference,
        r.status,
        r.reason,
      ]),
    ];
    save(
      `CROIS-${rows.length}단-인계높이.csv`,
      "\uFEFF" + records.map((r) => r.map(csvCell).join(",")).join("\r\n"),
      "text/csv;charset=utf-8",
    );
  };
  return (
    <section className="elevation-card" data-testid="rack-elevation">
      <div className="elevation-heading">
        <div>
          <span className="eyebrow">TRANSFER HEIGHT STUDY</span>
          <h3>로봇 · 랙 인계 높이 측면도</h3>
          <p>
            동일 바닥 기준 높이 비례 · 가로 폭은 도식 ·{" "}
            {robot.transferMode === "liftRange"
              ? "승강 범위 인계"
              : "고정 단 높이 매칭"}
          </p>
        </div>
        <div className="elevation-actions">
          <label>
            표시 단위{" "}
            <select
              aria-label="측면도 표시 단위"
              value={unit}
              onChange={(e) => setUnit(e.target.value as "mm" | "m")}
            >
              <option value="mm">mm</option>
              <option value="m">m</option>
            </select>
          </label>
          <button className="button small" onClick={svgExport}>
            측면도 SVG
          </button>
          <button className="button small" onClick={csvExport}>
            단별 높이 CSV
          </button>
        </div>
      </div>
      <div className="elevation-facts">
        <span>
          랙 <b>{rows.length}단</b>
        </span>
        <span>
          랙 피치{" "}
          <b>
            {format(geometry.pitch)} {unit}
          </b>
        </span>
        <span>
          구조 총높이{" "}
          <b>
            {format(geometry.totalHeight)} {unit}
          </b>
        </span>
        <span>
          로봇 내부 피치{" "}
          <b>
            {format(robot.shelfPitch)} {robot.shelfPitch === null ? "" : unit}
          </b>
        </span>
        <span>
          최저 인계{" "}
          <b>
            {format(robot.minTransferHeight)}{" "}
            {robot.minTransferHeight === null ? "" : unit}
          </b>
        </span>
        <span>
          최고 인계{" "}
          <b>
            {format(robot.maxLiftHeight)}{" "}
            {robot.maxLiftHeight === null ? "" : unit}
          </b>
        </span>
      </div>
      <div className="elevation-svg-scroll">
        <svg
          ref={svgRef}
          xmlns="http://www.w3.org/2000/svg"
          viewBox={`0 0 1000 ${height}`}
          role="img"
          aria-label={`${rows.length}단 랙과 로봇의 인계 높이 비교 측면도`}
          style={{ width: "100%", minWidth: 750, display: "block" }}
        >
          <defs>
            <marker
              id="elevation-arrow"
              markerWidth="6"
              markerHeight="6"
              refX="3"
              refY="3"
              orient="auto-start-reverse"
            >
              <path d="M0 0 6 3 0 6Z" fill="#516c92" />
            </marker>
            <pattern
              id="elevation-load"
              width="7"
              height="7"
              patternUnits="userSpaceOnUse"
            >
              <rect width="7" height="7" fill="#e8eff3" />
              <path d="M0 2H7M0 5H7" stroke="#a4b4bf" strokeWidth=".6" />
            </pattern>
          </defs>
          <rect width="1000" height={height} fill="#fbfcfe" />
          <text
            x="225"
            y="33"
            textAnchor="middle"
            fill="#243b53"
            fontSize="17"
            fontWeight="700"
          >
            로봇 내부 적재단
          </text>
          <text
            x="665"
            y="33"
            textAnchor="middle"
            fill="#243b53"
            fontSize="17"
            fontWeight="700"
          >
            랙 {rows.length}단
          </text>
          <text x="225" y="55" textAnchor="middle" fill="#637b91" fontSize="12">
            {robot.shelfCount === null
              ? "단수·첫 단 높이·피치 입력 필요"
              : `${robot.shelfCount}단 · 첫 단 ${format(robot.firstShelfHeight)} ${unit}`}
          </text>
          {robot.minTransferHeight !== null &&
            robot.maxLiftHeight !== null &&
            robot.maxLiftHeight >= robot.minTransferHeight && (
              <rect
                x="375"
                y={y(robot.maxLiftHeight)}
                width="420"
                height={(robot.maxLiftHeight - robot.minTransferHeight) * scale}
                fill="#0eaa9410"
              />
            )}
          {rows.map((r) => (
            <g key={r.tier}>
              <line
                x1="390"
                x2="806"
                y1={y(r.rackHeight)}
                y2={y(r.rackHeight)}
                stroke={stateColor(r.status)}
                strokeDasharray="4 5"
                opacity=".3"
              />
              <rect
                x="535"
                y={y(r.loadTop)}
                width="250"
                height={Math.max(1, rack.loadHeight * scale)}
                fill="url(#elevation-load)"
                stroke={r.status === "fail" ? "#dc5263" : "#8197a7"}
                strokeWidth="1"
              />
              <line
                x1="524"
                x2="799"
                y1={y(r.rackHeight)}
                y2={y(r.rackHeight)}
                stroke="#d1a936"
                strokeWidth="5"
              />
              <text
                x="510"
                y={y(r.rackHeight) + 4}
                textAnchor="end"
                fontSize="12"
                fill={stateColor(r.status)}
              >
                {r.tier}단
              </text>
              <text
                x="811"
                y={y(r.rackHeight) + 4}
                fontSize="12"
                fill={stateColor(r.status)}
              >
                {format(r.rackHeight)}
              </text>
            </g>
          ))}
          <line
            x1="526"
            x2="526"
            y1={floor}
            y2={y(geometry.totalHeight)}
            stroke="#263b4c"
            strokeWidth="6"
          />
          <line
            x1="797"
            x2="797"
            y1={floor}
            y2={y(geometry.totalHeight)}
            stroke="#263b4c"
            strokeWidth="6"
          />
          <rect
            x="522"
            y={y(geometry.totalHeight)}
            width="279"
            height={Math.max(2, rack.beamThickness * scale)}
            fill="#c9a633"
          />
          {robotHeights.length ? (
            <>
              <line
                x1="142"
                x2="142"
                y1={floor}
                y2={y(Math.max(...robotHeights)) - 14}
                stroke="#397ab5"
                strokeWidth="7"
              />
              <line
                x1="327"
                x2="327"
                y1={floor}
                y2={y(Math.max(...robotHeights)) - 14}
                stroke="#397ab5"
                strokeWidth="7"
              />
              {robotHeights.map((h, i) => (
                <g key={i}>
                  <rect
                    x="153"
                    y={y(h) - Math.min(22, scale * 0.18)}
                    width="162"
                    height={Math.min(22, scale * 0.18)}
                    fill="#d5e7f2"
                    stroke="#5887aa"
                  />
                  <line
                    x1="138"
                    x2="331"
                    y1={y(h)}
                    y2={y(h)}
                    stroke="#265f91"
                    strokeWidth="3"
                  />
                  <text
                    x="126"
                    y={y(h) + 4}
                    textAnchor="end"
                    fontSize="12"
                    fill="#426581"
                  >
                    {i + 1}단 · {format(h)}
                  </text>
                </g>
              ))}
              <rect
                x="130"
                y={floor - 18}
                width="211"
                height="18"
                rx="4"
                fill="#b6c9d8"
                stroke="#426581"
              />
              <circle cx="164" cy={floor} r="8" fill="#334f68" />
              <circle cx="307" cy={floor} r="8" fill="#334f68" />
            </>
          ) : (
            <>
              <rect
                x="144"
                y={floor - 120}
                width="185"
                height="115"
                rx="6"
                fill="#eff4f8"
                stroke="#8da5ba"
                strokeDasharray="5 4"
              />
              <text
                x="236"
                y={floor - 76}
                textAnchor="middle"
                fontSize="13"
                fill="#6c8499"
              >
                로봇 내부 적재단 미정
              </text>
              <text
                x="236"
                y={floor - 53}
                textAnchor="middle"
                fontSize="11"
                fill="#6c8499"
              >
                실제 사양 입력 후 표시
              </text>
            </>
          )}
          {robot.minTransferHeight !== null && (
            <g>
              <line
                x1="345"
                x2="818"
                y1={y(robot.minTransferHeight)}
                y2={y(robot.minTransferHeight)}
                stroke="#287db7"
                strokeDasharray="7 4"
              />
              <text
                x="350"
                y={y(robot.minTransferHeight) - 6}
                fontSize="12"
                fill="#287db7"
              >
                최저 인계 {format(robot.minTransferHeight)} {unit}
              </text>
            </g>
          )}
          {robot.maxLiftHeight !== null && (
            <g>
              <line
                x1="345"
                x2="818"
                y1={y(robot.maxLiftHeight)}
                y2={y(robot.maxLiftHeight)}
                stroke="#287db7"
                strokeDasharray="7 4"
              />
              <text
                x="350"
                y={y(robot.maxLiftHeight) - 6}
                fontSize="12"
                fill="#287db7"
              >
                최고 인계 {format(robot.maxLiftHeight)} {unit}
              </text>
            </g>
          )}
          {robot.overallHeight !== null && (
            <g>
              <line
                x1="350"
                x2="350"
                y1={floor}
                y2={y(robot.overallHeight)}
                stroke="#6872a5"
                strokeWidth="4"
              />
              <line
                x1="138"
                x2="350"
                y1={y(robot.overallHeight)}
                y2={y(robot.overallHeight)}
                stroke="#6872a5"
                strokeDasharray="4 3"
              />
              <text
                x="137"
                y={y(robot.overallHeight) - 7}
                fontSize="12"
                fill="#6872a5"
              >
                로봇 전고 {format(robot.overallHeight)} {unit}
              </text>
            </g>
          )}
          {plan.building.clearHeight !== null && (
            <g>
              <line
                x1="80"
                x2="970"
                y1={y(plan.building.clearHeight)}
                y2={y(plan.building.clearHeight)}
                stroke="#d16d38"
                strokeWidth="2"
                strokeDasharray="10 4"
              />
              <text
                x="82"
                y={y(plan.building.clearHeight) - 8}
                fontSize="13"
                fill="#a4582f"
              >
                최저 유효 천장 {format(plan.building.clearHeight)} {unit}
              </text>
            </g>
          )}
          <line
            x1="80"
            x2="970"
            y1={floor + 8}
            y2={floor + 8}
            stroke="#435a6b"
            strokeWidth="2"
          />
          <text x="83" y={floor + 29} fontSize="12" fill="#526c81">
            공통 바닥 기준 ±0
          </text>
          <line
            x1="918"
            x2="918"
            y1={floor + 4}
            y2={y(requiredHeight)}
            stroke="#516c92"
            markerStart="url(#elevation-arrow)"
            markerEnd="url(#elevation-arrow)"
          />
          <line
            x1="803"
            x2="935"
            y1={y(requiredHeight)}
            y2={y(requiredHeight)}
            stroke="#516c92"
          />
          <line
            x1="895"
            x2="935"
            y1={floor + 4}
            y2={floor + 4}
            stroke="#516c92"
          />
          <text
            x="940"
            y={(floor + y(requiredHeight)) / 2}
            fontSize="15"
            fill="#405b84"
            transform={`rotate(-90 940 ${(floor + y(requiredHeight)) / 2})`}
            textAnchor="middle"
          >
            필요 높이 {format(requiredHeight)} {unit}
          </text>
          <text
            x="500"
            y={height - 15}
            fontSize="12"
            textAnchor="middle"
            fill="#768c9d"
          >
            도식 검토용 · 구조/소방/제조사 인계 조건 별도 확인 · 모든 높이는
            동일 바닥 기준
          </text>
        </svg>
      </div>
      <p className="elevation-note">
        {robot.transferMode === "liftRange"
          ? "승강 범위 모드: 로봇 내부 단과 랙 단의 피치가 달라도 이동 가능한 인계 높이 범위로 판정합니다. 내부 적재단과 랙을 같은 단 번호로 연결한다는 뜻이 아닙니다."
          : `고정 단 모드: 같은 단 번호의 로봇·랙 인계면을 비교합니다. 허용 높이 차이는 ±${format(robot.alignmentTolerance)} ${unit}입니다.`}
      </p>
      <div className="table-scroll elevation-table">
        <table>
          <thead>
            <tr>
              <th>랙 단</th>
              <th>랙 인계면 ({unit})</th>
              <th>적재물 상단 ({unit})</th>
              <th>로봇 내부 단 ({unit})</th>
              <th>높이 차 ({unit})</th>
              <th>검토</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tier}>
                <td>{r.tier}단</td>
                <td>{format(r.rackHeight)}</td>
                <td>{format(r.loadTop)}</td>
                <td>{format(r.robotShelfHeight)}</td>
                <td>{format(r.difference)}</td>
                <td style={{ color: stateColor(r.status) }}>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
