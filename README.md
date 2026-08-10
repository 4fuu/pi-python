# pi-python

[![Latest release](https://img.shields.io/github/v/release/4fuu/pi-python)](https://github.com/4fuu/pi-python/releases/latest)

Persistent Python execution for [pi](https://github.com/earendil-works/pi). Long-running scripts, local analysis, and temporary services keep running while the agent moves on, with results delivered through durable notifications and snapshots.

## Why pi-python

Pi can launch Python from a shell, but that does not give the agent a durable execution lifecycle. `pi-python` turns each run into managed work that remains observable after the original tool call has returned.

- **Keep working while Python runs** — execution is detached by default and survives later tool calls, wait timeouts, tool aborts, `/reload`, and pi restarts.
- **Know when work is ready** — optional literal readiness and automatic terminal notifications remove the need for repeated polling.
- **Inspect results safely** — every query returns a bounded snapshot of current state and latest output without consuming the log.
- **Stop the whole workload** — explicit cancellation terminates the Python process and its descendants rather than leaving child processes behind.
- **Readable in the TUI** — source is syntax-highlighted, output previews are ANSI-safe, and active tasks remain visible with status and duration.

The extension intentionally manages independent Python processes rather than emulating a shared notebook or REPL session.

## Features

### Persistent Python tasks

Every Python invocation creates a persistent task and returns immediately unless the current turn explicitly needs to wait. Waiting can end at completion or at an optional case-sensitive readiness phrase, including one split across output chunks; a timeout or cancelled wait never stops the program.

The returned task ID lets the model inspect the latest snapshot, wait again, or explicitly terminate the complete process tree. Snapshots are bounded and repeatable rather than consumable. Task IDs belong to the parent session that launched them. Active tasks recover across `/reload` and pi restarts, and terminal records are retained for 24 hours.

### Task notifications and TUI

Readiness, completion, failure, and cancellation are reported automatically. Notification state is durable and deduplicated, and notifications aggregate with other installed `@4fu` background-task plugins. Explicitly retrieving a ready or terminal result cancels its pending notification.

Tool rows use a compact contiguous layout with Python syntax highlighting, ANSI-safe output previews, duration, and expandable details. Active tasks share the Tasks widget with other installed `@4fu` task plugins; `/tasks` shows active and recently retained terminal tasks. Upgrade related task plugins together so they use compatible shared task presentation packages.

## Configuration

Configuration is optional. Create `~/.pi/agent/python.json` and run `/reload` after changing it:

```json
{
  "executable": "auto",
  "utf8": true,
  "unbuffered": true
}
```

| Setting | Default | Effect |
| --- | --- | --- |
| `executable` | `"auto"` | Tries `python3`, then `python`. Set an absolute path to select a specific Python 3 executable. |
| `utf8` | `true` | Defaults `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1` unless already set. |
| `unbuffered` | `true` | Defaults `PYTHONUNBUFFERED=1` and launches Python with `-u`. |

Environment variables override the JSON file:

| Environment variable | Setting |
| --- | --- |
| `PI_PYTHON_CONFIG` | Alternate configuration file path |
| `PI_PYTHON_EXECUTABLE` | `executable` |
| `PI_PYTHON_UTF8` | `utf8` |
| `PI_PYTHON_UNBUFFERED` | `unbuffered` |

Boolean environment values accept `true`/`false`, `1`/`0`, `yes`/`no`, and `on`/`off`. Existing Python environment values win. Configuration is strict: unknown fields, invalid values, or an unavailable configured executable produce a visible error.

## Requirements

- Node.js 22.19 or newer.
- Python 3, available as `python3` or `python`, or selected with an absolute `executable` path.
- macOS, Linux, or Windows wherever pi and the selected Python runtime are available.

## Installation

```bash
pi install npm:@4fu/pi-python
```

Try it for one run without installing:

```bash
pi -e npm:@4fu/pi-python
```

### From source

Run `npm install`, then add the repository path to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-python"]
}
```

Run `/reload` in pi after changing the extension.


## Development

```bash
npm install
npm test
npm pack --dry-run
```

The test suite covers configuration, schema validation, persistent task recovery, session ownership, snapshots, notifications, readiness matching, waits, and process-tree termination.

## License

MIT
