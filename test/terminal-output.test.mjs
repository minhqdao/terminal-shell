// Unit tests for the transcript text policy (src/terminal-output.js):
// sanitizeTerminalOutput strips control characters browsers render as
// placeholder glyphs, and stripLineLeadingSpace aligns FORTRAN's leading
// blank with user input at column 0 while preserving deeper indentation.
//
//   node --test test/terminal-output.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeTerminalOutput,
  stripLineLeadingSpace,
} from "../src/terminal-output.js";

test("sanitizeTerminalOutput strips terminal bells", () => {
  assert.equal(sanitizeTerminalOutput("LOOK\n"), "LOOK\n");
  assert.equal(sanitizeTerminalOutput("a\u0007b"), "ab");
  assert.equal(sanitizeTerminalOutput("\u0007\u0007"), "");
  assert.equal(sanitizeTerminalOutput(""), "");
});

test("stripLineLeadingSpace strips one leading space at a line start", () => {
  assert.equal(stripLineLeadingSpace(" YOU ARE HERE", true), "YOU ARE HERE");
  assert.equal(stripLineLeadingSpace(" YOU ARE HERE", false), " YOU ARE HERE");
  assert.equal(stripLineLeadingSpace("YOU ARE HERE", true), "YOU ARE HERE");
});

test("stripLineLeadingSpace always strips after a newline", () => {
  assert.equal(
    stripLineLeadingSpace("YOU ARE HERE\n IN A MAZE", false),
    "YOU ARE HERE\nIN A MAZE",
  );
});

test("stripLineLeadingSpace preserves deeper indentation", () => {
  assert.equal(stripLineLeadingSpace("   10 SCORE", true), "  10 SCORE");
  assert.equal(stripLineLeadingSpace("", true), "");
});
