# pi-python

Run Python 3 in [pi](https://github.com/earendil-works/pi), with streaming foreground execution and persistent background jobs.

## Why pi-python

- **One compact tool** — execute code and manage jobs through a flat `python` schema.
- **Streaming execution** — foreground output appears while Python is running, with timeout and cancellation support.
- **Persistent jobs** — long-running programs survive later tool calls, `/reload`, and pi restarts.
- **Quiet notifications** — job completion is reported automatically; `notifyOn` can report a one-time readiness match.
- **Incremental output** — job reads return only output produced since the previous read.
- **Python-aware runtime** — Python 3 is validated once and reused with UTF-8 and unbuffered defaults.

## Usage

Run code in the foreground:

```json
{ "code": "print(sum(range(100)))" }
```

Use `background` for servers, watchers, and other long-running programs:

```json
{
  "code": "from http.server import test\ntest(port=8000)",
  "background": true,
  "notifyOn": "Serving HTTP on"
}
```

The result contains a `jobId`. Read new output, wait briefly for progress, or stop the active process tree:

```json
{ "jobId": "py-1234abcd", "wait": 10 }
```

```json
{ "jobId": "py-1234abcd", "stop": true }
```

Completion notifications do not consume job output. Keep the root Python process alive for the lifetime of a background job; descendants that outlive it are outside the job lifecycle.

Tool calls use Python syntax highlighting. Results show execution time or job status, and the editor displays the number of running jobs in the current session.

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
| `executable` | `"auto"` | Tries `python3` and then `python`. Set an absolute path to select a specific Python 3 executable. |
| `utf8` | `true` | Defaults `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1` unless already set. |
| `unbuffered` | `true` | Defaults `PYTHONUNBUFFERED=1` and runs Python with `-u`. |

Environment variables override the JSON file:

| Environment variable | Setting |
| --- | --- |
| `PI_PYTHON_CONFIG` | Alternate configuration file path |
| `PI_PYTHON_EXECUTABLE` | `executable` |
| `PI_PYTHON_UTF8` | `utf8` |
| `PI_PYTHON_UNBUFFERED` | `unbuffered` |

Boolean environment values accept `true`/`false`, `1`/`0`, `yes`/`no`, and `on`/`off`. Configuration is strict: unknown fields, invalid values, and unavailable configured executables are reported instead of being ignored.

## Requirements

- Node.js 22.19 or newer.
- Python 3 available through `PATH` or an absolute `executable` path.

## Installation

```bash
pi install npm:@4fu/pi-python
```

Try it without installing:

```bash
pi -e npm:@4fu/pi-python
```

### From source

Run `npm install`, add the repository path to `~/.pi/agent/settings.json`, then run `/reload` in pi.

## Development

```bash
npm install
npm test
```

## License

MIT
