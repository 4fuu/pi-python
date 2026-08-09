# pi-python

Run Python 3 in [pi](https://github.com/earendil-works/pi) as durable, observable tasks. Every invocation starts in the background; tasks survive tool calls, `/reload`, and pi restarts.

## Installation

```bash
pi install npm:@4fu/pi-python
```

Try without installing with `pi -e npm:@4fu/pi-python`. From source, run `npm install`, add this repository to `~/.pi/agent/settings.json`, and `/reload`.

## Usage

Talk to pi normally—the `python` tool is for the model. A typical interaction looks like this:

> **You:** Compute the first 200 prime numbers and keep working on the report while that runs.
>
> **pi:** starts `python({"code":"..."})`, receives `py_…`, and continues independent work instead of polling.
>
> **Notification:** `py_… completed`
>
> **pi:** uses the result in the report.

When the current turn needs a short computation immediately, the model can wait on the same persistent task:

```json
{"code":"print(sum(range(100)))","wait":10}
```

For a service, `notifyOn` is a literal readiness match, including across output chunks. Readiness is reported once and does not complete the task:

```json
{"code":"from http.server import test\ntest(port=8000)","notifyOn":"Serving HTTP on","wait":30}
```

Inspect or long-poll an existing task, or explicitly stop its process tree:

```json
{ "taskId": "py_1234abcd" }
{ "taskId": "py_1234abcd", "wait": 10 }
{ "taskId": "py_1234abcd", "stop": true }
```

## Parameters and lifecycle

Exactly one of `code` or `taskId` is required.

| Parameter | Calls | Meaning |
| --- | --- | --- |
| `code` | start | Non-empty Python 3 source. Always creates a persistent task. |
| `taskId` | query | Identifier returned by a start call. |
| `wait` | both | `0..300` seconds. Both start and query wait for readiness when `notifyOn` is present, otherwise terminal state. Timeout only ends the wait. |
| `notifyOn` | start | Literal of 1..256 UTF-8 bytes. It matches across chunks and notifies at most once. |
| `stop` | query | The only operation that terminates the task process tree. |

Public states are `starting`, `running`, `completed`, `failed`, and `cancelled`. Task IDs are restricted to the parent session that launched them. Queries are idempotent snapshots: repeated reads return current metadata and the bounded latest 50KB, rather than consuming unread output. Tool cancellation only cancels a wait after task creation. Completion, failure, cancellation, and readiness notifications are persisted and deduplicated; explicit retrieval of a terminal result suppresses duplicate final output while preserving UI state. Active tasks are recovered after reload/restart.

The TUI keeps Python syntax highlighting, ANSI-safe output previews, expansion, and duration. Calls and results consistently use `taskId`; the Python Tasks widget shows up to three active task/status/duration/source-preview rows.

### Migration from 0.3

Version 0.4 is intentionally breaking: remove `background` and `timeout`, replace every `jobId` with `taskId`, and expect every `code` call to persist. Replace incremental/unread-output logic with repeatable snapshot queries. Replace the old `stopped` state with `cancelled`; use `wait` for both start and query behavior.

## Configuration

Optional `~/.pi/agent/python.json`:

```json
{ "executable": "auto", "utf8": true, "unbuffered": true }
```

`executable` tries `python3` then `python`, or accepts an absolute Python 3 path. `utf8` defaults `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`; `unbuffered` defaults `PYTHONUNBUFFERED=1` and uses `-u`. Existing environment values win. Environment overrides are `PI_PYTHON_CONFIG`, `PI_PYTHON_EXECUTABLE`, `PI_PYTHON_UTF8`, and `PI_PYTHON_UNBUFFERED`.

Requires Node.js 22.19+ and Python 3.

## Development

```bash
npm install
npm test
npm pack --dry-run
```

MIT licensed.
