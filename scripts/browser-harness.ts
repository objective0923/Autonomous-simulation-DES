import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium as playwright } from "playwright";
import chromium from "@sparticuz/chromium";

export async function browserHarness(port = 4173, apiPort = 8011) {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "crois-browser-data-"),
  );
  const python =
    process.env.CROIS_PYTHON ??
    (process.platform === "win32"
      ? ".venv/Scripts/python.exe"
      : ".venv/bin/python");
  const startApi = () =>
    spawn(
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
      {
        env: { ...process.env, CROIS_DATA_DIR: dataDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  let api = startApi();
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
  const stop = async () => {
    api.kill("SIGTERM");
    server.kill("SIGTERM");
    for (
      let i = 0;
      i < 40 &&
      [api, server].some(
        (child) => child.exitCode === null && child.signalCode === null,
      );
      i++
    )
      await delay(50);
    await rm(dataDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  };
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (api.exitCode !== null || server.exitCode !== null)
        throw new Error(output);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (
          response.ok &&
          (await response.json()).engine === "SimPy" &&
          output.includes(`Uvicorn running on http://127.0.0.1:${apiPort}`) &&
          output.includes(`:${port}/`)
        ) {
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
      dataDirectory,
      restartApi: async () => {
        const previous = api;
        previous.kill("SIGTERM");
        for (
          let i = 0;
          i < 50 && previous.exitCode === null && previous.signalCode === null;
          i++
        )
          await delay(100);
        if (previous.exitCode === null && previous.signalCode === null)
          throw new Error("테스트 API 종료 시간 초과");
        api = startApi();
        for (let i = 0; i < 100; i++) {
          try {
            if ((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok)
              return;
          } catch {
            /* Startup retry. */
          }
          if (api.exitCode !== null) break;
          await delay(100);
        }
        throw new Error("테스트 API 재시작 실패");
      },
      close: async () => {
        try {
          await browser.close();
        } finally {
          await stop();
        }
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
