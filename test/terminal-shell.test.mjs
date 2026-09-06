// DOM tests for the shell controller (src/terminal-shell.js), run in jsdom:
// the faithful-forwarding contract of the command line. The hidden field
// keeps whatever the IME produced and the live echo mirrors it, while the
// engine's text policy applies exactly once, at submit (composed accents
// must yield their base letter, never vanish) -- and the caret is
// re-pinned by plain typing but NEVER under an active composition.
//
//   node --test test/terminal-shell.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createTerminalShell } from "../src/terminal-shell.js";

/**
 * One jsdom document per test, wired the way a host page wires it. The
 * field starts unfocused (the shell focuses it in beginInput).
 */
function openShell(overrides = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <main><div id="screen"><div id="output"></div>
         <div id="input"></div><span id="cursor"></span></div>
         <div id="terminal-container">
           <input id="terminal-input" type="text" />
         </div>
       </main></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true },
  );
  const { window } = dom;
  // The shell reads the browser globals directly (it runs in the page), so
  // publish this document's globals into the Node realm before wiring it.
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globalThis.localStorage = window.localStorage;
  // jsdom has no matchMedia; coarse matches so a touch-shell test could
  // opt in, mirroring the launchers' own harness.
  window.matchMedia = (query) => ({
    matches: query.includes("coarse"),
    addEventListener() {},
    removeEventListener() {},
  });
  const document_ = window.document;
  const input = /** @type {HTMLInputElement} */ (
    document_.getElementById("terminal-input")
  );

  /** @type {string[]} */
  const lines = [];
  let firstOutputs = 0;

  const options = {
    screen: /** @type {HTMLElement} */ (document_.getElementById("screen")),
    output: /** @type {HTMLElement} */ (document_.getElementById("output")),
    inputLine: /** @type {HTMLElement} */ (document_.getElementById("input")),
    cursor: /** @type {HTMLElement} */ (document_.getElementById("cursor")),
    field: input,
    container: /** @type {HTMLElement} */ (
      document_.getElementById("terminal-container")
    ),
    onLine: (line) => lines.push(line),
    onFirstOutput: () => {
      firstOutputs += 1;
    },
    ...overrides,
  };
  const shell = createTerminalShell(options);

  const fireInput = () =>
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  const fireEnter = (overrides = {}) =>
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...overrides,
      }),
    );
  const fireComposition = (type) =>
    input.dispatchEvent(new window.Event(type, { bubbles: true }));
  const echoText = () => document_.getElementById("input")?.textContent ?? "";

  return {
    shell,
    input,
    lines,
    fireInput,
    fireEnter,
    fireComposition,
    echoText,
    document_,
    firstOutputCount: () => firstOutputs,
  };
}

test("factory validates options fail-fast", () => {
  const { document_ } = openShell();
  const element = (id) => document_.getElementById(id);

  // A missing or mis-typed element must throw at the boundary, not as a
  // cryptic TypeError inside the first event listener.
  assert.throws(() => openShell({ screen: undefined }), TypeError);
  assert.throws(() => openShell({ output: null }), TypeError);
  // A div is an element but not a text field.
  assert.throws(
    () => openShell({ field: /** @type {any} */ (element("output")) }),
    /text field/,
  );
  assert.throws(() => openShell({ onLine: undefined }), TypeError);
  assert.throws(() => openShell({ maxInputLength: 0 }), TypeError);
  assert.throws(() => openShell({ maxInputLength: 12.5 }), TypeError);
  assert.throws(
    () => openShell({ normalizeLine: /** @type {any} */ ("nope") }),
    TypeError,
  );
});

