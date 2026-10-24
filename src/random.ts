import type { Distribution } from "./types";

/** A named stream is unaffected by draws from every other process/stream. */
export function createRandom(seed: number, streamName: string): () => number {
  if (!Number.isSafeInteger(seed))
    throw new RangeError("난수 시드는 안전한 정수여야 합니다.");
  let state = 2166136261;
  for (const char of `${seed}:${streamName}`) {
    state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function checked(value: number, label: string, positive = false): number {
  if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new RangeError(
      `${label}: 유한한 ${positive ? "양수" : "0 이상 값"}가 필요합니다.`,
    );
  }
  return value;
}

function draw(rng: () => number): number {
  const u = rng();
  if (!Number.isFinite(u) || u < 0 || u >= 1)
    throw new RangeError("난수 생성기는 [0, 1) 값을 반환해야 합니다.");
  return u;
}

function standardNormal(rng: () => number): number {
  // 1-u is strictly positive, including the valid u=0 endpoint.
  return (
    Math.sqrt(-2 * Math.log(1 - draw(rng))) * Math.cos(2 * Math.PI * draw(rng))
  );
}

/** Samples durations in seconds. Invalid/overflowing models fail explicitly. */
export function sampleDistribution(
  distribution: Distribution,
  rng: () => number,
): number {
  let result: number;
  switch (distribution.kind) {
    case "fixed":
      return checked(distribution.value, "고정 시간");
    case "uniform": {
      const min = checked(distribution.min, "균등분포 최소값");
      const max = checked(distribution.max, "균등분포 최대값");
      if (max < min) throw new RangeError("균등분포: min ≤ max가 필요합니다.");
      return min + (max - min) * draw(rng);
    }
    case "triangular": {
      const { min, mode, max } = distribution;
      checked(min, "삼각분포 최소값");
      checked(mode, "삼각분포 최빈값");
      checked(max, "삼각분포 최대값");
      if (min > mode || mode > max)
        throw new RangeError("삼각분포: min ≤ mode ≤ max가 필요합니다.");
      if (min === max) return min;
      const u = draw(rng);
      const fraction = (mode - min) / (max - min);
      result =
        u < fraction
          ? min + Math.sqrt(u * (max - min) * (mode - min))
          : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
      break;
    }
    case "normal": {
      const { mean, sd, min, max } = distribution;
      checked(min, "절단 정규분포 최소값");
      checked(max, "절단 정규분포 최대값");
      checked(sd, "정규분포 표준편차");
      if (!Number.isFinite(mean) || max < min)
        throw new RangeError("절단 정규분포의 매개변수가 올바르지 않습니다.");
      if (sd === 0) {
        if (mean < min || mean > max)
          throw new RangeError(
            "표준편차 0의 평균은 절단 범위 안에 있어야 합니다.",
          );
        return mean;
      }
      if (min === max) return min;
      // Rejection, rather than clamping, preserves the conditional normal law.
      for (let i = 0; i < 10_000; i++) {
        result = mean + sd * standardNormal(rng);
        if (result >= min && result <= max) return result;
      }
      throw new RangeError(
        "절단 정규분포 추출 한도 초과: 평균·표준편차·절단 범위를 검토하세요.",
      );
    }
    case "lognormal": {
      if (!Number.isFinite(distribution.mu))
        throw new RangeError("로그정규분포 mu는 유한해야 합니다.");
      checked(distribution.sigma, "로그정규분포 sigma");
      result = Math.exp(
        distribution.mu + distribution.sigma * standardNormal(rng),
      );
      break;
    }
    case "exponential":
      result =
        -checked(distribution.mean, "지수분포 평균", true) *
        Math.log(1 - draw(rng));
      break;
    case "empirical": {
      if (
        !Array.isArray(distribution.values) ||
        distribution.values.length === 0
      ) {
        throw new RangeError("실측 샘플은 하나 이상 필요합니다.");
      }
      distribution.values.forEach((value) => checked(value, "실측 샘플"));
      return distribution.values[
        Math.floor(draw(rng) * distribution.values.length)
      ];
    }
    default:
      throw new RangeError("지원하지 않는 시간 분포입니다.");
  }
  return checked(result, "분포 추출 결과");
}
