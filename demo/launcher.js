// @ts-check
//
// The demo host: the smallest complete terminal-shell integration. Compare
// colossal-cave-wasm's web/launcher.js for the production shape (startup
// retries, isolation recovery, boot watchdogs) -- this one stays minimal on
// purpose. Serve the repository root with any static file server (the
// demo imports from ../src/, so serving just demo/ 404s); the
// coi-serviceworker registration below adds the cross-origin isolation the
// SharedArrayBuffer needs (that is how the GitHub Pages hosts do it).

import {
  createKeysBuffer,
  createTerminalShell,
  runnerCommand,
  runnerEvent,
  writeInputLine,
} from "../src/index.js";

const output = document.getElementById("output");
const input = document.getElementById("input");
const cursor = document.getElementById("cursor");
const screen = document.getElementById("screen");
const terminalContainer = document.getElementById("terminal-container");
const terminalInput = document.getElementById("terminal-input");
const status = document.getElementById("status");

/** @param {string} message */
function setStatus(message) {
  status.textContent = message;
  status.hidden = !message;
}

const shell = createTerminalShell({
  screen,
  output,
  inputLine: input,
  cursor,
  field: terminalInput,
  container: terminalContainer,
  onLine: handleLine,
});

// Cross-origin isolation for the SharedArrayBuffer: register coi and
// reload once when it takes control (a no-op on servers that already send
// the COOP/COEP headers).
if (!window.crossOriginIsolated && navigator.serviceWorker) {
  navigator.serviceWorker.register("./coi-serviceworker.js");
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!window.crossOriginIsolated) window.location.reload();
  });
}

/** @type {Worker | undefined} */
let worker;
/** @type {Int32Array | undefined} */
let sharedBuffer;
/** @type {Uint8Array | undefined} */
let sharedKeys;

function handleLine(value) {
  if (!worker || !sharedBuffer || !sharedKeys) return;
  writeInputLine(sharedKeys, value);
  Atomics.store(sharedBuffer, 0, 1);
  Atomics.notify(sharedBuffer, 0, 1);
}

function boot() {
  worker = new Worker(new URL("./echo-engine.worker.js", import.meta.url), {
    type: "module",
  });
  sharedBuffer = new Int32Array(new SharedArrayBuffer(4));
  sharedKeys = new Uint8Array(createKeysBuffer());

  // A module worker that fails to load (bad import, 404) only fires this,
  // never onmessage: without it the terminal just stays blank.
  worker.onerror = (event) => {
    setStatus(event.message || "The engine worker failed to load.");
  };

  worker.onmessage = (event) => {
    const data = runnerEvent(event.data);
    if (data.type === "READY") {
      worker.postMessage(
        runnerCommand({
          type: "START",
          buffer: sharedBuffer.buffer,
          keys: sharedKeys.buffer,
        }),
      );
    } else if (data.type === "STDOUT") {
      shell.appendOutput(data.text);
    } else if (data.type === "REQUEST_INPUT") {
      shell.beginInput();
    } else if (data.type === "EXIT") {
      // The engine sent its offline banner as STDOUT ahead of this event.
      shell.endInput();
      shell.flushOutputRender();
      setStatus("The engine exited. Restart the page to play again.");
    } else if (data.type === "ERROR") {
      setStatus(data.message);
      shell.endInput();
    }
  };

  worker.postMessage(
    runnerCommand({ type: "INIT", wasmUrl: "./echo-engine.js" }),
  );
}

boot();
