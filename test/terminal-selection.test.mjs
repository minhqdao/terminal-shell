import assert from "node:assert/strict";

import { isTouchPointer, moveInputCaretToEnd } from "../src/terminal-input.js";
import { scrollTerminalToBottom } from "../src/terminal-scroll.js";
import {
  hasTextSelection,
  updateTextContent,
} from "../src/terminal-selection.js";

assert.equal(hasTextSelection(null), false);
assert.equal(hasTextSelection({ isCollapsed: true }), false);
assert.equal(
  hasTextSelection({ isCollapsed: false }),
  true,
  "a dragged text range prevents the terminal input from stealing focus",
);

let writes = 0;
const element = {
  value: "SELECTED OUTPUT",
  get textContent() {
    return this.value;
  },
  set textContent(value) {
    writes++;
    this.value = value;
  },
};

updateTextContent(element, "SELECTED OUTPUT");
assert.equal(
  writes,
  0,
  "rendering unchanged terminal output leaves selected text nodes intact",
);

updateTextContent(element, "NEW OUTPUT");
assert.equal(writes, 1, "new terminal output is still rendered");
assert.equal(element.textContent, "NEW OUTPUT");

const shortScreen = { clientHeight: 600, scrollHeight: 48, scrollTop: 0 };
scrollTerminalToBottom(shortScreen);
assert.equal(
  shortScreen.scrollTop,
  0,
  "short terminal content does not move when typing starts",
);

const screen = { clientHeight: 240, scrollHeight: 480, scrollTop: 0 };
scrollTerminalToBottom(screen);
assert.equal(
  screen.scrollTop,
  480,
  "new terminal input and output remain visible at the bottom",
);

let caret;
const nativeInput = {
  value: "ABC",
  setSelectionRange(start, end) {
    caret = [start, end];
  },
};
moveInputCaretToEnd(nativeInput);
assert.deepEqual(
  caret,
  [3, 3],
  "mobile characters append in order and backspace operates at the end",
);
assert.equal(isTouchPointer({ pointerType: "touch" }), true);
assert.equal(isTouchPointer({ pointerType: "mouse" }), false);

console.log("test: terminal selection and active-line scrolling remain stable");
