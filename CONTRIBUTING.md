# Contributing to PTZ CTRL

Thanks for taking a look. Bug reports, camera compatibility reports and pull
requests are all welcome.

## Reporting bugs

Open an [issue](https://github.com/Kryptographer/ptzctrl/issues) and include:

- Your OS, and the camera make/model plus the protocol and port you're using.
- What you did, what you expected, and what happened instead.
- The status line text from the bottom of the app, if it said anything.

Camera compatibility reports are genuinely useful — "brand X answers VISCA on
TCP 5678 but not UDP 1259" is worth an issue on its own.

## Development setup

Requires [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
npm start     # launch the app
npm test      # headless test suite — no Electron, no camera needed
```

`npm test` runs two plain Node scripts:

- `test/run-control-tests.js` — the control path: VISCA command pacing and
  coalescing, stop repeats, and the post-preset drive hold-off.
- `test/run-tests.js` — the tracker math against the OpenCV reference, the
  tracking stability layer under closed-loop simulation, and an end-to-end run
  of the real bundled model.

Both must pass before a pull request can be merged; CI runs them on Linux,
macOS and Windows.

## Working on the code

[`docs/architecture.md`](docs/architecture.md) explains the layout: main
process (VISCA transports, discovery, streams, native controller reads),
preload bridge, and renderer (UI, gamepad engine, tracker).

A few conventions worth matching:

- **Comments explain *why*.** The tricky parts of this codebase — command
  pacing, stop guarantees, deadzone hysteresis, the tracking gate — are all
  built around specific hardware behaviour. Say what the hardware does, not
  what the line does.
- **Nothing in the drive path may become chatty.** Continuous updates are
  coalesced, and stops are guaranteed on the wire. If you touch `visca.js`,
  `drivekeeper.js` or `gamepad.js`, add a control test for the behaviour you
  are changing.
- **Keep the UI keyboard-operable and screen-reader-legible.** New controls
  need real semantics (roles, labels, pressed/selected state) and must not use
  colour as the only cue.
- **No new runtime dependencies** unless there's no reasonable alternative —
  the app ships as an installer and every dependency lands in it.

## Pull requests

- One focused change per pull request, with a description of what it does and
  how you tested it — including which camera, if that's relevant.
- Run `npm test` first.
- Use plain, descriptive commit messages in the imperative mood ("Fix the
  bounce when recalling a camera preset").

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