test("a field can host only one shell", () => {
  const { shell, input, document_ } = openShell();
  assert.ok(shell);

  const second = () =>
    createTerminalShell({
      screen: /** @type {HTMLElement} */ (document_.getElementById("screen")),
      output: /** @type {HTMLElement} */ (document_.getElementById("output")),
      inputLine: /** @type {HTMLElement} */ (document_.getElementById("input")),
      cursor: /** @type {HTMLElement} */ (document_.getElementById("cursor")),
      field: input,
      container: /** @type {HTMLElement} */ (
        document_.getElementById("terminal-container")
      ),
      onLine: () => {},
    });
  assert.throws(second, /already hosts a terminal shell/);
  // A DIFFERENT field in the same document is fine.
  const other = document_.createElement("input");
  other.type = "text";
  document_.getElementById("terminal-container")?.append(other);
  assert.doesNotThrow(() =>
    createTerminalShell({
      screen: /** @type {HTMLElement} */ (document_.getElementById("screen")),
      output: /** @type {HTMLElement} */ (document_.getElementById("output")),
      inputLine: /** @type {HTMLElement} */ (document_.getElementById("input")),
      cursor: /** @type {HTMLElement} */ (document_.getElementById("cursor")),
      field: /** @type {HTMLInputElement} */ (other),
      container: /** @type {HTMLElement} */ (
        document_.getElementById("terminal-container")
      ),
      onLine: () => {},
    }),
  );
});

test("maxInputLength caps the echo and the submitted line", () => {
  const { shell, input, lines, fireInput, fireEnter, echoText } = openShell({
    maxInputLength: 4,
  });
  shell.beginInput();

  input.value = "LOOKING";
  fireInput();
  assert.equal(echoText(), "LOOK", "the echo is capped");
  fireEnter();
  assert.deepEqual(lines, ["LOOK\n"], "the submitted line is capped");
});

test("output that starts with a newline is not double-separated", () => {
  const { shell, input, fireInput, fireEnter, document_ } = openShell();
  shell.beginInput();

  shell.appendOutput("PROMPT");
  input.value = "LOOK";
  fireInput();
  fireEnter();
  // An engine block that opens with its own separator (the FORTRAN "/" at
  // the start of a record) must not gain a second blank line.
  shell.appendOutput("\nTHE HEADER");
  shell.flushOutputRender();

  const output = /** @type {HTMLElement} */ (
    document_.getElementById("output")
  );
  assert.ok(output.textContent?.includes("LOOK\n\nTHE HEADER"));
  assert.ok(!output.textContent?.includes("LOOK\n\n\n"), "no double separator");
});

test("the cursor shows while waiting and hides on blur", () => {
  const { shell, input } = openShell();
  const cursor = /** @type {HTMLElement} */ (
    input.ownerDocument.getElementById("cursor")
  );

  shell.beginInput();
  assert.equal(cursor.style.visibility, "visible", "waiting: cursor on");

  input.blur();
  assert.equal(cursor.style.visibility, "hidden", "blurred: cursor off");
});

test("reset abandons an in-flight line and re-arms beginInput", () => {
  const { shell, input, lines, fireInput, echoText } = openShell();
  shell.beginInput();

  input.value = "LOOK";
  fireInput();
  shell.reset("LOADING...\n");

  assert.deepEqual(lines, [], "the in-flight line is never submitted");
  assert.equal(input.value, "", "the field is cleared");
  assert.equal(echoText(), "", "the echo is cleared");
  assert.equal(shell.isWaitingForInput(), false);
  assert.equal(
    input.ownerDocument.getElementById("output")?.textContent,
    "LOADING...\n",
    "the banner replaces the transcript",
  );

  shell.beginInput();
  input.value = "N";
  fireInput();
  assert.equal(echoText(), "N", "the shell collects lines again");
});

test("typing echoes faithfully; submit normalizes once and clears", () => {
  const { shell, input, lines, fireInput, fireEnter, echoText } = openShell();
  shell.beginInput();

  // What the Vietnamese Telex IME leaves in the field for "look": the
  // second "o" was consumed to compose ô over the first.
  input.value = "loôk";
  fireInput();
  assert.equal(
    echoText(),
    "LOÔK",
    "the live echo shows the composed character",
  );
  assert.equal(input.value, "loôk", "typing never rewrites the native value");

  fireEnter();
  assert.deepEqual(lines, ["LOOK\n"], "onLine gets the engine-ready line");
  assert.equal(input.value, "", "submit clears the field");
  assert.equal(shell.isWaitingForInput(), false, "submit ends the wait");
});

