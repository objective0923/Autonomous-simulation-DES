import { describe, expect, it } from "vitest";
import {
  EXAMPLE_INPUT,
  computeMaxLevels,
  evaluate,
  EPS,
  mm,
  parseMillimeterInput,
  resolveRackGeometry,
  scanLevels,
  simulate,
  toMm,
  validateInput,
  type RackVerticalInput,
} from "../src/vertical";

/** 예제 입력을 복사해 일부만 바꾼다 (mm 단위로 지정) */
function input(
  over: {
    space?: number;
    prod?: number;
    robot?: number;
    workMax?: number;
    workMin?: number;
    levels?: number;
    rackH?: number | null;
    base?: number;
    lift?: number;
    beam?: number;
    ceil?: number;
  } = {},
): RackVerticalInput {
  const e = EXAMPLE_INPUT;
  const a = e.assumptions;
  return {
    spaceClearHeight:
      over.space !== undefined ? mm(over.space) : e.spaceClearHeight,
    product: {
      height: over.prod !== undefined ? mm(over.prod) : e.product.height,
    },
    robot: {
      overallHeight:
        over.robot !== undefined ? mm(over.robot) : e.robot.overallHeight,
      workSurfaceMax:
        over.workMax !== undefined ? mm(over.workMax) : e.robot.workSurfaceMax,
      workSurfaceMin:
        over.workMin !== undefined ? mm(over.workMin) : e.robot.workSurfaceMin,
    },
    rack: {
      levels: over.levels ?? e.rack.levels,
      totalHeight:
        over.rackH === null
          ? undefined
          : over.rackH !== undefined
            ? mm(over.rackH)
            : e.rack.totalHeight,
    },
    assumptions: {
      firstShelfHeight:
        over.base !== undefined ? mm(over.base) : a.firstShelfHeight,
      liftClearance: over.lift !== undefined ? mm(over.lift) : a.liftClearance,
      beamThickness: over.beam !== undefined ? mm(over.beam) : a.beamThickness,
      ceilingClearance:
        over.ceil !== undefined ? mm(over.ceil) : a.ceilingClearance,
    },
  };
}
const check = (r: ReturnType<typeof evaluate>, id: string) =>
  r.checks.find((c) => c.id === id)!;
const near = (m: number, expectedMm: number) =>
  expect(toMm(m)).toBeCloseTo(expectedMm, 3);

describe("예제 (도면 6단, 2,699 mm)", () => {
  it("설치 가능으로 판정한다", () => {
    const r = evaluate(input());
    expect(r.feasible).toBe(true);
    near(r.minPitch, 420);
    near(r.pitch, (2699 - 150) / 6);
    near(r.levelDetails[5].shelfHeight, 150 + 5 * ((2699 - 150) / 6));
    near(r.headroom, 301);
  });

  it("최대 단수는 6, 공간과 로봇이 함께 제한한다", () => {
    const m = computeMaxLevels(input());
    expect(m).toMatchObject({
      bySpace: 6,
      byRobot: 6,
      max: 6,
      binding: "both",
    });
  });
});

describe("랙 높이 생략 시 최소 높이", () => {
  it("6단 최소 높이 = 150 + 6 × 420 = 2,670 mm", () => {
    const r = evaluate(input({ rackH: null }));
    expect(r.totalHeightIsMinimum).toBe(true);
    near(r.totalHeight, 2670);
    expect(r.feasible).toBe(true);
  });

  it("7단은 천장 이격과 로봇 도달 모두 초과", () => {
    const r = evaluate(input({ levels: 7, rackH: null }));
    near(r.totalHeight, 150 + 7 * 420); // 3,090 mm
    expect(check(r, "ceiling").pass).toBe(false);
    expect(check(r, "robotReach").pass).toBe(false);
    expect(r.levelDetails[6].reach).toBe("tooHigh");
    expect(r.feasible).toBe(false);
  });
});

describe("개별 검사", () => {
  it("랙 높이가 낮아 피치가 최소보다 작으면 불가", () => {
    const r = evaluate(input({ rackH: 2600 }));
    expect(check(r, "pitch").pass).toBe(false);
    expect(r.levelDetails[0].clearanceAbove).toBeLessThan(mm(70));
  });

  it("경계값(랙 상단 = 한계)은 통과", () => {
    const r = evaluate(input({ space: 2970, rackH: null }));
    near(r.rackTopLimit, 2670);
    expect(check(r, "ceiling").pass).toBe(true);
  });

  it("1단 선반이 로봇 최저 작업면보다 낮으면 tooLow", () => {
    const r = evaluate(input({ workMin: 200 }));
    expect(r.levelDetails[0].reach).toBe("tooLow");
    expect(check(r, "robotReach").pass).toBe(false);
    expect(computeMaxLevels(input({ workMin: 200 })).byRobot).toBe(0);
  });

  it("로봇 전고가 공간보다 높으면 불가", () => {
    const r = evaluate(input({ robot: 3100, space: 3050 }));
    expect(check(r, "robotOverall").pass).toBe(false);
  });
});

