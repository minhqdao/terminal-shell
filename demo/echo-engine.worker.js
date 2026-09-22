// @ts-check
//
// The demo's "engine": not Emscripten at all, just a conversation loop
// speaking the same runner protocol the real runners use. It shows the
// smallest possible worker a host needs on the other side of the shell:
// INIT -> READY, START -> STARTED, then REQUEST_INPUT / readInputLine
// rounds, EOF or EXIT to stop.

import {
  readInputLine,
  runnerCommand,
  runnerEvent,
} from "../src/runner-protocol.js";

/** @param {Record<string, unknown>} message */
function send(message) {
  self.postMessage(runnerEvent(message));
}

self.onmessage = (event) => {
  const data = runnerCommand(event.data);
  if (data.type === "INIT") {
    // A real runner would import(data.wasmUrl) here; the echo engine has
    // nothing to load.
    send({ type: "READY" });
    return;
  }
  if (data.type !== "START") return;

  const sharedBuffer = new Int32Array(data.buffer);
  const sharedKeys = new Uint8Array(data.keys);

  send({ type: "STARTED" });
  send({
    type: "STDOUT",
    text:
      "TERMINAL-SHELL ECHO ENGINE\n" +
      "TYPE A LINE; IT COMES BACK UPPERCASE.\n" +
      "'EXIT' QUITS.\n",
  });

  const converse = async () => {
    for (;;) {
      send({ type: "REQUEST_INPUT" });
      Atomics.wait(sharedBuffer, 0, 0);
      Atomics.store(sharedBuffer, 0, 0);

      const line = readInputLine(sharedKeys);
      if (line === null) break; // EOF
      const text = line.replace(/\n$/, "");
      if (/^EXIT$/.test(text)) break;
      send({ type: "STDOUT", text: `YOU SAID: ${text}\n` });
    }

    send({ type: "STDOUT", text: "\n*** SYSTEM OFFLINE ***\n" });
    send({ type: "EXIT" });
    self.close();
  };
  converse();
};
