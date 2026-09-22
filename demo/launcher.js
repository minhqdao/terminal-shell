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

/**
 * @param {string} id
 * @returns {HTMLElement} the element; throws when the markup is missing it
 */
function element(id) {
  const found = document.getElementById(id);
  if (!found) throw new Error(`demo is missing #${id}`);
  return found;
}

const output = element("output");
const input = element("input");
const cursor = element("cursor");
const screen = element("screen");
const terminalContainer = element("terminal-container");
const terminalInput = /** @type {HTMLInputElement} */ (
  element("terminal-input")
);
const status = element("status");

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

const isolationReloadKey = "terminal-shell-demo-isolation-reload";
const workerRetryKey = "terminal-shell-demo-worker-retry";
const isolationWaitMs = 5000;

/**
 * The SharedArrayBuffer below only exists in an isolated page. A reload
 * can commit while the service worker is (re)starting; that document is
 * uncontrolled, gets no headers, and -- the worker already being active
 * -- may never receive another event, so waiting unboundedly can hang
 * forever. Wait a grace period for the normal claim-and-reload instead;
 * if it hasn't happened, one guarded reload reruns the navigation
 * through the worker. The guard is spent after that, so a truly
 * unisolatable page gets the message below instead of reloading forever.
 * @returns {boolean} whether the engine may boot now
 */
function ensureCrossOriginIsolation() {
  if (window.crossOriginIsolated) {
    sessionStorage.removeItem(isolationReloadKey);
    return true;
  }
  if (!navigator.serviceWorker) {
    setStatus(
      "This demo needs cross-origin isolation (serve it with COOP/COEP headers).",
    );
    return false;
  }
  // First visits are claimed and reloaded by the registration above, long
  // before this fires; only a lost race survives until it does.
  setStatus("Waiting for cross-origin isolation…");
  window.setTimeout(() => {
    if (window.crossOriginIsolated) return;
    if (sessionStorage.getItem(isolationReloadKey)) {
      setStatus(
        "This page could not become isolated. Try reloading once more.",
      );
      return;
    }
    // Announce the recovery first: an unexplained reload reads as a bug.
    setStatus("Still not isolated — reloading once…");
    sessionStorage.setItem(isolationReloadKey, "1");
    window.location.reload();
  }, isolationWaitMs);
  return false;
}

/** @param {string} value */
function handleLine(value) {
  if (!worker || !sharedBuffer || !sharedKeys) return;
  writeInputLine(sharedKeys, value);
  Atomics.store(sharedBuffer, 0, 1);
  Atomics.notify(sharedBuffer, 0, 1);
}

function boot() {
  if (!ensureCrossOriginIsolation()) return;
  setStatus("");
  worker = new Worker(new URL("./echo-engine.worker.js", import.meta.url), {
    type: "module",
  });
  sharedBuffer = new Int32Array(new SharedArrayBuffer(4));
  sharedKeys = new Uint8Array(createKeysBuffer());

  // A module worker that fails to load (bad import, 404, or a fetch
  // that lost a service-worker restart race) only fires this, never
  // onmessage: without it the terminal just stays blank. Load failures
  // carry neither message nor file, so a detail-less error is retried
  // once -- by then the worker is up and the fetch succeeds. Anything
  // with details is a real runtime error and is shown as-is.
  worker.onerror = (event) => {
    if (!event.message && !sessionStorage.getItem(workerRetryKey)) {
      sessionStorage.setItem(workerRetryKey, "1");
      boot();
      return;
    }
    setStatus(
      event.message ||
        `The engine worker failed to load (${event.filename || "unknown file"}).`,
    );
  };

  worker.onmessage = (event) => {
    if (!worker || !sharedBuffer || !sharedKeys) return;
    // Any message proves the worker is alive: no retry outstanding.
    sessionStorage.removeItem(workerRetryKey);
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
