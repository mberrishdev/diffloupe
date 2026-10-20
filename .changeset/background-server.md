---
'diffloupe': minor
---

Run diffloupe as a background server at a fixed URL (`http://127.0.0.1:4747`). `diffloupe` now adds the current repository to the running server (starting it if needed), opens the browser and returns your terminal straight away, so every repo you review is in one session. New commands: `start`, `stop`, `restart` and `status`, plus `service install` / `service uninstall` to start the server at login (LaunchAgent on macOS, systemd user service on Linux). Git diff arguments, `--host` and the new `--foreground` flag still run a separate server in the terminal. The background server shuts down idle language servers after 30 minutes.
