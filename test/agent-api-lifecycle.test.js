// Test fixtures use temporary SQLite and a stub adapter; they are NOT real model execution evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { apply } from "../src/host/index.js";

function fakeContext() {
  const effects = []; const routes = []; const tools = [];
  return {
    effects, routes, tools,
    effect(fn, label) { effects.push({ fn, label }); return () => { }; },
    connection: { fetch: { register(route) { routes.push(route); } } },
    tools: { register(tool) { tools.push(tool); } },
    logger: { info() { }, warn() { } },
    subprocess: { spawn() { throw new Error("subprocess must not be used in this fixture"); } },
  };
}

test("releases listener, scheduler lease and discovery files when agent API startup fails", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acms-host-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  // Make the atomic discovery publication fail after the listener is already bound.
  await mkdir(path.join(dataDir, "agent-api.json"), { recursive: true });
  const ctx = fakeContext();
  const listenersBefore = process.getActiveResourcesInfo().filter(item => item === "TCPServerWrap").length;
  let failure = null;
  try { await apply(ctx, { dataDir }); } catch (error) { failure = error; }
  assert.ok(failure, "plugin startup must reject when discovery publication fails");
  assert.equal(ctx.effects.length, 1, "the lifecycle cleanup hook must be registered before startup");
  const listenersAfter = process.getActiveResourcesInfo().filter(item => item === "TCPServerWrap").length;
  assert.equal(listenersAfter, listenersBefore, "no TCP listener may remain after a failed startup");
  assert.deepEqual((await readdir(dataDir)).filter(name => name.endsWith(".tmp")), []);
  const store = new Store(path.join(dataDir, "company.db"));
  try {
    assert.deepEqual(store.db.prepare("SELECT resource FROM leases").all(), [], "the scheduler lease must be released");
  } finally { store.close(); }
  await ctx.effects[0].fn();
  await ctx.effects[0].fn();
});
