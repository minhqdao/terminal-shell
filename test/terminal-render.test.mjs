// Unit tests for the frame batcher (src/terminal-render.js): bursts of
// terminal output schedule a single browser paint, while input prompts
// flush pending output immediately. Uses a controllable frame pair, so no
// browser is needed.
//
//   node --test test/terminal-render.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { createFrameBatcher } from "../src/terminal-render.js";

function fakeFrames() {
  let nextFrame = 1;
  let renderCount = 0;
  const pendingFrames = new Map();
  const batcher = createFrameBatcher(() => renderCount++, {
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
  return {
    batcher,
    pendingFrames,
    renderCount: () => renderCount,
    paint() {
      pendingFrames.values().next().value();
    },
  };
}

test("a burst of schedules paints only once", () => {
  const frames = fakeFrames();
  frames.batcher.schedule();
  frames.batcher.schedule();
  frames.batcher.schedule();
  assert.equal(
    frames.pendingFrames.size,
    1,
    "a burst of terminal output schedules only one browser paint",
  );
  frames.paint();
  assert.equal(
    frames.renderCount(),
    1,
    "a terminal output burst renders only once",
  );
});

test("flush runs immediately and cancels the pending paint", () => {
  const frames = fakeFrames();
  frames.batcher.schedule();
  frames.batcher.flush();
  assert.equal(
    frames.renderCount(),
    1,
    "an input prompt flushes pending output immediately",
  );
  assert.equal(
    frames.pendingFrames.size,
    0,
    "flushing cancels the pending browser paint",
  );
});

test("cancel drops the pending paint without running it", () => {
  const frames = fakeFrames();
  frames.batcher.schedule();
  frames.batcher.cancel();
  assert.equal(
    frames.pendingFrames.size,
    0,
    "restarting cancels stale terminal output",
  );
  assert.equal(
    frames.renderCount(),
    0,
    "canceling pending output does not render it",
  );
});

test("schedule re-arms after a flush", () => {
  const frames = fakeFrames();
  frames.batcher.schedule();
  frames.batcher.flush();
  frames.batcher.schedule();
  assert.equal(frames.pendingFrames.size, 1);
  frames.paint();
  assert.equal(frames.renderCount(), 2);
});
