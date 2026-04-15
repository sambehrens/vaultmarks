import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(__dirname, ".test-state.json");
const SERVER_PORT = 3001;

interface TestState {
  serverPort: number;
  serverPid: number;
  extensionDist: string;
  extensionFirefoxDist: string;
  pgContainerId: string;
}

function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket
        .on("connect", () => {
          socket.destroy();
          resolve();
        })
        .on("error", () => {
          socket.destroy();
          if (Date.now() - start >= timeoutMs) {
            reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
          } else {
            setTimeout(attempt, 200);
          }
        })
        .on("timeout", () => {
          socket.destroy();
          if (Date.now() - start >= timeoutMs) {
            reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
          } else {
            setTimeout(attempt, 200);
          }
        })
        .connect(port, "127.0.0.1");
    }
    attempt();
  });
}

export default async function globalSetup(): Promise<void> {
  // 1. Start PostgreSQL 16 testcontainer
  console.log("[setup] Starting PostgreSQL testcontainer…");
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const pgContainer = await new PostgreSqlContainer("postgres:18-alpine").start();
  const pgContainerId = pgContainer.getId();
  const databaseUrl = pgContainer.getConnectionUri();
  console.log(`[setup] PostgreSQL ready: ${databaseUrl}`);

  // 2. Build the server binary
  console.log("[setup] Building server binary…");
  execSync("cargo build", {
    cwd: path.join(REPO_ROOT, "server"),
    stdio: "inherit",
  });
  console.log("[setup] Server binary built.");

  // 3. Spawn the server
  console.log("[setup] Spawning server on port 3001…");
  const serverBin = path.join(REPO_ROOT, "server/target/debug/server");
  const serverProc = spawn(serverBin, [], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      JWT_SECRET: "test-jwt-secret-must-be-at-least-32-chars-xx",
      PORT: String(SERVER_PORT),
      RUST_LOG: "warn",
      TEST_MODE: "true",
    },
    stdio: "inherit",
    detached: false,
  });

  serverProc.on("error", (err) => {
    console.error("[setup] Server process error:", err);
  });

  if (serverProc.pid === undefined) {
    throw new Error("Failed to spawn server process");
  }

  const serverPid = serverProc.pid;
  console.log(`[setup] Server spawned with PID ${serverPid}`);

  // 4. Wait for server to be ready
  console.log("[setup] Waiting for server port 3001…");
  await waitForPort(SERVER_PORT, 30_000);
  console.log("[setup] Server is ready.");

  // 5. Build the extension
  console.log("[setup] Building extension…");
  execSync("npm run build", {
    cwd: path.join(REPO_ROOT, "extension"),
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_API_BASE: `http://localhost:${SERVER_PORT}`,
    },
  });
  const extensionDist = path.join(REPO_ROOT, "extension/dist");
  console.log(`[setup] Extension built at ${extensionDist}`);

  // 6. Build the Firefox extension dist (copy Chrome dist, swap manifest)
  const extensionFirefoxDist = path.join(REPO_ROOT, "extension/dist-firefox");
  console.log("[setup] Building Firefox extension dist…");
  if (fs.existsSync(extensionFirefoxDist)) {
    fs.rmSync(extensionFirefoxDist, { recursive: true, force: true });
  }
  fs.cpSync(extensionDist, extensionFirefoxDist, { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "extension/public/manifest.firefox.json"),
    path.join(extensionFirefoxDist, "manifest.json"),
  );
  console.log(`[setup] Firefox extension dist ready at ${extensionFirefoxDist}`);

  // 7. Write state file
  const state: TestState = {
    serverPort: SERVER_PORT,
    serverPid,
    extensionDist,
    extensionFirefoxDist,
    pgContainerId,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log("[setup] State written to", STATE_FILE);
}
