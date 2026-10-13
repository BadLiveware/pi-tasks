import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { test } from "vitest";

test("host-provided modules are wildcard peers, not runtime dependencies", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const hostPackages = new Set([
    ...["@earendil-works", "@mariozechner"].flatMap((scope) =>
      ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"].map(
        (name) => `${scope}/${name}`,
      ),
    ),
    "typebox",
    "@sinclair/typebox",
  ]);

  for (const name of Object.keys(manifest.dependencies ?? {})) {
    assert.equal(hostPackages.has(name), false, `${name} must be host-provided`);
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (hostPackages.has(name)) assert.equal(range, "*", name);
  }
  for (const name of [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    assert.equal(manifest.peerDependencies?.[name], "*", name);
    assert.ok(manifest.devDependencies?.[name], `${name} is needed for local tests`);
  }
});

test("host modules load and validate tool parameters together", () => {
  assert.ok(getAgentDir().length > 0);
  const schema = Type.Object({ subject: Type.String() });
  assert.equal(Value.Check(schema, { subject: "Task" }), true);
  assert.equal(Value.Check(schema, { subject: 5 }), false);
  const clipped = truncateToWidth("Long task subject", 10).replace(/\u001b\[[0-9;]*m/g, "");
  assert.ok(clipped.length <= 10);
  assert.ok(clipped.endsWith("..."));
});

test("source imports use the current Pi namespace", () => {
  const sourceRoot = new URL("../src/", import.meta.url);
  for (const file of readdirSync(sourceRoot, { recursive: true })) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(new URL(file, sourceRoot), "utf8");
    assert.equal(/@mariozechner\/pi-/.test(source), false, file);
  }
});
