import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Run project Python without activating a shell-specific virtual environment.
const localPython = path.resolve(
  process.platform === "win32"
    ? ".venv/Scripts/python.exe"
    : ".venv/bin/python",
);
const python = process.env.CROIS_PYTHON ?? localPython;
if (!process.env.CROIS_PYTHON && !existsSync(localPython)) {
  console.error("Python 환경이 없습니다. 먼저 uv sync --frozen을 실행하세요.");
  process.exit(1);
}
const child = spawn(python, process.argv.slice(2), { stdio: "inherit" });
child.on("error", (error) => {
  console.error(`Python 실행 실패: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