describe("공간에 따라 단수가 바뀐다", () => {
  it("공간이 높아도 로봇 작업면이 제한하면 6단, 다음 단에 필요한 작업면 제시", () => {
    const m = computeMaxLevels(input({ space: 4000 }));
    expect(m).toMatchObject({
      bySpace: 8,
      byRobot: 6,
      max: 6,
      binding: "robot",
    });
    near(m.workSurfaceMaxForNext, 2670);
  });

  it("로봇 작업면이 충분하면 공간이 제한하고, 다음 단에 필요한 공간 높이 제시", () => {
    // The robot must fit the room before space-only tier capacity is meaningful.
    const m = computeMaxLevels(
      input({ space: 3000, robot: 2800, workMax: 2700 }),
    );
    expect(m.binding).toBe("space");
    expect(m.max).toBe(6); // floor((2700 − 150) / 420) = 6
    near(m.spaceHeightForNext, 150 + 7 * 420 + 300);
  });

  it("단수별 스캔에서 1~6단 가능, 7·8단 불가", () => {
    const rows = scanLevels(input());
    expect(rows.map((r) => r.feasible)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("입력 검증", () => {
  const codes = (i: RackVerticalInput) =>
    validateInput(i)
      .filter((x) => x.severity === "error")
      .map((x) => x.code);

  it("예제 입력은 오류 없음", () => expect(codes(input())).toEqual([]));
  it("최고 작업면 > 로봇 전고", () =>
    expect(codes(input({ workMax: 3100 }))).toContain("WORK_ABOVE_ROBOT"));
  it("최저 ≥ 최고 작업면", () =>
    expect(codes(input({ workMin: 2600 }))).toContain("WORK_RANGE_INVERTED"));
  it("단수 0 또는 소수", () => {
    expect(codes(input({ levels: 0 }))).toContain("INVALID_LEVELS");
    expect(codes(input({ levels: 2.5 }))).toContain("INVALID_LEVELS");
  });
  it("제품 높이 0", () =>
    expect(codes(input({ prod: 0 }))).toContain("OUT_OF_RANGE"));
  it("랙 높이 ≤ 1단 선반면", () =>
    expect(codes(input({ rackH: 100 }))).toContain("RACK_BELOW_FIRST_SHELF"));
  it("NaN 입력", () =>
    expect(codes({ ...input(), spaceClearHeight: Number.NaN })).toContain(
      "NOT_A_NUMBER",
    ));
  it("오류가 있으면 simulate 결과는 null", () => {
    const s = simulate(input({ levels: 0 }));
    expect(s.result).toBeNull();
    expect(s.scan).toEqual([]);
  });
});

describe("재현성", () => {
  it("같은 입력이면 결과가 같다", () => {
    const t = new Date("2026-10-24T00:00:00Z");
    expect(simulate(input(), t)).toEqual(simulate(input(), t));
    expect(simulate(input(), t).engine.version).toBe("0.1.1");
  });
});

describe("통합 보강 · 유효 공간과 입력 방어", () => {
  it("전고가 유효 공간을 초과하면 작업 범위가 넓어도 최대 단수는 0", () => {
    const i = input({ space: 2600, robot: 4000, workMax: 3600 });
    const r = evaluate(i);
    expect(check(r, "robotOverall").pass).toBe(false);
    expect(r.maxLevels.max).toBe(0);
    expect(r.maxLevels.byRobot).toBe(0);
    expect(r.maxLevels.binding).toBe("robot");
    expect(r.maxLevels.spaceHeightForNext).toBeGreaterThanOrEqual(
      i.robot.overallHeight,
    );
    expect(scanLevels(i, 8).every((row) => !row.feasible)).toBe(true);
  });

  it("공간과 전고 경계값은 EPS m 허용 오차 안에서 통과한다", () => {
    const i = input({ rackH: null });
    i.robot.overallHeight = i.spaceClearHeight + EPS / 2;
    expect(computeMaxLevels(i).max).toBe(6);
    i.robot.overallHeight = i.spaceClearHeight + EPS * 2;
    expect(computeMaxLevels(i).max).toBe(0);
  });

  it("SI 단위 floor 허용 오차를 공간 높이와 작업면 모두에 일관되게 적용한다", () => {
    const i = input({ rackH: null, robot: 2900, workMax: 2670 });
    i.spaceClearHeight = mm(3090) + mm(300) - EPS / 2;
    i.robot.overallHeight = i.spaceClearHeight;
    expect(computeMaxLevels(i).bySpace).toBe(7);
    i.robot.workSurfaceMax = mm(2670) - EPS / 2;
    expect(computeMaxLevels(i).byRobot).toBe(7);
  });

  it("null·배열·부분 입력에서도 validator는 예외 없이 오류 목록을 돌려준다", () => {
    for (const invalid of [
      null,
      undefined,
      [],
      1,
      "",
      {},
      { product: null, robot: [], rack: 0, assumptions: null },
    ]) {
      expect(() => validateInput(invalid)).not.toThrow();
      expect(validateInput(invalid).some((i) => i.severity === "error")).toBe(
        true,
      );
      expect(simulate(invalid as never).result).toBeNull();
      expect(simulate(invalid as never).scan).toEqual([]);
    }
    expect(
      validateInput(input({ robot: 0 })).some((i) => i.code === "OUT_OF_RANGE"),
    ).toBe(true);
  });

  it("단수와 스캔 범위는 1~100 정수로 제한한다", () => {
    for (const n of [0, -1, 1.5, 101, Infinity, NaN]) {
      expect(() => scanLevels(input(), n)).toThrow();
      expect(
        validateInput(input({ levels: n })).some(
          (i) => i.code === "INVALID_LEVELS",
        ),
      ).toBe(true);
    }
    expect(
      scanLevels(input({ space: 100000, robot: 100000, workMax: 90000 }), 100),
    ).toHaveLength(100);
    expect(
      scanLevels(input({ space: 100000, robot: 100000, workMax: 90000 })),
    ).toHaveLength(100);
  });

  it("유한한 입력값끼리 계산 중 넘치는 경우도 검증 오류로 돌려준다", () => {
    const huge = input();
    huge.product.height = Number.MAX_VALUE;
    expect(
      validateInput(huge).some((i) => i.code === "CALCULATION_RANGE"),
    ).toBe(true);
    expect(simulate(huge).result).toBeNull();
    const tiny = input({ lift: 0, beam: 0 });
    tiny.product.height = Number.MIN_VALUE;
    expect(
      validateInput(tiny).some((i) => i.code === "CALCULATION_RANGE"),
    ).toBe(true);
    expect(simulate(tiny).result).toBeNull();
  });

  it("공유 기하 함수와 평가 결과가 동일한 피치·상부 빔 모델을 사용한다", () => {
    const i = input();
    const g = resolveRackGeometry(i);
    const r = evaluate(i);
    expect(g.totalHeight).toBe(r.totalHeight);
    expect(g.pitch).toBe(r.pitch);
    expect(g.topShelfHeight).toBe(r.levelDetails[5].shelfHeight);
    expect(g.topLoadHeight).toBe(r.levelDetails[5].productTop);
    expect(g.clearanceAbove).toBe(r.levelDetails[5].clearanceAbove);
    near(g.minPitch, 420);
    near(resolveRackGeometry(input({ rackH: null })).totalHeight, 2670);
  });
});

describe("명시적 mm JSON 가져오기", () => {
  const mmInput = {
    _note: "첨부 6단 2699 mm 검토용 가정",
    spaceClearHeight_mm: 3000,
    product: { id: "tote-std", height_mm: 300 },
    robot: {
      id: "ctu-example",
      overallHeight_mm: 3000,
      workSurfaceMax_mm: 2600,
      workSurfaceMin_mm: 100,
    },
    rack: { levels: 6, totalHeight_mm: 2699 },
    assumptions_mm: {
      firstShelfHeight: 150,
      liftClearance: 70,
      beamThickness: 50,
      ceilingClearance: 300,
    },
  };
  it("제공된 2699 mm 예시를 내부 m 단위로 변환한다", () => {
    const imported = parseMillimeterInput(JSON.parse(JSON.stringify(mmInput)));
    expect(imported).toEqual(EXAMPLE_INPUT);
    expect(evaluate(imported).feasible).toBe(true);
    near(evaluate(imported).totalHeight, 2699);
    near(evaluate(imported).headroom, 301);
  });
  it("mm 높이를 생략하면 최소 높이를 사용하며 모호한 숫자 문자열·혼합 단위는 거절한다", () => {
    const automatic = structuredClone(mmInput) as Record<string, unknown>;
    automatic.rack = { levels: 6 };
    near(evaluate(parseMillimeterInput(automatic)).totalHeight, 2670);
    expect(() =>
      parseMillimeterInput({ ...mmInput, spaceClearHeight_mm: "3000" }),
    ).toThrow();
    expect(() =>
      parseMillimeterInput({ ...mmInput, spaceClearHeight: 3 }),
    ).toThrow();
    expect(() =>
      parseMillimeterInput({
        ...mmInput,
        rack: { levels: 6, totalHeight: 2.699 },
      }),
    ).toThrow();
    expect(() =>
      parseMillimeterInput({ ...mmInput, rack: { levels: 0 } }),
    ).toThrow();
    expect(() => parseMillimeterInput(null)).toThrow();
  });
});
