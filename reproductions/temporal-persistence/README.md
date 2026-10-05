# Temporal SQLite persistence reproduction

This is a standalone reproduction against published packages, independent of
the enclosing TanStack DB workspace. It uses a real SQLite file via `node:sqlite`,
closes and reopens the database, and calls the public persistence adapter APIs.
It needs no Expo project, backend, credentials, native build, or repository build.

## Run

Use Node.js 22.13 or newer and pnpm (verified with Node 24.19.0 and pnpm 11.19.0
on macOS). Run from this directory:

```sh
pnpm install --frozen-lockfile
pnpm test
```

`npm install && npm test` also works; the committed pnpm lockfile is the exact
dependency resolution used for the verified run. Older Node releases may print
an experimental warning for `node:sqlite`.

The test command deliberately exits **1**: it asserts the desired behavior,
rather than treating corruption as success. On the pinned releases the result
is **3 passing controls and 10 failing regression cases**. Tests create temporary
databases and remove them when finished.

## Confirmed results

| Case                                         | Expected                                           | Observed   |
| -------------------------------------------- | -------------------------------------------------- | ---------- |
| Row values, including nested array           | `Temporal.Instant` / `Temporal.PlainDate` restored | `{}`       |
| Row metadata via `scanRows`                  | Temporal values restored                           | `{}`       |
| Collection metadata                          | Temporal values restored                           | `{}`       |
| `pullSince` replay row and metadata payloads | Temporal values restored                           | `{}`       |
| PlainDate equality                           | `['early']`                                        | `[]`       |
| PlainDate greater-than                       | `['late']`                                         | `[]`       |
| PlainDate ascending order, limit 1           | `['early']`                                        | `['late']` |

All three query cases run both without and with a persisted expression index
installed. This establishes failure in both configurations; it does not assert
which query plan SQLite chooses. These query failures are demonstrated after
the values have already been corrupted, so they do not establish a separate
query compiler bug on correctly encoded Temporal values.

The controls verify Date round-tripping and a Date range predicate, unchanged
ISO strings, Temporal's own string/JSON representation, and current
`@tanstack/offline-transactions` mutation round-tripping. Offline transactions
require the Temporal constructors on `globalThis`; the reproduction explicitly
registers the same constructors used to create the values. A module-only
Temporal import instead throws `Missing global Temporal.Instant constructor`
in that package's current serializer.

## Versions and scope

- `@tanstack/db`: **0.11.3**
- `@tanstack/db-sqlite-persistence-core`: **0.4.3**
- `@tanstack/offline-transactions`: **1.0.61**
- `temporal-polyfill`: **0.3.2**, matching the application's polyfill version

Persistence core 0.4.3 and offline-transactions 1.0.61 were the npm `latest`
releases checked on October 5, 2026. No dependency patches are applied.

The enclosing checkout is commit
`67c840fe7a45d818de768fa790ebec2f27654d04`, with persistence core 0.2.9;
the reproduction intentionally does not load that checkout's older packages.

The migration that prompted this report used DB 0.9.2 and persistence core
0.2.23 in an Expo application. This reproduction isolates the shared core and
rechecks the failure on current releases. It tests Instant and PlainDate only;
other Temporal types and platform adapters need their own coverage.

An application wrapper can tag Temporal values before they reach the adapter,
then revive them after reads. That avoids value loss for new writes, but query
literals, persisted index expressions, ordering, and every metadata/replay path
also need compatible handling. Cached `{}` values contain no recoverable date
or timestamp and need refetching or invalidation.

[Issue draft](./ISSUE_DRAFT.md) contains the proposed report. Nothing has been posted.
