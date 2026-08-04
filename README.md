# pi-python

Execute Python 3 code in [pi](https://github.com/earendil-works/pi), with foreground streaming and persistent background jobs.

## Tool usage

Run code in the foreground:

```json
{ "code": "print(sum(range(100)))" }
```

Start a long-running job:

```json
{ "code": "import time\nwhile True:\n    print('tick', flush=True)\n    time.sleep(1)", "background": true }
```

The result includes a `jobId`. Use it to read only the output produced since the previous read, optionally waiting briefly for progress:

```json
{ "jobId": "py-1234abcd", "wait": 10 }
```

Stop the job and its process tree:

```json
{ "jobId": "py-1234abcd", "stop": true }
```

Background jobs are supervised by detached Node processes and store their state and logs under the system temporary directory. They survive independent tool calls, `/reload`, and pi restarts. Finished records become eligible for opportunistic cleanup after 24 hours.

## Requirements

- Node.js 22.19 or newer
- Python 3 available as `python3` or `python` on Unix, or `python` or `py -3` on Windows

## Installation

```bash
pi install npm:@4fu/pi-python
```

From source, add this repository path to `~/.pi/agent/settings.json`, then run `npm install` and `/reload`.

## Development

```bash
npm install
npm run typecheck
npm test
```
