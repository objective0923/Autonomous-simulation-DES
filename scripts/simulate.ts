import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const localPython =
  process.platform === "win32"
    ? ".venv/Scripts/python.exe"
    : ".venv/bin/python";
const python =
  process.env.CROIS_PYTHON ??
  (existsSync(localPython) ? localPython : "python3");
const child = spawn(python, ["-m", "backend.cli", ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(
    `Python 실행 실패: ${error.message}. 먼저 uv sync --frozen을 실행하세요.`,
  );
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