test("IME composition owns the caret; plain typing re-pins it", () => {
  const { shell, input, fireInput, fireComposition, echoText } = openShell();
  shell.beginInput();

  let caretWrites = 0;
  const native = input.setSelectionRange.bind(input);
  input.setSelectionRange = (...arguments_) => {
    caretWrites += 1;
    return native(...arguments_);
  };

  input.value = "OK";
  fireInput();
  assert.equal(caretWrites, 1, "plain typing re-pins the caret");

  // What macOS/Windows Telex IMEs hold as marked text while the user
  // types a,s,s,s,s -- each update REPLACES the marked range.
  fireComposition("compositionstart");
  for (const marked of ["a", "á", "ás", "áss", "ásss"]) {
    input.value = marked;
    fireInput();
    assert.equal(echoText(), marked.toUpperCase());
  }
  assert.equal(
    caretWrites,
    1,
    "input events under composition must not move the caret",
  );

  fireComposition("compositionend");
  assert.equal(caretWrites, 2, "the commit re-takes the caret");
  assert.equal(echoText(), "ÁSSS");
});

test("Enter inside a composition commits it; the next Enter submits", () => {
  const { shell, input, lines, fireInput, fireEnter, fireComposition } =
    openShell();
  shell.beginInput();

  input.value = "loôk";
  fireComposition("compositionstart");
  fireInput();

  // The committing Enter, in both shapes: the standard isComposing flag
  // and Android's legacy keyCode 229.
  fireEnter({ isComposing: true });
  fireEnter({ keyCode: 229 });
  assert.deepEqual(lines, [], "a composing Enter must not submit");

  fireComposition("compositionend");
  fireEnter();
  assert.deepEqual(lines, ["LOOK\n"], "the line survives to submit");
});

test("mobile Enter (insertLineBreak) submits the line", () => {
  const { shell, input, lines } = openShell();
  shell.beginInput();

  // Mobile keyboards signal Enter through insertLineBreak instead of an
  // 'Enter' keydown. (A type=text field can never hold a raw newline --
  // browsers strip line breaks -- so the event type is the signal.)
  input.value = "go north";
  input.dispatchEvent(
    Object.assign(
      new input.ownerDocument.defaultView.Event("input", { bubbles: true }),
      { inputType: "insertLineBreak" },
    ),
  );
  assert.deepEqual(
    lines,
    ["GO NORTH\n"],
    "the line break is the submit signal",
  );
  assert.equal(input.value, "", "the field is cleared");
  assert.equal(shell.isWaitingForInput(), false);
});

test("appendOutput fires the first-output hook once and reset re-arms it", () => {
  const { shell, firstOutputCount } = openShell();

  shell.appendOutput("HELLO\n");
  shell.appendOutput("WORLD\n");
  assert.equal(
    firstOutputCount(),
    1,
    "the hook fires on the first output only",
  );

  shell.reset("LOADING...\n");
  assert.equal(firstOutputCount(), 1);
  shell.appendOutput("NEXT\n");
  assert.equal(firstOutputCount(), 2, "reset re-arms the hook");
});

test("submitted lines are separated from engine output by a blank line", () => {
  const { shell, input, lines, fireInput, fireEnter } = openShell();
  shell.beginInput();

  shell.appendOutput("PROMPT TEXT");
  input.value = "LOOK";
  fireInput();
  fireEnter();
  shell.appendOutput("ANSWER");
  shell.flushOutputRender(); // the burst paints as one frame

  assert.deepEqual(lines, ["LOOK\n"]);
  const output = /** @type {HTMLElement} */ (
    input.ownerDocument.getElementById("output")
  );
  assert.ok(
    output.textContent?.includes("LOOK\n\nANSWER"),
    `echo, separator, then output -- got ${JSON.stringify(output.textContent)}`,
  );
});
