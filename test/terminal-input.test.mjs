// Unit tests for the small input helpers (src/terminal-input.js): the
// caret pin keeps editing append-only and tolerates hosts without
// selection support, and the touch classification drives the launcher's
// focus gestures.

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { isTouchPointer, moveInputCaretToEnd } from "../src/terminal-input.js";

test("moveInputCaretToEnd pins the caret to the end of the value", () => {
  const dom = new JSDOM(`<input type="text" />`);
  const input = /** @type {HTMLInputElement} */ (
    dom.window.document.querySelector("input")
  );
  input.value = "LOOK";

  input.setSelectionRange(0, 0);
  assert.equal(input.selectionStart, 0);

  moveInputCaretToEnd(input);
  assert.equal(input.selectionStart, 4);
  assert.equal(input.selectionEnd, 4);
});

test("moveInputCaretToEnd tolerates hosts without selection support", () => {
  // The optional call exists so exotic embedders (or test doubles) without
  // a selection API degrade to a no-op instead of throwing.
  moveInputCaretToEnd(/** @type {HTMLInputElement} */ ({ value: "LOOK" }));
});

test("isTouchPointer classifies pointer types", () => {
  assert.equal(isTouchPointer({ pointerType: "touch" }), true);
  assert.equal(isTouchPointer({ pointerType: "mouse" }), false);
  assert.equal(isTouchPointer({ pointerType: "pen" }), false);
  assert.equal(isTouchPointer({}), false);
});
