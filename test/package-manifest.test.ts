import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

test("development dependencies exercise the Pi 1.0.2 host modules", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const name of [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ]) {
    assert.equal(manifest.devDependencies[name], "1.0.2", name);
  }
  assert.equal(manifest.devDependencies.typebox, "1.3.27");
  for (const section of [manifest.peerDependencies, manifest.devDependencies]) {
    assert.ok(!Object.keys(section).some((name) => name.startsWith("@mariozechner/")));
  }
});

test("source imports use the current Pi namespace", () => {
  const sourceRoot = new URL("../src/", import.meta.url);
  for (const file of readdirSync(sourceRoot, { recursive: true })) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(new URL(file, sourceRoot), "utf8");
    assert.equal(/@mariozechner\/pi-/.test(source), false, file);
  }
});
