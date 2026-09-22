// Unit tests for the Emscripten bridging (src/emscripten-runner.js): the
// stdin contract is the heart of the runner -- exactly one line per read,
// a REQUEST_INPUT event before every block, a null read at EOF -- and
// stdout must forward complete lines as STDOUT events. A fake module
// factory captures the FS.init callbacks so the whole flow runs in plain
// Node without a Worker or WASM.

import assert from "node:assert/strict";
import test from "node:test";

import { startEmscriptenRunner } from "../src/emscripten-runner.js";

/**
 * Drives one bridging run against a fake module. The fake's `main` is a
 * script of steps: { read: true } pulls the next stdin char through
 * FS.init's stdin callback, { print } pushes characters through the stdout
 * callback.
 * @param {{ line: string | null } | { line: string | null }[]} lines the
 *   queued host answers, null = EOF
 * @param {Array<{ read?: true, print?: string }>} script the fake main's steps
 * @returns {Promise<Record<string, unknown>[]>} the emitted protocol events
 */
async function run(lines, script) {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const send = (message) => events.push(message);

  /** @type {(() => number | null) | undefined} */
  let stdin;
  /** @type {((charCode: number) => void) | undefined} */
  let stdout;
  const queue = (Array.isArray(lines) ? lines : [lines]).slice();

  const createModule = async (options) => {
    const preRun = /** @type {{ preRun?: (mod: any) => void }} */ (options)
      .preRun;
    preRun?.({
      FS: {
        /**
         * @param {() => number | null} stdinCb
         * @param {(charCode: number) => void} stdoutCb
         */
        init(stdinCb, stdoutCb) {
          stdin = stdinCb;
          stdout = stdoutCb;
        },
      },
    });
    return {
      callMain() {
        for (const step of script) {
          if (step.read) stdin?.();
          if (step.print !== undefined) {
            for (const character of step.print) {
              stdout?.(character.charCodeAt(0));
            }
          }
        }
      },
    };
  };

  await startEmscriptenRunner({
    createModule,
    send,
    readLine: () => queue.shift() ?? null,
    waitForLine: () => {}, // test stub: a line is always ready
  });
  return events;
}

test("stdin serves one line per read, then blocks on REQUEST_INPUT", async () => {
  const events = await run(
    ["LOOK\n"],
    [
      { read: true }, // 'L'
      { read: true }, // 'O'
      { read: true }, // 'O'
      { read: true }, // 'K'
      { read: true }, // '\n'
      { read: true }, // line done: null ends this read
    ],
  );

  assert.deepEqual(events[0], { type: "STARTED" });
  const requests = events.filter((e) => e.type === "REQUEST_INPUT");
  assert.equal(requests.length, 1, "one line, one input request");
  assert.deepEqual(events.at(-1), { type: "EXIT" });
});

test("stdout forwards complete lines and buffers partials", async () => {
  const events = await run(
    [null],
    [
      { print: "HELLO" }, // partial: buffered, not sent
      { print: "\r\n" }, // \r dropped, \n flushes "HELLO\n"
      { print: "BYE" }, // still buffered...
    ],
  );

  const stdouts = events.filter((e) => e.type === "STDOUT");
  assert.deepEqual(stdouts, [
    { type: "STDOUT", text: "HELLO\n" },
    { type: "STDOUT", text: "BYE" }, // flushed before EXIT
  ]);
  assert.deepEqual(events.at(-1), { type: "EXIT" });
});

test("a null line is EOF: stdin reports null and never asks again", async () => {
  const events = await run(
    [null],
    [{ read: true }, { read: true }, { read: true }],
  );

  const requests = events.filter((e) => e.type === "REQUEST_INPUT");
  assert.equal(requests.length, 1, "EOF stops the input requests");
  assert.deepEqual(events.at(-1), { type: "EXIT" });
});

test("bare carriage returns are dropped mid-line", async () => {
  const events = await run([null], [{ print: "A\rB\n" }]);
  assert.deepEqual(
    events.filter((e) => e.type === "STDOUT"),
    [{ type: "STDOUT", text: "AB\n" }],
  );
});

test("a rejected module factory propagates to the caller", async () => {
  // The worker wraps this call and reports it as an ERROR event.
  await assert.rejects(
    startEmscriptenRunner({
      createModule: () => Promise.reject(new Error("wasm 404")),
      send() {},
      readLine: () => null,
      waitForLine() {},
    }),
    /wasm 404/,
  );
});

test("a throwing main propagates after STARTED", async () => {
  const events = [];
  await assert.rejects(
    startEmscriptenRunner({
      createModule: async (options) => {
        const preRun = /** @type {{ preRun?: (mod: any) => void }} */ (options)
          .preRun;
        preRun?.({ FS: { init() {} } });
        return {
          callMain() {
            throw new Error("SIGSEGV");
          },
        };
      },
      send: (message) => events.push(message),
      readLine: () => null,
      waitForLine() {},
    }),
    /SIGSEGV/,
  );
  assert.equal(events.at(-1)?.type, "STARTED", "STARTED went out before main");
});

test("pending stdout flushes before the input request", async () => {
  const events = await run(
    ["N\n"],
    [
      { print: "PROMPT:" }, // buffered
      { read: true }, // must flush "PROMPT:" BEFORE requesting input
    ],
  );

  const stdoutIndex = events.findIndex((e) => e.type === "STDOUT");
  const requestIndex = events.findIndex((e) => e.type === "REQUEST_INPUT");
  assert.ok(stdoutIndex !== -1 && requestIndex !== -1);
  assert.ok(stdoutIndex < requestIndex, "flush precedes REQUEST_INPUT");
  assert.deepEqual(events[stdoutIndex], { type: "STDOUT", text: "PROMPT:" });
});
