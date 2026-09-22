// Unit tests for the runner protocol (src/runner-protocol.js): the
// SharedArrayBuffer that carries one submitted line at a time must be
// large enough for a maximum-length line plus its newline, the validators
// must reject malformed messages at the launcher-worker boundary, and both
// START shapes -- compiled (buffer + keys) and interpreted (source +
// filename + buffer + keys) -- must validate.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createKeysBuffer,
  maxInputLength,
  readInputLine,
  runnerCommand,
  runnerEvent,
  writeInputLine,
} from "../src/runner-protocol.js";

test("input buffer round trip, EOF, and overflow", () => {
  const view = new Uint8Array(createKeysBuffer());

  // A zero-length write is the wire signal for EOF, read back as null.
  writeInputLine(view, "");
  assert.equal(readInputLine(view), null);

  const roundTrip = (text) => {
    writeInputLine(view, text);
    assert.equal(readInputLine(view), text);
  };
  roundTrip("\n");
  roundTrip("LOOK\n");
  roundTrip("X".repeat(maxInputLength) + "\n");

  const tooLong = "X".repeat(maxInputLength + 1) + "\n";
  assert.throws(() => writeInputLine(view, tooLong), RangeError);
});

test("writeInputLine enforces the printable-ASCII contract", () => {
  const view = new Uint8Array(createKeysBuffer());

  // A composed accent, a tab, a CR, and an emoji each wrap into a wrong
  // byte silently if they ever reached the buffer -- they are rejected
  // whole instead (the previous line's length slot stays untouched).
  writeInputLine(view, "PREVIOUS\n");
  for (const bad of [
    "CAF\u00c9\n",
    "A\tB\n",
    "A\r\n",
    "X\u{1F389}\n",
    "DEL\u007f\n", // U+007F is not printable ASCII either
  ]) {
    assert.throws(() => writeInputLine(view, bad), /printable ASCII/);
    assert.equal(
      readInputLine(view),
      "PREVIOUS\n",
      "a rejected write leaves the buffer untouched",
    );
  }

  // The contract itself: printable ASCII plus the newline.
  writeInputLine(view, "GOT KEYS? @#!%\n");
  assert.equal(readInputLine(view), "GOT KEYS? @#!%\n");
});

test("runnerCommand accepts INIT and both START shapes", () => {
  const init = runnerCommand({ type: "INIT", wasmUrl: "./game.js" });
  assert.deepEqual(init, { type: "INIT", wasmUrl: "./game.js" });

  const buffer = new SharedArrayBuffer(4);
  const keys = createKeysBuffer();
  const compiled = runnerCommand({ type: "START", buffer, keys });
  assert.deepEqual(compiled, { type: "START", buffer, keys });

  // The buffers must fit the layout: the ready slot, and a
  // maximum-length line plus its newline.
  assert.throws(
    () =>
      runnerCommand({ type: "START", buffer: new SharedArrayBuffer(2), keys }),
    /ready slot/,
  );
  assert.throws(
    () =>
      runnerCommand({
        type: "START",
        buffer,
        keys: new SharedArrayBuffer(8),
      }),
    /maximum-length line/,
  );

  const interpreted = runnerCommand({
    type: "START",
    source: '10 PRINT "HI"\n',
    filename: "game.bas",
    buffer,
    keys,
  });
  assert.deepEqual(interpreted, {
    type: "START",
    source: '10 PRINT "HI"\n',
    filename: "game.bas",
    buffer,
    keys,
  });
});

test("runnerCommand rejects malformed commands", () => {
  const buffer = new SharedArrayBuffer(4);
  const keys = createKeysBuffer();

  assert.throws(() => runnerCommand(null), TypeError);
  assert.throws(() => runnerCommand({ type: "NOPE" }), TypeError);
  assert.throws(() => runnerCommand({ type: "INIT" }), TypeError);
  assert.throws(() => runnerCommand({ type: "START", buffer }), TypeError);
  assert.throws(() => runnerCommand({ type: "START", keys }), TypeError);
  // One of source/filename without the other is a malformed interpreted
  // START: both are required together.
  assert.throws(
    () => runnerCommand({ type: "START", source: "10 RUN\n", buffer, keys }),
    TypeError,
  );
});

test("runnerEvent accepts every event and rejects unknown types", () => {
  for (const type of ["READY", "STARTED", "REQUEST_INPUT", "EXIT"]) {
    assert.deepEqual(runnerEvent({ type }), { type });
  }
  assert.deepEqual(runnerEvent({ type: "STDOUT", text: "HI\n" }), {
    type: "STDOUT",
    text: "HI\n",
  });
  assert.deepEqual(runnerEvent({ type: "ERROR", message: "boom" }), {
    type: "ERROR",
    message: "boom",
  });
  assert.throws(() => runnerEvent({ type: "STDOUT" }), TypeError);
  assert.throws(() => runnerEvent({ type: "WHAT" }), TypeError);
});
