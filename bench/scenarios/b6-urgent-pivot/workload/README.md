# B6 workload — urgent-pivot fixture

Log files used so Session A has real-ish work to chew on between inbox polls
(with-channels) or `.STOP` file stats (no-channels).

Files:

- `logs/app-2026-04-15.log` — app server, current day
- `logs/app-2026-04-14.log` — app server, previous day
- `logs/auth.log` — auth events (includes a brute-force block)
- `logs/db.log` — db pool + slow query + deadlock

The bench does not depend on exact contents; it only needs the files to exist
so Session A produces enough tool calls (one Read per file, plus the
intermediate poll/stat after each) for the harness's mid-flight STOP to
arrive while the agent still has work in progress.
