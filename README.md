# terminal-shell

[![CI](https://github.com/minhqdao/terminal-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/minhqdao/terminal-shell/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/terminal-shell)](https://www.npmjs.com/package/terminal-shell)
[![license](https://img.shields.io/npm/l/terminal-shell)](./LICENSE)

A small, dependency-free browser terminal for
[colossal-cave-wasm](https://github.com/minhqdao/colossal-cave-wasm),
[oregon-fortran-wasm](https://github.com/minhqdao/oregon-fortran-wasm), and
[Basicade](https://github.com/minhqdao/Basicade).

It provides the terminal UI and the protocol used to connect it to a
game or interpreter. Browser-specific behavior lives here so the
launchers don't have to duplicate it.

## Install

```sh
npm install terminal-shell
```

## Usage

Create a shell by providing the elements it controls and callbacks for
the engine:

```js
import { createTerminalShell } from "terminal-shell";

const shell = createTerminalShell({
  screen,
  output,
  inputLine,
  cursor,
  field,
  container,
  insetTarget,

  onLine(line) {
    // Pass the line to the engine.
  },

  onFirstOutput() {
    // Engine produced its first output.
  },
});
```

The shell handles input, IME composition, command echoing, scrolling,
focus, and the mobile keyboard.

The main methods are:

- `appendOutput(text)`
- `beginInput()`
- `reset(banner)`
- `focusInput({ force })`
- `isWaitingForInput()`

See `src/index.js` for the full API and available options.

## Runner protocol

`terminal-shell/protocol` defines the messages exchanged between the
page and engine worker:

- `INIT` — load the engine
- `START` — start a program
- `READY`, `STARTED`, `STDOUT`, `REQUEST_INPUT`, `ERROR`, `EXIT`

`terminal-shell/runner-worker` provides the worker for Emscripten-built
engines. Interpreters can implement their own worker while using the
same protocol.

The protocol also provides the shared input buffer used to pass one
submitted line to the engine.

## Demo

`demo/` is a minimal integration using an echo engine:

```sh
npm run dev
```

Run `npm run dev`, then open the printed URL (it redirects straight
to the demo) and try typing a command. The server runs at the
repository root because the demo imports from `../src/`.

## Development

```sh
npm run all
```

This runs formatting, linting, type checking, and tests.
