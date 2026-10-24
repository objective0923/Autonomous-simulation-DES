import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const localPython =
  process.platform === "win32"
    ? ".venv/Scripts/python.exe"
    : ".venv/bin/python";
const python = process.env.CROIS_PYTHON ?? localPython;
if (!existsSync(python) && !process.env.CROIS_PYTHON) {
  console.error("먼저 uv sync --frozen으로 Python 환경을 설치하세요.");
  process.exit(1);
}
const api = spawn(
  python,
  ["-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", "8000"],
  { stdio: "inherit" },
);
const web = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "0.0.0.0"],
  { stdio: "inherit" },
);
let exiting = false;
const cleanup = (code = 0) => {
  if (exiting) return;
  exiting = true;
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  process.exitCode = code;
};
process.on("SIGINT", () => cleanup());
process.on("SIGTERM", () => cleanup());
api.on("error", (e) => {
  console.error(e.message);
  cleanup(1);
});
web.on("error", (e) => {
  console.error(e.message);
  cleanup(1);
});
api.on("exit", (code) => cleanup(code ?? 0));
web.on("exit", (code) => cleanup(code ?? 0));
