// The supervisor's child processes, with idle Node processes standing in for the stack's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { processes } from "./supervisor.ts";

/** A process that runs until signalled and takes a moment to exit, as the server drains. */
const idle = (): [string, string[], NodeJS.ProcessEnv] => [
  process.execPath,
  ["-e", "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 200)); setInterval(() => {}, 1000);"],
  {},
];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a restart under way when the stack stops leaves no process behind", async () => {
  const pids: number[] = [];
  const stack = processes(
    () => "",
    { started: (_, pid) => pids.push(pid), gaveUp: () => {}, recovered: () => {} },
    { command: { fake: idle, server: idle, vite: idle }, log: () => {} },
  );
  stack.startAll();
  // A rebuild restarts the server (rebuildAndRestart), and `./dev-ctl stop` comes in while the
  // old one is still draining.
  const restarted = stack.restart("server");
  assert.ok(stack.beginStopping());
  await stack.stopAll();
  await restarted;
  const left = pids.filter(alive);
  for (const pid of left) process.kill(pid, "SIGKILL");
  assert.deepEqual(left, [], "processes still running after the stack stopped");
});
