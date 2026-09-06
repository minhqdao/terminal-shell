# terminal-shell

The single-source browser terminal behind the retro-game launchers —
[colossal-cave-wasm](https://github.com/minhqdao/colossal-cave-wasm),
[oregon-fortran-wasm](https://github.com/minhqdao/oregon-fortran-wasm), and
[Basicade](https://github.com/minhqdao/Basicade). Dependency-free ES
modules: append-only transcript output, a single-line command input that
respects IMEs, driven scrolling in the touch shell, and a
SharedArrayBuffer runner protocol between page, worker, and Emscripten
module.

Every browser-facing fix lands here once. The launchers keep only their
engine glue.

## Install

```
npm install terminal-shell
```

## The shell

`createTerminalShell(options)` owns everything the user touches. The host
supplies the DOM and the engine boundary:

```js
import { createTerminalShell } from "terminal-shell";

const shell = createTerminalShell({
  // --- DOM (host-owned, shell-driven) ---
  screen,      // transcript scroller
  output,      // element carrying the transcript text
  inputLine,   // element carrying the echoed command line
  cursor,      // the blinking caret element
  field,       // the hidden <input type="text"> the shell reads
  container,   // terminal box; tap-to-focus handlers attach here
  insetTarget, // element receiving --keyboard-inset (omit: driver stands down)

  // --- engine boundary ---
  onLine(line),          // submitted line, printable ASCII, trailing "\n";
                         // the host writes it into the keys buffer and
                         // arms its response watchdog
  onFirstOutput(),       // first engine output (and again after reset):
                         // disarm the boot guard here

  // --- policy, all optional ---
  normalizeLine,         // default: toEngineText (upper case, printable
                         // ASCII, accents resolved to base letters)
  maxInputLength,        // default: 254 (the protocol's keys buffer)
  keyboardHeightKey,     // default: KEYBOARD_HEIGHT_KEY (localStorage is
                         // per-origin; hosts sharing the default never collide)
  nativeLogDataset,      // e.g. "adventureLog": set to "native" on <html>
                         // under Android so the transcript scrolls natively
});
```

Shell methods:

- `appendOutput(text)` — engine output: sanitized, batched into one
  repaint per burst, separated from the user's line by a blank line.
- `beginInput()` — the engine asked for input: clears the field, focuses
  it (a tap opens the soft keyboard on mobile), repaints.
- `reset(banner)` — restart: transcript back to `banner`, first-output
  hook re-armed, in-flight line abandoned.
- `flushOutputRender()` / `cancelOutputRender()` — manual control over the
  pending batched repaint.
- `focusInput({ force })` / `isWaitingForInput()`.

Everything else — the IME contract, caret policy, echo, submit, scroll
driving, the soft-keyboard inset animation, the north-drag gate, focus
restore — is internal and identical across hosts.

### The command-line contract

The hidden field owns the text: the browser and its IME edit it, and the
shell only reads. Composed text REPLACES the character it accents, so the
field is hands-off under composition — no value writes, no caret moves —
or every update re-inserts the whole composition (`AÁASASS...`), and
stripping it deletes the base letter outright (the vanishing-character
bug). The text policy applies exactly once, at submit, so `a`+`s` on a
Telex keyboard shows Á and submits `A`, and `d`+`d` shows Đ and submits
`D`. Enter inside a composition (keyCode 229) commits it first.

## The runner protocol

`terminal-shell/protocol` is the message contract between the page and
the worker, plus the input-line buffer layout:

- `INIT { wasmUrl }` — the worker fetches the Emscripten glue.
- `START { buffer, keys }` — compiled module; or
  `START { source, filename, buffer, keys }` — interpreted program
  (Basicade): the worker writes `source` to `filename` in its virtual FS.
- Events: `READY`, `STARTED`, `STDOUT { text }`, `REQUEST_INPUT`,
  `ERROR { message }`, `EXIT`.
- `createKeysBuffer()` / `writeInputLine(view, line)` /
  `readInputLine(view)` — the keys buffer carries one submitted line at a
  time, `[0]` length, `[2..]` characters including the trailing newline.
  Lines are printable ASCII plus `"\n"`, at most `maxInputLength` (254)
  characters.

`terminal-shell/runner-worker` is the generic worker for a _compiled_
module: it bridges the Emscripten FS to the protocol (see
`emscripten-runner` for the stdin/stdout contract, testable without a
Worker). Interpreted programs need an interpreter worker (Basicade's),
which still imports this package's protocol.

Boot the worker the way the launchers do:

```js
const worker = new Worker(
  new URL("terminal-shell/src/runner-worker.js", import.meta.url),
  { type: "module" },
);
worker.postMessage({ type: "INIT", wasmUrl: gameGlueUrl });
worker.postMessage({ type: "START", buffer, keys });
```

## Migrating a host

The three launchers currently carry their own copies of this logic; the
migration is mechanical:

1. Delete the `web/terminal-*.js` / `demos/terminal-*.js` copies and the
   launcher's input-line, scroll, keyboard, and transcript sections.
2. Instantiate `createTerminalShell` with the existing element IDs and
   keep the launcher's worker lifecycle, isolation recovery, status, and
   restart as the host glue around `onLine` / `onFirstOutput` /
   `beginInput` / `reset`.
3. colossal-cave and oregon bundle with esbuild `--packages=external`;
   bare `terminal-shell` imports must be bundled instead (drop the flag —
   the sources have no other npm imports), and the build-id file list
   gains nothing (the package inlines into the same bundles).
4. Basicade imports the package through its workspace/Vite pipeline; its
   interpreter worker switches to the shared protocol module, whose
   `START` now covers both shapes.

The keyboard-height storage key changes to
`terminal-shell.keyboardHeight` on migration; each origin re-measures its
soft keyboard once (the first open after the switch).

## Development

```
npm run verify   # prettier + eslint + tsc (strict, checkJs) + node --test
```

The tests run in plain Node; the shell's DOM contract is covered through
jsdom, the runner bridging through a fake Emscripten module.
