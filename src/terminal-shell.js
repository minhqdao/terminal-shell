// @ts-check
//
// The terminal shell: every piece of browser interaction shared by the
// retro-game launchers (colossal-cave-wasm, oregon-fortran-wasm, Basicade's
// demo), extracted so it lives in exactly one place. The host supplies the
// DOM elements and the engine boundary; the shell owns everything the user
// touches:
//
//   - the transcript: append-only text state, output sanitizing, batched
//     repaints, bottom pinning;
//   - the command line: a hidden field the browser/IME edits and the shell
//     only reads (faithful forwarding -- composed text REPLACES the
//     character it accents, so the field is hands-off under composition),
//     upper-cased echo, caret re-pinning, Enter/newline submit, and the
//     one normalization choke point at submit;
//   - scrolling: the driven transcript inside the touch shell (hard ends,
//     emulated flick momentum, latched top hand-off), native outside it;
//   - the soft keyboard: the --keyboard-inset driver that forecasts,
//     retargets, and settles (keyboard-lab blue16/17/20), the north-drag
//     gate (blue14/15), the page-scroll pin, and Android's native-log mode;
//   - focus: tap-to-focus, visibility restore, the desktop resize net.
//
// The HOST keeps everything engine-shaped: the worker and its lifecycle,
// the SharedArrayBuffer writes behind onLine, boot/recovery reloads,
// status text, restart. onLine receives the submitted line INCLUDING its
// trailing "\n", printable-ASCII, ready for a one-byte-per-character
// buffer (writeInputLine from "./runner-protocol.js").

