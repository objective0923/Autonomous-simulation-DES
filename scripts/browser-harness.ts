import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium as playwright } from "playwright";
import chromium from "@sparticuz/chromium";

export async function browserHarness(port = 4173, apiPort = 8011) {
  const python =
    process.env.CROIS_PYTHON ??
    (process.platform === "win32"
      ? ".venv/Scripts/python.exe"
      : ".venv/bin/python");
  const api = spawn(
    python,
    [
      "-m",
      "uvicorn",
      "backend.app:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(apiPort),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      env: { ...process.env, CROIS_API_PROXY: `http://127.0.0.1:${apiPort}` },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  for (const child of [api, server]) {
    child.stdout?.on("data", (d) => {
      output += String(d);
    });
    child.stderr?.on("data", (d) => {
      output += String(d);
    });
  }
  const stop = () => {
    api.kill("SIGTERM");
    server.kill("SIGTERM");
  };
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (api.exitCode !== null || server.exitCode !== null)
        throw new Error(output);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok && (await response.json()).engine === "SimPy") {
          ready = true;
          break;
        }
      } catch {
        /* Startup retry. */
      }
      await delay(100);
    }
    if (!ready) throw new Error(`웹·SimPy 서버 준비 시간 초과: ${output}`);
    const browser = await playwright.launch({
      executablePath:
        process.env.CHROMIUM_PATH ?? (await chromium.executablePath()),
      args: chromium.args,
      headless: true,
    });
    return {
      browser,
      url: `http://127.0.0.1:${port}`,
      close: async () => {
        await browser.close();
        stop();
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}
