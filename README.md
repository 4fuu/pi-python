# pi-python

[![Latest release](https://img.shields.io/github/v/release/4fuu/pi-python)](https://github.com/4fuu/pi-python/releases/latest)

Run Python 3 in [pi](https://github.com/earendil-works/pi) as durable, observable tasks with low-noise readiness and completion notifications.

## Why pi-python

Python is often the clearest tool for data transformation, structured inspection, calculations, and small automation tasks. `pi-python` gives the model a purpose-built execution surface without mixing Python source into shell quoting.

- **Python-native input** — the model sends Python 3 source directly, with syntax-aware TUI rendering.
- **One narrow task interface** — source starts durable work; the returned `taskId` is the only handle needed to inspect, wait for, or stop it.
- **Persistent by default** — every invocation survives later tool calls, `/reload`, pi restarts, wait timeouts, and tool aborts.
- **Quiet automatic notifications** — completion and optional literal readiness arrive without polling or another model-facing tool.
- **Repeatable snapshots** — queries return current status and bounded latest output without consuming the log.
- **Process-tree cleanup** — only an explicit stop terminates the Python task and its descendants.
- **Session ownership** — a task can be controlled only by the parent session that launched it.
- **Strict, optional configuration** — executable selection and UTF-8 behavior stay outside the base prompt.

This keeps the schema and guidance compact: pi sees one `python` tool and one consistent task lifecycle rather than separate foreground, background, and job APIs.

## Features

### Persistent Python tasks

Talk to pi normally—the `python` tool is designed for the model rather than as a command you invoke yourself:

> **You:** Compute the first 200 prime numbers and keep working on the report while that runs.
>
> **pi:** starts the computation as a persistent Python task, receives `py_…`, and continues editing the report.
>
> **Notification:** the Python task completed.
>
> **pi:** retrieves the final snapshot and incorporates the result.

Every Python invocation creates a persistent task and returns immediately unless the current turn explicitly needs to wait. Waiting can end at completion or at an optional case-sensitive readiness phrase, including one split across output chunks; a timeout or cancelled wait never stops the program.

The returned task ID lets the model inspect the latest snapshot, wait again, or explicitly terminate the complete process tree. Snapshots are bounded and repeatable rather than consumable. Task IDs belong to the parent session that launched them. Active tasks recover across `/reload` and pi restarts, and terminal records are retained for 24 hours.

### Task notifications and TUI

Readiness, completion, failure, and cancellation are reported automatically. Notification state is durable and deduplicated. If the model has already retrieved complete terminal output, a later notification is reduced to compact status instead of repeating the payload.

Tool rows preserve Python syntax highlighting, ANSI-safe output previews, duration, and expandable details. The dedicated **Python Tasks** widget shows up to three active tasks with status, duration, and source preview.

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