import {
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
import {
  decideLogMove,
  decideLogWheel,
  drivenScrollTop,
  flickVelocity,
  momentumStep,
} from "./terminal-log.js";
import {
  isPinnedToBottom,
  measureKeyboardInset,
  scrollTerminalToBottom,
} from "./terminal-scroll.js";
import { hasTextSelection, updateTextContent } from "./terminal-selection.js";
import { isTouchPointer, moveInputCaretToEnd } from "./terminal-input.js";
import {
  sanitizeTerminalOutput,
  stripLineLeadingSpace,
} from "./terminal-output.js";
import { createFrameBatcher } from "./terminal-render.js";
import { toEngineText } from "./terminal-text.js";

/**
 * @typedef {Object} TerminalShellOptions
 * @property {HTMLElement} screen the transcript scroller (driven inside the
 *   touch shell, native outside it).
 * @property {HTMLElement} output the element carrying the transcript text.
 * @property {HTMLElement} inputLine the element carrying the echoed line.
 * @property {HTMLElement} cursor the blinking caret element.
 * @property {HTMLInputElement} field the hidden text field the shell reads.
 * @property {HTMLElement} container the terminal's outer box; pointer and
 *   click handlers that raise the keyboard attach here.
 * @property {HTMLElement | null} [insetTarget] the element that receives
 *   the `--keyboard-inset` custom property; without it the soft-keyboard
 *   driver stands down (desktop layouts that never shrink).
 * @property {(line: string) => void} onLine called once per submitted line
 *   with the normalized line including its trailing "\n".
 * @property {() => void} [onFirstOutput] called when the first engine
 *   output arrives (and again after reset); the host disarms its boot
 *   guard here.
 * @property {(line: string) => string} [normalizeLine] the submit-time
 *   text policy. Defaults to toEngineText: upper case, printable ASCII,
 *   composed accents resolved to their base letters.
 * @property {number} [maxInputLength] the live line cap, display and
 *   submit. Defaults to 254 (the runner protocol's keys-buffer capacity).
 * @property {string} [keyboardHeightKey] localStorage key for the measured
 *   soft-keyboard height. Defaults to KEYBOARD_HEIGHT_KEY.
 * @property {string} [nativeLogDataset] dataset key (camelCase) that, when
 *   set to "native" on the document element under Android, switches the
 *   transcript to the platform's own scroller; e.g. "adventureLog".
 * @property {(text: string, atLineStart: boolean) => string} [transformOutput]
 *   the per-chunk transcript transform. Defaults to the FORTRAN-flavored
 *   sanitize + single-leading-space strip; hosts whose engines print
 *   significant leading spaces (BASIC listings) sanitize only.
 */

/**
 * @typedef {Object} TerminalShell
 * @property {(text: string) => void} appendOutput appends engine output to
 *   the transcript (sanitized, batched, auto-separated from user input).
 * @property {() => void} beginInput the engine asked for input: clears the
 *   field, focuses it, and starts the cursor.
 * @property {(banner?: string) => void} reset clears the transcript to
 *   `banner` (default ""), disarms the first-output hook, and abandons any
 *   in-flight line.
 * @property {() => void} flushOutputRender paints a pending batched
 *   transcript update immediately.
 * @property {() => void} cancelOutputRender drops a pending batched
 *   transcript update.
 * @property {(options?: { force?: boolean }) => void} focusInput focuses
 *   the hidden field; `force` marks a gesture focus (the only kind that
 *   raises iOS's soft keyboard from a closed state).
 * @property {() => void} endInput the engine stopped asking for input
 *   (error, exit, startup failure): drop the wait and repaint, keeping
 *   the transcript as it is.
 * @property {() => boolean} isWaitingForInput whether the shell is
 *   currently collecting a line.
 */

// Fields that already host a shell: a second shell on the same field would
// double-handle every keystroke (HMR re-mounts, copy-pasted wiring). One
// field, one shell.
const hostedFields = new WeakSet();

/**
 * Fail-fast option checks at the boundary: a missing or mis-typed element
 * would otherwise surface as a cryptic TypeError deep inside the first
 * event listener. The checks are duck-typed on purpose -- the host
 * document may live in another realm (tests, iframes), where instanceof
 * is unreliable.
 * @param {TerminalShellOptions} options
 */
function validateOptions({
  screen,
  output,
  inputLine,
  cursor,
  field,
  container,
  insetTarget,
  onLine,
  onFirstOutput,
  normalizeLine,
  maxInputLength,
  keyboardHeightKey,
  nativeLogDataset,
}) {
  for (const [name, element] of Object.entries({
    screen,
    output,
    inputLine,
    cursor,
    field,
    container,
  })) {
    if (
      !element ||
      element.nodeType !== 1 ||
      typeof element.addEventListener !== "function"
    ) {
      throw new TypeError(`terminal-shell: options.${name} must be an element`);
    }
  }
  if (typeof field.setSelectionRange !== "function") {
    throw new TypeError(
      "terminal-shell: options.field must be a text field (input or textarea)",
    );
  }
  if (
    insetTarget !== null &&
    insetTarget !== undefined &&
    (insetTarget.nodeType !== 1 ||
      typeof insetTarget.addEventListener !== "function")
  ) {
    throw new TypeError(
      "terminal-shell: options.insetTarget must be an element or null",
    );
  }
  if (typeof onLine !== "function") {
    throw new TypeError("terminal-shell: options.onLine must be a function");
  }
  for (const [name, callback] of Object.entries({
    onFirstOutput,
    normalizeLine,
  })) {
    if (callback !== undefined && typeof callback !== "function") {
      throw new TypeError(`terminal-shell: options.${name} must be a function`);
    }
  }
  // undefined means "use the factory default", applied below.
  if (
    maxInputLength !== undefined &&
    (!Number.isInteger(maxInputLength) || maxInputLength < 1)
  ) {
    throw new TypeError(
      "terminal-shell: options.maxInputLength must be a positive integer",
    );
  }
  for (const [name, string] of Object.entries({
    keyboardHeightKey,
    nativeLogDataset,
  })) {
    if (string !== undefined && typeof string !== "string") {
      throw new TypeError(`terminal-shell: options.${name} must be a string`);
    }
  }
  if (hostedFields.has(field)) {
    throw new TypeError(
      "terminal-shell: options.field already hosts a terminal shell",
    );
  }
  hostedFields.add(field);
}

/**
 * Creates the terminal shell. One per page; the listeners it registers
 * (document visibilitychange, window scroll/resize, and the element
 * listeners) live for the page's lifetime. Options are validated up
 * front, and a field can host only one shell.
 * @param {TerminalShellOptions} options
 * @returns {TerminalShell}
 */
export function createTerminalShell(options) {
  validateOptions(options);
  const {
    screen,
    output,
    inputLine,
    cursor,
    field,
    container,
    insetTarget = null,
    onLine,
    onFirstOutput,
    normalizeLine = toEngineText,
    transformOutput = (text, atLineStart) =>
      stripLineLeadingSpace(sanitizeTerminalOutput(text), atLineStart),
    maxInputLength = 254,
    keyboardHeightKey = KEYBOARD_HEIGHT_KEY,
    nativeLogDataset,
  } = options;
  let terminalText = "";
  let currentInput = "";
  let waitingForInput = false;
  let pendingInputSeparator = false;
  let hasReceivedFirstOutput = false;
  let isCursorActive = false;

  // --- transcript ------------------------------------------------------------

  /** @param {string} text */
  function appendOutput(text) {
    if (!hasReceivedFirstOutput) {
      terminalText = "";
      hasReceivedFirstOutput = true;
      // The first engine output means the whole module graph loaded and the
      // worker is streaming: the host can disarm its boot guard (recovery
      // reload + watchdog) so it can never misfire later in the session.
      onFirstOutput?.();
    }

    // Visually separate user input from the engine's answer with a blank
    // line. Output that already starts with one (a leading "/" in the
    // FORTRAN format, e.g. the MONDAY turn header) provides it itself.
    if (pendingInputSeparator && !text.startsWith("\n")) {
      terminalText += "\n";
    }
    pendingInputSeparator = false;

    const atLineStart = terminalText === "" || terminalText.endsWith("\n");
    terminalText += transformOutput(text, atLineStart);
    scheduleOutputRender();
  }

  function scheduleOutputRender() {
    // The engine can emit a block as a burst of individual lines. Rendering
    // and scrolling for every worker message makes the bottom of the
    // terminal visibly jump between intermediate layouts. Paint the
    // complete burst once.
    outputRenderer.schedule();
  }

  const outputRenderer = createFrameBatcher(() => {
    render();
    scrollTerminalToBottom(screen);
  });

  function render() {
    updateTextContent(output, terminalText);
    updateTextContent(inputLine, waitingForInput ? currentInput : "");

    updateTextContent(cursor, waitingForInput ? "_" : "");

    const shouldShowCursor =
      waitingForInput && document.activeElement === field;

    if (shouldShowCursor) {
      if (!isCursorActive) {
        // Transitioning from inactive to active: restart animation
        isCursorActive = true;
        cursor.style.visibility = "visible";
        cursor.classList.remove("blinking");
        void cursor.offsetWidth; // Force reflow to restart CSS animation
        cursor.classList.add("blinking");
      } else {
        // Already active: just ensure it's visible
        cursor.style.visibility = "visible";
      }
    } else {
      // Inactive or not waiting for input
      isCursorActive = false;
      cursor.style.visibility = "hidden";
    }
  }

  // --- the command line -------------------------------------------------------
  //
  // The hidden field owns the text: the browser and its IME edit it, and
  // the shell only reads. Every change is echoed to the visible line, and
  // the caret is re-pinned to the end so editing stays append-only. While
  // an IME composition is active the field is hands-off -- no value
  // writes, no caret moves: composed text REPLACES the character it
  // accents, so touching the field under the IME corrupts the marked range
  // and every update then re-inserts the whole composition instead
  // (AÁASASS...), while stripping it deletes the base letter outright (the
  // original vanishing-character bug). The engine's text policy applies
  // exactly once, at submit.

  let composing = false;

  field.addEventListener("compositionstart", () => {
    composing = true;
  });

  field.addEventListener("compositionend", () => {
    composing = false;
    // The IME handed the text over; re-echo the committed line and take
    // the caret back for append-only editing.
    if (waitingForInput) {
      echoLiveInput();
      retakeCaret();
    }
  });

  field.addEventListener("input", (event) => {
    if (!waitingForInput) return;

    // Mobile keyboards often insert a newline (\n) or trigger
    // insertLineBreak instead of an 'Enter' keydown event. The final input
    // event's characters ride along in the field value, so take the live
    // text, not the stale last echo; the newline itself is the submit
    // signal, never part of the line (the normalizer drops it).
    if (
      /** @type {InputEvent} */ (event).inputType === "insertLineBreak" ||
      field.value.includes("\n")
    ) {
      currentInput = liveInputText();
      submitInput();
      return;
    }

    echoLiveInput();
    retakeCaret();
  });

  // Handle desktop 'Enter' key press. An Enter that belongs to an IME
  // composition (keyCode 229 is the legacy Android signal for it) commits
  // the marked text; submitting here would clear the field
  // mid-composition. The commit lands through compositionend above, and
  // the next Enter submits.
  field.addEventListener("keydown", (event) => {
    if (
      waitingForInput &&
      event.key === "Enter" &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      submitInput();
    }
  });

  /**
   * The live line for display and submit, from the field's faithful value:
   * upper-cased for the terminal and capped at the line length.
   * @returns {string}
   */
  function liveInputText() {
    return field.value.toUpperCase().slice(0, maxInputLength);
  }

  /** Echoes the field's current text to the terminal's input line. */
  function echoLiveInput() {
    currentInput = liveInputText();
    render();
    scrollTerminalToBottom(screen);
  }

  /**
   * Re-pins the caret to the end of the field (append-only editing). Never
   * under an active composition: the IME owns the selection while its text
   * is marked, and a selection write under it turns every composition
   * update into an insertion of the full pending text.
   */
  function retakeCaret() {
    if (!composing) moveInputCaretToEnd(field);
  }

  function submitInput() {
    // The engine buffer stores one byte per character, so the line is
    // normalized to printable ASCII exactly here -- the single policy
    // choke point after the faithful forwarding that fed it. What happens
    // next is host-owned: the SharedArrayBuffer write behind onLine, the
    // response watchdog, and the restart-if-dead safety net.
    const value = `${normalizeLine(currentInput)}\n`;
    terminalText += value;
    pendingInputSeparator = true;
    currentInput = "";
    field.value = "";
    waitingForInput = false;
    render();
    scrollTerminalToBottom(screen);

    onLine(value);
  }

  // --- focus, tap, and selection ----------------------------------------------

  let terminalPointerInteraction = false;
  let touchMouseEventPending = false;
  let clickFollowsTouch = false;
  let focusFromGesture = false;

  /**
   * @param {{ force?: boolean }} [options]
   */
  function focusTerminalInput({ force = false } = {}) {
    if (!waitingForInput) return;
    if (document.activeElement === field) {
      // iOS can leave the field focused without ever showing the soft
      // keyboard. Re-focusing it then does nothing, so on a tap (a real
      // gesture) blur first: the following focus() is an activation again
      // and iOS opens the keyboard.
      if (!force || !needsSoftKeyboardFocus()) return;
      focusFromGesture = true;
      field.blur();
    } else if (force) {
      focusFromGesture = true;
    }
    // preventScroll: focusing must never yank the viewport around; opening
    // the keyboard itself may, which is Safari's own behavior and left
    // alone.
    field.focus({ preventScroll: true });
    retakeCaret();
  }

  function handleTerminalClick() {
    // A click is also fired after dragging to select text. Refocusing the
    // hidden input here would collapse the range the user just created.
    const followsTouch = clickFollowsTouch;
    clickFollowsTouch = false;
    if (!hasTextSelection(window.getSelection())) {
      // On touch devices the keyboard only rises for focus() calls inside
      // a gesture handler, and `click` is one that browsers suppress
      // whenever the finger moved (scroll drag, selection pan) -- unlike
      // `pointerdown`, which fires for every touch.
      focusTerminalInput({ force: followsTouch });
    } else {
      render();
    }
    terminalPointerInteraction = false;
  }

  /** @param {PointerEvent} event */
  function handleTerminalPointerDown(event) {
    terminalPointerInteraction = true;
    touchMouseEventPending = isTouchPointer(event);
    if (touchMouseEventPending) clickFollowsTouch = true;
  }

  function handleTerminalPointerCancel() {
    terminalPointerInteraction = false;
    render();
  }

  /** @param {MouseEvent} event */
  function handleTerminalMouseDown(event) {
    const followsTouch = touchMouseEventPending;
    touchMouseEventPending = false;
    const targetsTerminalBackground =
      event.target === screen || event.target === container;

    // Mobile browsers synthesize mouse events after a touch, while desktop
    // browsers move focus when the blank terminal background is clicked.
    // Avoid both redundant blur/refocus cycles. Mouse selection still works
    // because mousedown events that target terminal text keep their
    // default behavior.
    if (
      document.activeElement === field &&
      (followsTouch || targetsTerminalBackground)
    ) {
      event.preventDefault();
    }
  }

  container.addEventListener("pointerdown", handleTerminalPointerDown);
  container.addEventListener("pointercancel", handleTerminalPointerCancel);
  container.addEventListener("mousedown", handleTerminalMouseDown);
  container.addEventListener("click", handleTerminalClick);

  field.addEventListener("focus", () => {
    render();
    // At focus time the keyboard is (nearly) always still closed, so this
    // is the reliable moment to record the unobstructed viewport height.
    keyboardClosedViewportHeight = Math.max(
      keyboardClosedViewportHeight,
      keyboardViewport.height ?? window.innerHeight,
    );
    onKeyboardFocus();
  });

  field.addEventListener("blur", () => {
    onKeyboardBlur();
    // Clicking terminal text briefly transfers focus so the browser can
    // retain native text selection. Keep the existing cursor animation
    // running until the click determines whether this was a tap/click or a
    // selection drag.
    if (!terminalPointerInteraction) render();
  });

  function restoreTerminalAfterVisibilityChange() {
    if (document.visibilityState !== "visible") return;

    const scrollTop = screen.scrollTop;
    const maxScrollTop = screen.scrollHeight - screen.clientHeight;
    if (maxScrollTop > 0) {
      screen.scrollTop = scrollTop > 0 ? scrollTop - 1 : 1;
      screen.scrollTop = scrollTop;
    }
    // iOS drops the keyboard while the tab is hidden and the field usually
    // stays focused, so a plain focus() would change nothing. The tap on
    // return re-focuses via click; this only refreshes the caret state.
    focusTerminalInput();
  }

  document.addEventListener(
    "visibilitychange",
    restoreTerminalAfterVisibilityChange,
  );

  // Desktop-only safety net: a window resize (OS resize, fullscreen toggle,
  // devtools dock) re-measures the scrollable terminal without firing
  // anything that keeps the just-shown prompt in view, so it can end up
  // scrolled off. Touch is excluded here -- the keyboard-inset update below
  // owns the touch re-scroll -- because yanking the terminal to the bottom
  // mid soft-keyboard-animation is exactly what the inset tracks instead.
  window.addEventListener("resize", () => {
    if (usesTouchInput()) return;
    if (!waitingForInput || document.activeElement !== field) return;
    scrollTerminalToBottom(screen);
  });

  // --- soft-keyboard detection and the --keyboard-inset driver -----------------
  //
  // Soft-keyboard detection is necessary because iOS raises the keyboard
  // only for focus() calls made inside a gesture handler, so the auto-focus
  // issued when the engine asks for input leaves the field focused with
  // the keyboard still closed. A tap must then re-trigger focus, which
  // requires knowing whether the keyboard is already open.
  //
  // Touch-only: keep the prompt above the soft keyboard by shrinking the
  // inset target, and keep it shrinking IN SYNC with the keyboard's own
  // slide. iOS fires visualViewport.resize once, with the FINAL height, at
  // the end of the slide -- never progressively -- so writing that reading
  // straight into the CSS variable held the terminal at full size for the
  // whole slide and then snapped it (the keyboard-lab blue16 failure). The
  // driver instead forecasts the final inset at focus -- the measured
  // height from the previous open, persisted so every open after the very
  // first is exact, else a fraction of the layout -- and self-animates
  // --keyboard-inset over the keyboard's own timing. The honest reading
  // still arrives, but it only ever RETARGETS the running move or finishes
  // it with a short glide (blue17/20); see terminal-keyboard.js. Android
  // honors interactive-widget=resizes-content: the layout shrinks
  // natively, the honest reading says 0, and the driver stands down.
  // Desktop is excluded: the var is unused outside the mobile media query
  // and a desktop window resize is already handled above.

  /**
   * The visual viewport when available, otherwise window. Only `height` is
   * read, with a ?? fallback to innerHeight on window.
   * @type {{
   *   height?: number,
   *   addEventListener: typeof window.addEventListener,
   * }}
   */
  const keyboardViewport = window.visualViewport ?? window;
  const usesMobilePointer = window.matchMedia("(pointer: coarse)");
  // Fixed-shell touch layout (mirrors the host's CSS shell -- keep in
  // step): coarse pointer with no hover, i.e. phones/tablets but not touch
  // laptops, which keep the scrolling desktop layout.
  const usesFixedShell = window.matchMedia(
    "(pointer: coarse) and (hover: none)",
  );
  let keyboardClosedViewportHeight =
    keyboardViewport.height ?? window.innerHeight;

  function usesTouchInput() {
    return usesMobilePointer.matches || navigator.maxTouchPoints > 0;
  }

  function needsSoftKeyboardFocus() {
    if (!usesTouchInput()) return false;
    const height = keyboardViewport.height ?? window.innerHeight;
    const closedHeight = Math.max(
      keyboardClosedViewportHeight,
      window.innerHeight,
      height,
    );
    return closedHeight - height <= 80;
  }

  // Android Chrome gets a native transcript scroller (see the host's CSS
  // override): Blink latches a gesture to the document scroller the
  // instant one touchmove is not preventDefault-ed, so a JS driver racing
  // the compositor on a heavy transcript intermittently loses -- and the
  // lost race actuates pull-to-refresh in the middle of the log. A native
  // scroller scrolls, chains to the page, and PTRs by itself, correctly,
  // with no race to lose. iOS keeps the driven log (blue29/30): perfect
  // there, untouched here. UA-gated like iosLike below -- the measured
  // pan/resize mode is only known after a keyboard opens, but scrolling
  // must behave from the first gesture.
  const androidLike = /Android/.test(navigator.userAgent);
  if (androidLike && nativeLogDataset) {
    document.documentElement.dataset[nativeLogDataset] = "native";
  }

  const iosLike =
    /iP(hone|o(d|ad))/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  function loadStoredKeyboardHeight() {
    try {
      return Number(localStorage.getItem(keyboardHeightKey)) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * @param {number} px
   */
  function rememberKeyboardHeight(px) {
    if (px <= 0.5) return;
    storedKeyboardHeight = px;
    try {
      localStorage.setItem(keyboardHeightKey, String(Math.round(px)));
    } catch {
      // Private modes can throw on storage access; the forecast then falls
      // back to the layout estimate on every open, which still retargets.
    }
  }

  function forgetStoredKeyboardHeight() {
    storedKeyboardHeight = 0;
    try {
      localStorage.removeItem(keyboardHeightKey);
    } catch {
      // Nothing to clean up when storage is unavailable.
    }
  }

  let shownInset = 0; // px of --keyboard-inset currently displayed
  let insetFrom = 0;
  let insetTo = 0;
  let animStart = 0;
  let animDur = 0;
  let animating = false;
  let busyUntil = 0; // rAF stays alive through a transition plus slack
  let insetRaf = 0;
  let keyboardFocused = false;
  // Whether the transcript was pinned to the bottom when focus started: a
  // reader parked on the newest line rides the shrink; one who scrolled up
  // into history stays there.
  let pinnedToBottom = false;
  let focusSeq = 0;
  let lastResizeSeq = 0;
  /** @type {number | undefined} */
  let noShowTimer;
  /** @type {number | undefined} */
  let settleTimer;
  let baseLayoutHeight = document.documentElement.clientHeight;
  /** @type {import("./terminal-keyboard.js").KeyboardMode} */
  let keyboardMode = "unknown";
  let storedKeyboardHeight = loadStoredKeyboardHeight();

  let lastAppliedInset = "";
  /**
   * @param {number} px
   */
  function applyInset(px) {
    if (!insetTarget) return;
    const v = px.toFixed(1);
    if (v === lastAppliedInset) return;
    lastAppliedInset = v;
    insetTarget.style.setProperty("--keyboard-inset", `${v}px`);
  }

  function needInsetFrame() {
    if (!insetRaf) insetRaf = requestAnimationFrame(insetStep);
  }

  /**
   * @param {number} target
   * @param {number} duration
   * @param {number} now
   */
  function driveInsetTo(target, duration, now) {
    insetFrom = shownInset;
    insetTo = target;
    animStart = now;
    animDur = Math.max(40, duration);
    animating = true;
    busyUntil = Math.max(busyUntil, now + animDur + 220);
    needInsetFrame();
  }

  /**
   * @param {number} now rAF timestamp
   */
  function insetStep(now) {
    insetRaf = 0;
    if (animating) {
      const t = Math.min(1, (now - animStart) / animDur);
      shownInset = insetFrom + (insetTo - insetFrom) * easeInOut(t);
      if (t >= 1) {
        shownInset = insetTo;
        animating = false;
      }
    }
    applyInset(shownInset);
    // Keep the transcript glued to the terminal's bottom edge -- where the
    // input line lives -- but ONLY while a keyboard transition window is
    // actually running (blue30). A pull-to-refresh pan fires
    // visualViewport scrolls and hence frames long after the keyboard
    // settled; gluing on focus alone would slam the transcript back down
    // mid-pull. The transcript driver below also clears pinnedToBottom the
    // moment the user scrolls, so no later resize can yank the transcript
    // either.
    if (pinnedToBottom && (animating || now < busyUntil)) {
      scrollTerminalToBottom(screen);
    }
    if (animating || now < busyUntil) needInsetFrame();
  }

  /**
   * The honest inset reading, or null when there is nothing to act on: no
   * viewport model (desktop), no inset target, or a pinch (the zoom
   * shrinks the visual viewport in ways the layout must not chase, and the
   * keyboard cannot be open mid-pinch). measureKeyboardInset cancels the
   * currently applied inset out of the geometry, so the reading stays
   * stable while the animation runs.
   * @returns {number | null}
   */
  function readHonestInset() {
    const viewport = window.visualViewport;
    if (!viewport || !insetTarget) return null;
    if (viewport.scale && Math.abs(viewport.scale - 1) > 0.01) return null;
    return measureKeyboardInset(insetTarget, viewport, shownInset);
  }

  // Pan vs. resize is decided from the measurement, never the UA: a WebKit
  // that ever resizes the layout viewport for the keyboard turns the pan
  // machinery (the gate, the scroll pin) off by itself. A closed reading
  // only re-baselines the layout height for the next comparison.
  /**
   * @param {number} reading
   * @returns {import("./terminal-keyboard.js").KeyboardMode}
   */
  function detectMode(reading) {
    if (reading > 0.5) {
      keyboardMode = detectKeyboardMode({
        reading,
        layoutHeight: document.documentElement.clientHeight,
        baseLayoutHeight,
      });
      armGate();
    } else {
      baseLayoutHeight = document.documentElement.clientHeight;
    }
    return keyboardMode;
  }

  function onKeyboardFocus() {
    keyboardFocused = true;
    pinnedToBottom = isPinnedToBottom(screen);
    // Only a focus from a released tap can raise iOS's keyboard. The
    // engine's auto-focus (and a visibility-restore) leaves it closed, so
    // forecasting there would shrink the terminal for a keyboard that
    // never comes; the no-show guard would undo it, but the transient
    // shrink is still wrong.
    const fromGesture = focusFromGesture;
    focusFromGesture = false;
    const reading = readHonestInset() ?? 0;
    detectMode(reading);
    if (keyboardMode === "resize") return; // Android: layout already shrank
    if (!fromGesture || !iosLike) return; // desktop: no soft keyboard to match
    rememberKeyboardHeight(reading);
    // Forecast the final inset; the honest vv.resize reading (one burst, at
    // slide end, on iOS) retargets this later.
    const forecast = forecastInset({
      measured: reading,
      stored: storedKeyboardHeight,
      layoutHeight: document.documentElement.clientHeight,
    });
    const seq = ++focusSeq;
    driveInsetTo(forecast, KEYBOARD_SLIDE_MS, performance.now());
    // No-show guard: if no honest reading ever arrives and the visual
    // viewport never shrank, no soft keyboard is coming (hardware keyboard
    // attached, iPad cursor) -- undo the forecast smoothly instead of
    // leaving the terminal stranded small.
    clearTimeout(noShowTimer);
    noShowTimer = setTimeout(() => {
      if (
        keyboardFocused &&
        focusSeq === seq &&
        lastResizeSeq !== seq &&
        (readHonestInset() ?? 0) < 1 &&
        shownInset > 1
      ) {
        driveInsetTo(0, 160, performance.now());
      }
    }, KEYBOARD_SLIDE_MS + 800);
  }

  function onKeyboardBlur() {
    keyboardFocused = false;
    clearTimeout(noShowTimer);
    driveInsetTo(0, KEYBOARD_SLIDE_MS, performance.now());
  }

  // One decision path for an honest reading, shared by the resize and
  // scroll handlers: settle with a short glide, retarget the running move,
  // or drop the reading as mid-slide noise. A reading taken at rest can
  // only correct, never contaminate, so every reading also schedules a
  // settle re-measure that catches whatever was dropped.
  /**
   * @param {number} reading
   */
  function applyReading(reading) {
    const now = performance.now();
    const settled = now > busyUntil;
    const mismatch = Math.abs(reading - insetTo) > MISMATCH_PX;
    const extending = keyboardFocused
      ? reading > insetTo - 0.5
      : reading < insetTo + 0.5;
    const late =
      animDur > 0 && (now - animStart) / animDur >= LATE_READING_FRACTION;
    const decision = decideReading({
      settled,
      mismatch,
      extending,
      late,
      focused: keyboardFocused,
    });
    if (decision === "settle") {
      if (Math.abs(reading - shownInset) > SETTLE_EPSILON_PX) {
        driveInsetTo(reading, 120, now);
      }
    } else if (decision === "retarget" || decision === "retarget-late") {
      driveInsetTo(
        reading,
        retargetDuration({ animating, animDur, elapsed: now - animStart }),
        now,
      );
    }
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const honest = readHonestInset();
      if (honest === null) return;
      detectMode(honest);
      if (Math.abs(honest - shownInset) > SETTLE_EPSILON_PX) {
        driveInsetTo(honest, 120, performance.now());
      }
    }, 450);
  }

  function onKeyboardViewportResize() {
    if (!usesTouchInput()) return;
    lastResizeSeq = focusSeq;
    const reading = readHonestInset();
    if (reading === null) return; // pinch: hold
    rememberKeyboardHeight(reading);
    detectMode(reading);
    if (keyboardMode === "resize") {
      // Android/native shrink: the layout already moved, so
      // --keyboard-inset must stay 0 or it double-subtracts.
      animating = false;
      shownInset = 0;
      applyInset(0);
      return;
    }
    applyReading(reading);
  }

  function onKeyboardViewportScroll() {
    if (!usesTouchInput()) return;
    // A pan moves the visible window without changing the keyboard's size.
    // Mid-animation it is noise (the resize handler owns transitions); at
    // rest it can only correct.
    if (performance.now() <= busyUntil) return;
    const reading = readHonestInset();
    if (reading === null) return;
    if (Math.abs(reading - shownInset) > SETTLE_EPSILON_PX) {
      driveInsetTo(reading, 120, performance.now());
    }
  }

  if (window.visualViewport) {
    // Keyboard show/hide and orientation change both fire resize here; the
    // driver keeps the prompt riding above the keyboard through either.
    window.visualViewport.addEventListener("resize", onKeyboardViewportResize);
    window.visualViewport.addEventListener("scroll", onKeyboardViewportScroll);
  }
  // Fallback for browsers / WebViews that miss visualViewport events.
  let lastInnerWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (!usesTouchInput()) return;
    if (window.innerWidth !== lastInnerWidth) {
      // Rotation: the stored keyboard height belongs to the old geometry,
      // and the closed-viewport ratchet to the old orientation.
      lastInnerWidth = window.innerWidth;
      forgetStoredKeyboardHeight();
      keyboardClosedViewportHeight = 0;
    }
    const reading = readHonestInset();
    if (reading === null) return;
    detectMode(reading);
    driveInsetTo(reading, 160, performance.now());
  });

  // ================= the north-drag gate (blue14/15, blue24) =================
  // WebKit never resizes the layout viewport for the keyboard (bug 259770);
  // it pans instead, and the pan range is exactly one keyboard tall. No
  // height or overflow on html/body can remove that slack; only a gesture
  // can stop a gesture. One non-passive touchmove on document
  // preventDefaults a northward drag ONLY when no inner scroller can
  // consume it. Southward, horizontal, multi-touch and open selections
  // always pass, so bounce, pull-to-refresh and the magnifier stay native.
  // Armed only where the page actually pans (measured above, not
  // UA-sniffed), so Chrome keeps its scroll fast path.
  let gateArmed = false;
  let gateTouching = false;
  let gateMulti = false;
  let gateStartY = 0;
  /** @type {Element | null} */
  let gateScroller = null;

  /**
   * The nearest scrollable ancestor of `node`, or null. The transcript is
   * the only scroller on the page, but the walk stays generic so a drag
   * that starts on any future element is classified the same way.
   * @param {EventTarget | null} node
   * @returns {Element | null}
   */
  function scrollerUnder(node) {
    for (
      let n = /** @type {Element | null} */ (node);
      n && n !== document.body && n !== document.documentElement;
      n = n.parentElement
    ) {
      const overflowY = getComputedStyle(n).overflowY;
      if (
        overflowY === "auto" ||
        overflowY === "scroll" ||
        overflowY === "overlay"
      ) {
        return n;
      }
    }
    return null;
  }

  /**
   * Flatten a scroller to the plain numbers the gate decision consumes.
   * @param {Element} el
   */
  function describeScroller(el) {
    const editable = el.tagName === "TEXTAREA" || el.tagName === "INPUT";
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      editable,
      value: editable ? /** @type {HTMLInputElement} */ (el).value : "",
    };
  }

  /** @param {TouchEvent} event */
  function onGateStart(event) {
    gateTouching = true;
    gateMulti = event.touches.length !== 1;
    if (gateMulti) return;
    gateStartY = event.touches[0].clientY;
    gateScroller = scrollerUnder(event.target);
    // The transcript is a JS-driven scroller (overflow hidden), invisible
    // to the overflow walk above -- but the gate's room check must still
    // see it, or every northward drag over the transcript would be treated
    // as a page pan to block (blue29).
    const target = /** @type {Node | null} */ (event.target);
    if (!gateScroller && target && screen.contains(target)) {
      gateScroller = screen;
    }
  }

  /** @param {TouchEvent} event */
  function onGateMove(event) {
    if (gateMulti || event.touches.length !== 1) return;
    const selection = window.getSelection();
    if (
      document.activeElement === field &&
      field.selectionStart !== field.selectionEnd
    ) {
      return; // a selection drag inside the field stays native
    }
    if (
      shouldBlockNorthDrag({
        deltaY: event.touches[0].clientY - gateStartY,
        multiTouch: false,
        selectionCollapsed: !selection || selection.isCollapsed,
        scroller: gateScroller && describeScroller(gateScroller),
      })
    ) {
      event.preventDefault(); // no chaining, no page pan
    }
  }

  function onGateEnd() {
    gateTouching = false;
    gateMulti = false;
    gateScroller = null;
    // Momentum out of a scroller outlives the finger; if it chained north
    // anyway, the scroll pin cleans up once it is spent.
    setTimeout(pinScroll, 150);
  }

  function armGate() {
    if (gateArmed || keyboardMode !== "pan") return;
    gateArmed = true;
    document.addEventListener("touchstart", onGateStart, { passive: true });
    document.addEventListener("touchmove", onGateMove, { passive: false });
    document.addEventListener("touchend", onGateEnd, { passive: true });
    document.addEventListener("touchcancel", onGateEnd, { passive: true });
  }

  // Residual page scroll (the one-pixel pull-to-refresh token spent
  // northward, a focus nudge Chrome applies when the keyboard opens on
  // Android, or momentum that chained): reset it once things are quiet, so
  // the slack is never left holding the page -- on Android that leftover
  // offset is what shifts the fixed column (and can hide the toolbar) when
  // the keyboard opens. iOS is covered via the armed gate; Android never
  // arms it (resize mode), so the fixed-shell layout gates instead. Desktop
  // and touch laptops keep a real scroll range and are excluded. Never
  // while a finger is down, never mid-transition -- that fight was
  // blue17's oscillation.
  function pinScroll() {
    if (
      (!gateArmed && !usesFixedShell.matches) ||
      gateTouching ||
      window.scrollY <= 0
    )
      return;
    // iOS only: never mid-transition -- resetting the page while the inset
    // animation runs fed back into the measurement and oscillated
    // (blue17). Android (resize mode, gate never armed) drives no inset
    // animation, so the pin applies immediately: that keeps a focus nudge
    // from lingering long enough to hide the toolbar and shift the whole
    // column upward on keyboard open. The reset itself cannot loop: once
    // scrollY is back at 0 there is no further scroll event, and
    // visualViewport handlers ignore frames inside the transition window
    // anyway.
    if (gateArmed && performance.now() < busyUntil + 260) return;
    window.scrollTo(0, 0);
  }
  window.addEventListener("scroll", pinScroll, { passive: true });

  // ================= the transcript driver (blue29/30) =================
  // Inside the touch shell the transcript is NOT a native scroller:
  // #screen is overflow:hidden there, so it cannot rubber-band, cannot
  // chain, and has no overscroll physics of any kind -- no matter where a
  // gesture starts (WebKit decides a gesture's overscroll up front, so
  // overscroll-behavior could not cover a drag that ARRIVES at an edge
  // mid-gesture; blue26-28 shipped the evidence). All log movement is
  // driven here, clamped and pixel-rounded on every write: the ends are
  // hard BY CONSTRUCTION. Momentum after a flick is emulated (native
  // momentum needs a scroller; this has none). Outside the shell (desktop,
  // touch laptops) the transcript is a native scroller again and the
  // driver stands aside entirely -- see the touchmove/wheel gates below --
  // so the browser scrolls and chains by itself. (Android inside the shell
  // is native as well: see androidLike above.) One writer per platform:
  // driving over a native scroller fought the scrolling thread and left
  // the page nervous.
  //
  // A southward drag that finds the log at its top is nobody's scroll: the
  // driver never preventDefaults those moves, so the document -- sitting
  // at scroll 0 -- runs the browser's OWN pull-to-refresh, keyboard open
  // or closed. A pull that arrives at the top mid-gesture keeps driving
  // the hard 0 through a small dead zone, then hands the gesture to the
  // page and LATCHES the hand-off: no re-driving that gesture, so the
  // page pull can never fight the log again. On iOS, which locks a touch
  // to its first scroll owner, such a pull stops dead -- abruptly, with
  // no stretch; the next touch from the top is a full native pull. That
  // abrupt stop is the accepted worst case.
  let logTouch = false;
  let logY0 = 0;
  let logTop0 = 0;
  let logDriven = false; // this gesture drove the log (a flick is possible)
  let logHandOff = false; // top arrival latched: the page owns the gesture
  let logMomentumRaf = 0;
  let logVelocity = 0;
  let logMomentumT0 = 0;
  /** @type {Array<{ t: number, st: number }>} */
  const logSamples = [];

  function logRoom() {
    return screen.scrollHeight - screen.clientHeight;
  }

  function logStopMomentum() {
    if (logMomentumRaf) cancelAnimationFrame(logMomentumRaf);
    logMomentumRaf = 0;
    logVelocity = 0;
  }

  /**
   * @param {number} now rAF timestamp
   */
  function logMomentumStep(now) {
    logMomentumRaf = 0;
    const step = momentumStep({
      scrollTop: screen.scrollTop,
      velocity: logVelocity,
      dtMs: now - logMomentumT0,
      room: logRoom(),
    });
    logMomentumT0 = now;
    logVelocity = step.velocity;
    screen.scrollTop = step.scrollTop;
    if (step.running) logMomentumRaf = requestAnimationFrame(logMomentumStep);
  }

  function logRelease() {
    const velocity = flickVelocity(logSamples);
    if (velocity === 0) return;
    logVelocity = velocity;
    logMomentumT0 = performance.now();
    logMomentumRaf = requestAnimationFrame(logMomentumStep);
  }

  function logGestureEnd() {
    if (logTouch && logDriven && !logHandOff) logRelease();
    logTouch = false;
    logDriven = false;
    logHandOff = false;
    logSamples.length = 0;
  }

  screen.addEventListener(
    "touchstart",
    (e) => {
      logStopMomentum();
      logTouch = e.touches.length === 1;
      if (!logTouch) return;
      logY0 = e.touches[0].clientY;
      logTop0 = Math.round(screen.scrollTop);
      logDriven = false;
      logHandOff = false;
      logSamples.length = 0;
    },
    { passive: true },
  );

  screen.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 1) {
        // Pinch or a second finger: hands off; the page can have it.
        logTouch = false;
        logDriven = false;
        logHandOff = false;
        logStopMomentum();
        return;
      }
      if (!logTouch) return;
      // Off the touch shell the transcript scrolls natively and chains to
      // the page by itself: stand aside so the browser runs the gesture
      // instead of driving over it.
      if (!usesFixedShell.matches) return;
      // Android inside the shell is native too (see androidLike above): a
      // preventDefault here would only race the compositor -- and losing
      // that race is what actuated pull-to-refresh mid-log. Still release
      // the keyboard glue: the user took the transcript over.
      if (androidLike) {
        pinnedToBottom = false;
        return;
      }
      const dy = e.touches[0].clientY - logY0;
      const selection = window.getSelection();
      const room = logRoom();
      const move = decideLogMove({
        dy,
        top0: logTop0,
        room,
        handOff: logHandOff,
        selectionCollapsed: !selection || selection.isCollapsed,
      });
      if (move.action === "page") return;
      e.preventDefault(); // the log consumes this move; the page must not
      if (move.action === "top") {
        screen.scrollTop = 0;
        pinnedToBottom = false; // the user scrolled: release the keyboard glue
        if (move.latch) logHandOff = true;
        return;
      }
      const target = drivenScrollTop({ top0: logTop0, dy, room });
      logDriven = true;
      pinnedToBottom = false; // the user scrolled: release the keyboard glue
      screen.scrollTop = target;
      logSamples.push({ t: performance.now(), st: target });
      if (logSamples.length > 4) logSamples.shift();
    },
    { passive: false },
  );

  screen.addEventListener("touchend", logGestureEnd, { passive: true });
  screen.addEventListener("touchcancel", logGestureEnd, { passive: true });

  // Desktop and touch laptops: the transcript is a native scroller (see
  // the base #screen rule), so wheel gestures scroll it natively and a
  // spent end chains to the outer page by itself. The driver below runs
  // only inside the touch shell, where the transcript is not a scroller
  // and every write is emulated. No scrollBy inside the handler: on
  // Safari, programmatic page scroll during active wheel momentum fights
  // the scrolling thread and the page wiggles. Line/page delta modes are
  // converted to pixels (decideLogWheel).
  screen.addEventListener(
    "wheel",
    (e) => {
      if (!usesFixedShell.matches) return; // native scroll + native chain
      const room = logRoom();
      if (room <= 1) return; // short log: the wheel belongs to the page
      const move = decideLogWheel({
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        scrollTop: screen.scrollTop,
        room,
        pageHeight: window.innerHeight,
      });
      pinnedToBottom = false; // the user scrolled: release the keyboard glue
      screen.scrollTop = move.scrollTop;
      if (move.prevent) e.preventDefault(); // the log consumed it all
    },
    { passive: false },
  );

  /**
   * The engine stopped asking for input (error, exit, startup failure):
   * drop the wait and repaint, keeping the transcript as it is. The field
   * keeps its text; the next beginInput clears it.
   */
  function endInput() {
    waitingForInput = false;
    render();
  }

  function flushOutputRender() {
    outputRenderer.flush();
  }

  function cancelOutputRender() {
    outputRenderer.cancel();
  }

  // --- public shell API ---------------------------------------------------------

  return {
    appendOutput,
    beginInput() {
      currentInput = "";
      field.value = "";
      waitingForInput = true;
      flushOutputRender();
      focusTerminalInput(); // Focus the command field; a tap opens the keyboard on mobile
    },
    reset(banner = "") {
      outputRenderer.cancel();
      terminalText = banner;
      hasReceivedFirstOutput = false;
      currentInput = "";
      field.value = "";
      waitingForInput = false;
      pendingInputSeparator = false;
      render();
      screen.scrollTop = 0;
    },
    endInput,
    flushOutputRender,
    cancelOutputRender,
    focusInput(options) {
      focusTerminalInput(options);
    },
    isWaitingForInput() {
      return waitingForInput;
    },
  };
}
