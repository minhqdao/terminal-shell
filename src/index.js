// @ts-check

/**
 * terminal-shell -- the single-source browser terminal for the retro-game
 * launchers. See README.md for the host contract.
 */

export { createTerminalShell } from "./terminal-shell.js";
export { isTouchPointer, moveInputCaretToEnd } from "./terminal-input.js";
export {
  KEYBOARD_HEIGHT_KEY,
  KEYBOARD_SLIDE_MS,
  LATE_READING_FRACTION,
  MISMATCH_PX,
  SETTLE_EPSILON_PX,
  decideReading,
  detectKeyboardMode,
  easeInOut,
  forecastInset,
  retargetDuration,
  shouldBlockNorthDrag,
} from "./terminal-keyboard.js";
export {
  decideLogMove,
  decideLogWheel,
  drivenScrollTop,
  flickVelocity,
  momentumStep,
} from "./terminal-log.js";
export {
  sanitizeTerminalOutput,
  stripLineLeadingSpace,
} from "./terminal-output.js";
export { createFrameBatcher } from "./terminal-render.js";
export {
  isPinnedToBottom,
  measureKeyboardInset,
  scrollTerminalToBottom,
} from "./terminal-scroll.js";
export { hasTextSelection, updateTextContent } from "./terminal-selection.js";
export { toEngineText } from "./terminal-text.js";
export {
  createKeysBuffer,
  maxInputLength,
  readInputLine,
  runnerCommand,
  runnerEvent,
  writeInputLine,
} from "./runner-protocol.js";
export { startEmscriptenRunner } from "./emscripten-runner.js";
