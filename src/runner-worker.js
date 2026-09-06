// @ts-check
//
// The generic worker for a compiled WASM game: INIT fetches the Emscripten
// glue at the URL the host supplied, START bridges the module to the
// shared-buffer protocol (see emscripten-runner.js for the stdin/stdout
// contract). Interpreted programs -- START with source/filename -- need an
// interpreter worker instead (Basicade's), which still shares the
// "./runner-protocol.js" module.

import {
  readInputLine,
  runnerCommand,
  runnerEvent,
} from "./runner-protocol.js";
import { startEmscriptenRunner } from "./emscripten-runner.js";

/** @type {{ (options: object): Promise<{ callMain: (args: unknown[]) => void }> } | undefined} */
let createModule;

/** @param {Record<string, unknown>} message */
function send(message) {
  self.postMessage(runnerEvent(message));
}

self.onmessage = async (event) => {
  try {
    const data = runnerCommand(event.data);
    if (data.type === "INIT") {
      const mod = await import(/* @vite-ignore */ data.wasmUrl);
      createModule = mod.default;
      send({ type: "READY" });
      return;
    }

    if (data.type !== "START" || !createModule) return;

    const sharedBuffer = new Int32Array(data.buffer);
    const sharedKeys = new Uint8Array(data.keys);

    await startEmscriptenRunner({
      createModule,
      send,
      readLine: () => readInputLine(sharedKeys),
      waitForLine: () => {
        Atomics.wait(sharedBuffer, 0, 0);
        Atomics.store(sharedBuffer, 0, 0);
      },
    });
    self.close();
  } catch (error) {
    send({
      type: "ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
    self.close();
  }
};
