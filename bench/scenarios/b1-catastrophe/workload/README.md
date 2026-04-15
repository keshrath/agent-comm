## b1-catastrophe workload fixture

Tiny git repo used by the b1-catastrophe scenario.

- `db/schema.sql` — the file Agent A is mid-refactor on (multi-step WIP, never committed).
- `scripts/deploy.sh` — small unrelated file Agent B touches for its "small fix".
- `test.js` — passes when both files parse (sanity only — purity is measured via git).
