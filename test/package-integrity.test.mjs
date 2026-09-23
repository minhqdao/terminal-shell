// Package integrity tests: the published shape is a contract, not a
// side effect. Every exports entry must resolve to a shipped file, every
// src module must be reachable through exports (a forgotten entry ships a
// hole, as ./terminal-shell once was), and the index must re-export the
// API the launchers consume.
//
//   node --test test/package-integrity.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as terminalShell from "../src/index.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("every exports entry resolves to an existing file", () => {
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const specifier =
      subpath === "." ? pkg.name : `${pkg.name}${subpath.slice(1)}`;
    const resolved = import.meta.resolve(specifier);
    assert.ok(resolved, `${specifier} resolves`);
    assert.ok(
      existsSync(fileURLToPath(resolved)),
      `${specifier} -> ${target} exists`,
    );
  }
});

test("every src module is reachable through exports", () => {
  const reachable = new Set(
    Object.values(pkg.exports).map((target) =>
      String(target).replace(/^\.\//, ""),
    ),
  );
  const sources = readdirSync(new URL("../src/", import.meta.url)).filter(
    (file) => file.endsWith(".js"),
  );
  assert.ok(sources.length > 0);
  for (const file of sources) {
    assert.ok(reachable.has(`src/${file}`), `${file} is exported`);
  }
});

test("the files whitelist covers every export target", () => {
  const covered = (target) => {
    const path = String(target).replace(/^\.\//, "");
    return pkg.files.some(
      (entry) => path === entry || path.startsWith(`${entry}/`),
    );
  };
  for (const target of Object.values(pkg.exports)) {
    assert.ok(covered(String(target)), `${target} ships in the tarball`);
  }
});

test("the index re-exports the documented public API", () => {
  for (const name of [
    "createTerminalShell",
    "createKeysBuffer",
    "runnerCommand",
    "runnerEvent",
    "sanitizeTerminalOutput",
    "writeInputLine",
    "readInputLine",
  ]) {
    assert.equal(typeof terminalShell[name], "function", `${name} is exported`);
  }
  assert.equal(typeof terminalShell.maxInputLength, "number");
});
