"""Headless SimPy entry point; never needs Node or a web server."""
from __future__ import annotations
import argparse
import copy
import csv
import json
import math
from pathlib import Path
import statistics
from .engine import SimulationEngine

ROOT = Path(__file__).resolve().parent.parent

def summary(values: list[float]) -> dict:
    n = len(values)
    mean = statistics.mean(values)
    if n < 2:
        return {"n": n, "mean": mean, "standardDeviation": None, "confidence95": None, "method": "반복 1회: 평균 신뢰구간을 산출하지 않습니다."}
    t_table = [0,12.706,4.303,3.182,2.776,2.571,2.447,2.365,2.306,2.262,2.228,2.201,2.179,2.16,2.145,2.131,2.12,2.11,2.101,2.093,2.086,2.08,2.074,2.069,2.064,2.06,2.056,2.052,2.048,2.045,2.042]
    t = t_table[n-1] if n <= 31 else 2.042 if n <= 60 else 2.001
    sd = statistics.stdev(values)
    margin = t * sd / math.sqrt(n)
    return {"n": n, "mean": mean, "standardDeviation": sd, "confidence95": [mean-margin, mean+margin], "method": "독립 시드 반복의 표본 표준편차와 Student t 평균 95% CI (보수적 자유도); 개별 작업 지연 P95와 구별"}

def write(filename: str, data: dict) -> None:
    p = Path(filename); p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    print(f"저장: {p}")

def main() -> None:
    parser = argparse.ArgumentParser(description="CROIS Python SimPy DES · m, s, kg, Wh, W")
    parser.add_argument("--project", default=str(ROOT / "examples/demo.json"))
    parser.add_argument("--seed", type=int)
    parser.add_argument("--duration", type=float)
    parser.add_argument("--output")
    parser.add_argument("--csv")
    parser.add_argument("--replications", type=int)
    parser.add_argument("--benchmarks", action="store_true")
    args = parser.parse_args()
    project = json.loads(Path(args.project).read_text(encoding="utf-8"))
    if args.seed is not None: project["settings"]["seed"] = args.seed
    if args.duration is not None: project["settings"]["duration"] = args.duration
    if args.benchmarks:
        output = {}
        for name in ("singleRobot", "corridor", "charging", "bufferSaturation", "materialStarvation", "equipmentFailure"):
            file = ROOT / "examples" / f"{name}.json"
            input_project = json.loads(file.read_text(encoding="utf-8"))
            result = SimulationEngine(input_project).run()
            output[file.stem] = {"input": input_project, "result": result}
            print(f"{file.stem}: {json.dumps(result['kpis'], ensure_ascii=False)}")
    elif args.replications:
        if not 1 <= args.replications <= 100: parser.error("반복 횟수는 1~100 정수여야 합니다.")
        if args.csv: parser.error("반복 실행에서는 JSON 출력을 사용하세요.")
        seeds = list(range(project["settings"]["seed"], project["settings"]["seed"] + args.replications))
        runs = []
        for seed in seeds:
            input_project = copy.deepcopy(project); input_project["settings"]["seed"] = seed
            runs.append(SimulationEngine(input_project).run())
        output = {"input": project, "seeds": seeds, "runs": runs,
                  **{k: summary([r["kpis"][k] for r in runs]) for k in ("productionPerHour", "transportPerHour", "meanLeadTime")}}
        print(json.dumps({k: output[k] for k in ("productionPerHour", "transportPerHour", "meanLeadTime")}, ensure_ascii=False, indent=2))
    else:
        result = SimulationEngine(project).run()
        output = {"input": project, "result": result}
        print(json.dumps({"engineVersion": result["engineVersion"], "seed": result["seed"], "horizon": result["horizon"], "kpis": result["kpis"], "diagnostics": result["diagnostics"]}, ensure_ascii=False, indent=2, allow_nan=False))
        if args.csv:
            p = Path(args.csv); p.parent.mkdir(parents=True, exist_ok=True)
            columns = ["sequence", "time", "kind", "robotId", "jobId", "resourceId", "message", "cause"]
            def cell(v):
                s = str(v) if v is not None else ""
                return "'"+s if s and s[0] in "=+-@\t\r" else s
            with p.open("w", newline="", encoding="utf-8-sig") as stream:
                writer = csv.writer(stream); writer.writerow(columns)
                writer.writerows([[cell(e.get(k)) for k in columns] for e in result["events"]])
    if args.output: write(args.output, output)

if __name__ == "__main__":
    main()
