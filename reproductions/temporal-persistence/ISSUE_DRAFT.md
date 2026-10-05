# SQLite persistence silently serializes Temporal values as `{}`, breaking hydration and subset queries

- [x] I've validated the bug against the latest version of DB packages

## Describe the bug

`@tanstack/db-sqlite-persistence-core` silently stores `Temporal.Instant` and
`Temporal.PlainDate` as `{}`. After reopening the SQLite database, the original
values and types are lost. This also affects nested values, row metadata,
collection metadata, and transaction replay payloads.

We encountered this in an Expo application persisting typed ontology records.
The reproduction uses the shared core with real SQLite on Node, so it requires
no application code or Expo setup.

## To reproduce

Reproduction branch: `codex/repro-temporal-persistence` in
[`robertf224/db`](https://github.com/robertf224/db).

```sh
git clone --branch codex/repro-temporal-persistence https://github.com/robertf224/db.git
cd db/reproductions/temporal-persistence
pnpm install --frozen-lockfile
pnpm test
```

Use Node 22.13 or newer. The reproduction writes two different dates using
`SQLiteCorePersistenceAdapter.applyCommittedTx`, closes and reopens the SQLite
file, then checks hydration, metadata, replay, and subset queries. The command
intentionally exits 1 because its assertions describe the expected behavior.

The persisted row JSON includes:

```json
{
  "instant": {},
  "plainDate": {},
  "nested": { "dates": [{}] }
}
```

For rows `early` (2026-01-02) and `late` (2026-01-03):

| Query                                               | Expected keys | Actual keys |
| --------------------------------------------------- | ------------- | ----------- |
| `plainDate = Temporal.PlainDate.from('2026-01-02')` | `['early']`   | `[]`        |
| `plainDate > Temporal.PlainDate.from('2026-01-02')` | `['late']`    | `[]`        |
| `ORDER BY plainDate ASC LIMIT 1`                    | `['early']`   | `['late']`  |

These results occur both without and with a persisted expression index installed.
The query failures follow value corruption; this does not establish a separate
compiler defect on correctly encoded Temporal values.

Verified result: **3 passing controls, 10 failing cases**. Date round-tripping,
a Date range predicate, and ISO string preservation pass. Temporal's own
`JSON.stringify` returns ISO strings, so the `{}` loss occurs in persistence's
recursive encoding before JSON serialization.

## Expected behavior

Supported Temporal values should preserve their type and value across
persistence, including nested values and metadata. Subset predicates, sorting,
pagination, and persisted index expressions should agree with those values.
If Temporal is unsupported, an explicit error would be preferable to silently
destroying the data.

## Environment

- macOS, Node 24.19.0, pnpm 11.19.0
- `@tanstack/db` 0.11.3
- `@tanstack/db-sqlite-persistence-core` 0.4.3 (npm latest checked October 5, 2026)
- `temporal-polyfill` 0.3.2
- No patches; real file-backed SQLite through `node:sqlite`

## Additional context

The shared serializer recursively enumerates objects but has no Temporal
handling. These Temporal instances have no enumerable own state, so different
values collapse to the same empty object.

`@tanstack/offline-transactions` 1.0.61 already preserves these Temporal values
when global constructors are registered; the reproduction includes that as a
passing control. This report concerns the remaining SQLite persistence gap.

Native Temporal support or an extensible codec would help. A codec contract
would need to cover row values, metadata, replay, query literals, and compatible
index/comparison semantics. We currently wrap writes and reads in an application
codec, but already-corrupted `{}` timestamps need cache invalidation or refetching.
