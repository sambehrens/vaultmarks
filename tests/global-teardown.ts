import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const STATE_FILE = path.join(__dirname, ".test-state.json");

interface TestState {
  serverPort: number;
  serverPid: number;
  extensionDist: string;
  extensionFirefoxDist: string;
  pgContainerId: string;
}

export default async function globalTeardown(): Promise<void> {
  let state: TestState | undefined;

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    state = JSON.parse(raw) as TestState;
  } catch (err) {
    console.warn("[teardown] Could not read state file:", err);
    return;
  }

  // Kill the server process
  try {
    console.log(`[teardown] Killing server PID ${state.serverPid}…`);
    process.kill(state.serverPid, "SIGTERM");
    console.log("[teardown] Server killed.");
  } catch (err) {
    console.warn("[teardown] Failed to kill server:", err);
  }

  // Stop and remove the PostgreSQL container
  try {
    console.log(`[teardown] Stopping PG container ${state.pgContainerId}…`);
    execSync(`docker stop ${state.pgContainerId} && docker rm ${state.pgContainerId}`, {
      stdio: "inherit",
    });
    console.log("[teardown] PG container removed.");
  } catch (err) {
    console.warn("[teardown] Failed to stop PG container:", err);
  }

  // Delete the state file
  try {
    fs.unlinkSync(STATE_FILE);
    console.log("[teardown] State file deleted.");
  } catch (err) {
    console.warn("[teardown] Failed to delete state file:", err);
  }
}
