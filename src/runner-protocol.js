// @ts-check

/**
 * START boots either a compiled module (wasm glue only, as in the
 * colossal-cave/oregon runners) or an interpreted program: the interpreter
 * variant additionally carries the fetched BASIC `source` and the
 * `filename` to write it to in the worker's virtual FS (Basicade). Both
 * shapes share the input-line layout below.
 * @typedef {{type: "INIT", wasmUrl: string}
 *   | {type: "START", buffer: SharedArrayBuffer, keys: SharedArrayBuffer}
 *   | {type: "START", source: string, filename: string, buffer: SharedArrayBuffer, keys: SharedArrayBuffer}} RunnerCommand */

/** @typedef {{type: "READY"} | {type: "STARTED"} | {type: "STDOUT", text: string} | {type: "REQUEST_INPUT"} | {type: "ERROR", message: string} | {type: "EXIT"}} RunnerEvent */

/** @param {unknown} value */
function messageRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Runner protocol message must be an object");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

// --- input line layout -------------------------------------------------------
//
// The keys SharedArrayBuffer carries one submitted line at a time:
// [0] character length, [1] padding, [2..] the characters including the
// trailing newline. The launcher, the runner worker and the Node test
// driver all share this layout, so the buffer size and the accessors live
// here; a maximum-length line must fit without Atomics silently dropping
// out-of-range writes.

export const maxInputLength = 254;
const keysLengthSlot = 0;
const keysTextOffset = 2;

export function createKeysBuffer() {
  return new SharedArrayBuffer(keysTextOffset + maxInputLength + 1);
}

/**
 * Writes one submitted line (including its trailing "\n") and its length.
 * The wire contract is printable ASCII plus the newline: the buffer stores
 * single bytes, and any other code point would wrap into a wrong byte
 * silently, so a violating line is rejected WHOLE (nothing is written)
 * instead of corrupted. toEngineText produces exactly this shape.
 * @param {Uint8Array} view @param {string} line
 */
export function writeInputLine(view, line) {
  if (line.length > 255 || keysTextOffset + line.length > view.length) {
    throw new RangeError(
      `input line of ${line.length} characters exceeds the keys buffer`,
    );
  }
  for (let index = 0; index < line.length; index++) {
    const charCode = line.charCodeAt(index);
    if (charCode !== 10 && (charCode < 32 || charCode > 126)) {
      throw new RangeError(
        `input line must be printable ASCII (U+${charCode
          .toString(16)
          .padStart(4, "0")} at offset ${index})`,
      );
    }
  }
  for (let index = 0; index < line.length; index++) {
    Atomics.store(view, keysTextOffset + index, line.charCodeAt(index));
  }
  Atomics.store(view, keysLengthSlot, line.length);
}

/** @param {Uint8Array} view @returns {string | null} null on EOF */
export function readInputLine(view) {
  const length = Atomics.load(view, keysLengthSlot);
  if (length === 0) return null;
  let text = "";
  for (let index = 0; index < length; index++) {
    text += String.fromCharCode(Atomics.load(view, keysTextOffset + index));
  }
  return text;
}

/**
 * @param {Record<string, unknown>} message
 * @param {string} field
 */
function requiredString(message, field) {
  const value = message[field];
  if (typeof value !== "string" || !value) {
    throw new TypeError(`Runner protocol field ${field} must be a string`);
  }
  return value;
}

/**
 * Validates a command before it crosses the launcher-worker boundary.
 * @param {unknown} value
 */
export function runnerCommand(value) {
  const message = messageRecord(value);
  const type = requiredString(message, "type");
  if (type === "INIT") {
    return /** @type {RunnerCommand} */ ({
      type,
      wasmUrl: requiredString(message, "wasmUrl"),
    });
  }
  if (type === "START") {
    if (!(message.buffer instanceof SharedArrayBuffer)) {
      throw new TypeError("Runner protocol field buffer must be shared memory");
    }
    if (!(message.keys instanceof SharedArrayBuffer)) {
      throw new TypeError("Runner protocol field keys must be shared memory");
    }
    // The buffers must fit the layout: the ready slot, and a
    // maximum-length line plus its newline. A too-small buffer would
    // otherwise surface only as an out-of-range write mid-game.
    if (message.buffer.byteLength < 4) {
      throw new RangeError(
        "Runner protocol buffer must hold the ready slot (4 bytes)",
      );
    }
    if (message.keys.byteLength < keysTextOffset + maxInputLength + 1) {
      throw new RangeError(
        `Runner protocol keys buffer must fit a maximum-length line (${
          keysTextOffset + maxInputLength + 1
        } bytes)`,
      );
    }
    if (message.source === undefined && message.filename === undefined) {
      return /** @type {RunnerCommand} */ ({
        type,
        buffer: message.buffer,
        keys: message.keys,
      });
    }
    return /** @type {RunnerCommand} */ ({
      type,
      source: requiredString(message, "source"),
      filename: requiredString(message, "filename"),
      buffer: message.buffer,
      keys: message.keys,
    });
  }
  throw new TypeError(`Unknown runner command: ${type}`);
}

/**
 * Validates an event before it crosses the launcher-worker boundary.
 * @param {unknown} value
 */
export function runnerEvent(value) {
  const message = messageRecord(value);
  const type = requiredString(message, "type");
  if (
    type === "READY" ||
    type === "STARTED" ||
    type === "REQUEST_INPUT" ||
    type === "EXIT"
  ) {
    return /** @type {RunnerEvent} */ ({ type });
  }
  if (type === "STDOUT") {
    return /** @type {RunnerEvent} */ ({
      type,
      text: requiredString(message, "text"),
    });
  }
  if (type === "ERROR") {
    return /** @type {RunnerEvent} */ ({
      type,
      message: requiredString(message, "message"),
    });
  }
  throw new TypeError(`Unknown runner event: ${type}`);
}
