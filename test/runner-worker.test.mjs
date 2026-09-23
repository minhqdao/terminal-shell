// Entry test for the generic engine worker (src/runner-worker.js): the
// module's whole job is wiring onmessage as a side effect of loading
// (which is why package.json flags it in sideEffects), so this test loads
// it behind a stubbed worker scope and checks the wiring -- plus that a
// bad engine URL comes back as an ERROR event, not a crash. The import
// must be dynamic: a static import would evaluate the module before the
// stub exists.
//
//   node --test test/runner-worker.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

const posted = [];
globalThis.self = {
  postMessage: (message) => posted.push(message),
  close() {},
};

await import("../src/runner-worker.js");

test("importing the worker wires onmessage", () => {
  assert.equal(typeof globalThis.self.onmessage, "function");
});

test("a bad engine URL reports an ERROR event", async () => {
  posted.length = 0;
  await globalThis.self.onmessage({
    data: { type: "INIT", wasmUrl: "./definitely-missing.js" },
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "ERROR");
  assert.ok(posted[0].message.length > 0);
});
