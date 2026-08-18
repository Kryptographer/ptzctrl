# Security

## Scope

PTZ CTRL is a desktop app that talks to cameras on your local network. It has
no cloud service and no account system. The parts worth reporting against are:

- The VISCA transports and the local MJPEG relay (`src/main/`).
- The Electron shell — the preload bridge and the renderer's content security
  policy.
- The AI tracker, which runs entirely on-device.

Camera credentials you enter in stream URLs are stored in the app's local
config file (`ptzctrl-config.json` in the Electron userData directory) in plain
text, along with the camera list and settings. Treat that file as sensitive.
Credentials are stripped from stream errors shown in the app, so those are safe
to paste into a bug report.

## Reporting a vulnerability

Please report privately through GitHub's
[security advisory form](https://github.com/Kryptographer/ptzctrl/security/advisories/new)
rather than opening a public issue. Include what you found, how to reproduce
it, and what an attacker could do with it.

Expect an acknowledgement within a few days. Once a fix is available it will
land in a release and the advisory will be published with credit, unless you
would rather stay anonymous.

## Supported versions

Fixes go into the latest version on the default branch. There are no
long-term-support branches.
