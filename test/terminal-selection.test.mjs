import assert from "node:assert/strict";

import { isTouchPointer, moveInputCaretToEnd } from "../src/terminal-input.js";
import { scrollTerminalToBottom } from "../src/terminal-scroll.js";
import {
  hasTextSelection,
  updateTextContent,
} from "../src/terminal-selection.js";
import { createFrameBatcher } from "../src/terminal-render.js";

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

let nextFrame = 1;
let renderCount = 0;
const pendingFrames = new Map();
const outputRenderer = createFrameBatcher(() => renderCount++, {
  requestFrame(callback) {
    const frame = nextFrame++;
    pendingFrames.set(frame, () => {
      pendingFrames.delete(frame);
      callback();
    });
    return frame;
  },
  cancelFrame(frame) {
    pendingFrames.delete(frame);
  },
});

outputRenderer.schedule();
outputRenderer.schedule();
outputRenderer.schedule();
assert.equal(
  pendingFrames.size,
  1,
  "a burst of terminal output schedules only one browser paint",
);
pendingFrames.values().next().value();
assert.equal(renderCount, 1, "a terminal output burst renders only once");

outputRenderer.schedule();
outputRenderer.flush();
assert.equal(
  renderCount,
  2,
  "an input prompt flushes pending output immediately",
);
assert.equal(
  pendingFrames.size,
  0,
  "flushing cancels the pending browser paint",
);

outputRenderer.schedule();
outputRenderer.cancel();
assert.equal(pendingFrames.size, 0, "restarting cancels stale terminal output");
assert.equal(renderCount, 2, "canceling pending output does not render it");

console.log("test: terminal selection and active-line scrolling remain stable");
