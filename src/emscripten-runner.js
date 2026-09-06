// @ts-check

// Bridges one compiled Emscripten module to the runner protocol: stdin is
// served from the keys buffer one line at a time, stdout/stderr are
// forwarded as STDOUT events. Extracted from the runner worker so the
// bridging contract is testable without a Worker or a real module.

/**
 * Runs one compiled module to completion and resolves when the module's
 * main has returned. The caller owns the worker mechanics: `send` posts a
 * protocol event (usually validated through runnerEvent), `readLine`
 * returns the next submitted line INCLUDING its trailing "\n" or null at
 * EOF (readInputLine from "./runner-protocol.js"), and `waitForLine`
 * blocks until the host has marked a line ready (the Atomics.wait in the
 * worker; a no-op stub in tests).
 *
 * Emscripten's TTY layer loops until its read() buffer is completely
 * full, so stdin hands out exactly one line per read and reports the end
 * of the line (null) afterwards -- blocking there would stall the game
 * waiting for input nobody typed.
 *
 * @param {{
 *   createModule: (options: object) => Promise<{ callMain: (args: unknown[]) => void }>,
 *   send: (message: Record<string, unknown>) => void,
 *   readLine: () => string | null,
 *   waitForLine: () => void,
 * }} runner
 * @returns {Promise<void>}
 */
export async function startEmscriptenRunner({
  createModule,
  send,
  readLine,
  waitForLine,
}) {
  let stdoutBuffer = "";

  // The current input line plus the read cursor into it. `line` is null
  // when the previous line has been fully consumed and a new one must be
  // requested from the launcher.
  /** @type {string | null} */
  let line = null;
  let linePosition = 0;
  let reachedEof = false;

  function flushStdout() {
    if (!stdoutBuffer) return;
    send({ type: "STDOUT", text: stdoutBuffer });
    stdoutBuffer = "";
  }

  function readStdinChar() {
    if (reachedEof) return null;

    if (line === null) {
      flushStdout();
      send({ type: "REQUEST_INPUT" });
      waitForLine();

      const submitted = readLine();
      if (submitted === null) {
        // Zero-length line: a genuine EOF (the game stops on IOSTAT < 0).
        reachedEof = true;
        return null;
      }
      line = submitted;
      linePosition = 0;
    }

    if (linePosition >= line.length) {
      // Line fully delivered: end this read. The next read starts a new
      // line, mirroring canonical (cooked) terminal behaviour.
      line = null;
      return null;
    }

    const charCode = line.charCodeAt(linePosition);
    linePosition++;
    return charCode;
  }

  const module = await createModule({
    noInitialRun: true,
    /**
     * @param {any} emscriptenModule
     */
    preRun: (emscriptenModule) => {
      emscriptenModule.FS.init(
        readStdinChar,
        /**
         * @param {number} charCode
         */
        (charCode) => {
          // Emscripten's stdout is line-buffered and every Fortran record
          // ends in a newline, so output arrives promptly without any
          // explicit flushing on our side.
          const character = String.fromCharCode(charCode);
          if (character === "\n") {
            send({ type: "STDOUT", text: `${stdoutBuffer}\n` });
            stdoutBuffer = "";
          } else if (character !== "\r") {
            stdoutBuffer += character;
          }
        },
        /**
         * @param {number} charCode
         */
        (charCode) => console.warn(String.fromCharCode(charCode)),
      );
    },
  });

  send({ type: "STARTED" });
  module.callMain([]);
  flushStdout();
  send({ type: "EXIT" });
}
