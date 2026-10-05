import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { IR, createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import {
  SQLiteCorePersistenceAdapter,
  createPersistedTableName,
} from '@tanstack/db-sqlite-persistence-core'
import { TransactionSerializer } from '@tanstack/offline-transactions'
import { Temporal } from 'temporal-polyfill'

// Current offline-transactions needs global constructors for tagged decoding.
// Use the same constructors as the module import, even on a native Temporal host.
globalThis.Temporal = Temporal

// Real SQLite, using Node's built-in driver to avoid native package installation.
class SQLiteDriver {
  constructor(database) {
    this.database = database
  }

  async exec(sql) {
    this.database.exec(sql)
  }

  async query(sql, params = []) {
    return this.database.prepare(sql).all(...params)
  }

  async run(sql, params = []) {
    this.database.prepare(sql).run(...params)
  }

  async transaction(callback) {
    this.database.exec('BEGIN')
    try {
      const result = await callback(this)
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

const collectionId = 'temporal-repro'

function values(day = '2026-01-02') {
  return {
    instant: Temporal.Instant.from(`${day}T00:00:00Z`),
    plainDate: Temporal.PlainDate.from(day),
    nested: { dates: [Temporal.PlainDate.from(day)] },
    date: new Date(`${day}T00:00:00Z`),
    isoString: day,
  }
}

function assertTemporalValues(actual, expected) {
  assert.deepEqual(
    {
      instant: actual.instant instanceof Temporal.Instant,
      plainDate: actual.plainDate instanceof Temporal.PlainDate,
      nested: actual.nested.dates[0] instanceof Temporal.PlainDate,
    },
    { instant: true, plainDate: true, nested: true },
    'Temporal types are lost',
  )
  assert.ok(actual.instant.equals(expected.instant))
  assert.ok(actual.plainDate.equals(expected.plainDate))
  assert.ok(actual.nested.dates[0].equals(expected.nested.dates[0]))
}

async function seed(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tanstack-temporal-repro-'))
  const path = join(directory, 'cache.sqlite')
  let database = new DatabaseSync(path)
  t.after(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  let adapter = new SQLiteCorePersistenceAdapter({
    driver: new SQLiteDriver(database),
  })
  const early = { id: 'early', ...values() }
  const late = { id: 'late', ...values('2026-01-03') }
  await adapter.applyCommittedTx(collectionId, {
    txId: 'seed',
    term: 1,
    seq: 1,
    rowVersion: 1,
    // Insert late first so ordering cannot pass by returning insertion order.
    mutations: [late, early].map((value) => ({
      type: 'insert',
      key: value.id,
      value,
      metadata: values(),
      metadataChanged: true,
    })),
    collectionMetadataMutations: [
      { type: 'set', key: 'checkpoint', value: values() },
    ],
  })
  // Close and reopen the actual file, as on an application restart.
  database.close()
  database = new DatabaseSync(path)
  adapter = new SQLiteCorePersistenceAdapter({
    driver: new SQLiteDriver(database),
  })
  return { adapter, database, early, late }
}

test('control: Date and ISO strings survive SQLite restart', async (t) => {
  const { adapter, early } = await seed(t)
  const rows = await adapter.loadSubset(collectionId, {})
  const row = rows.find((entry) => entry.key === early.id).value
  assert.ok(row.date instanceof Date)
  assert.equal(row.date.toISOString(), early.date.toISOString())
  assert.equal(row.isoString, early.isoString)
  const laterRows = await adapter.loadSubset(collectionId, {
    where: new IR.Func('gt', [
      new IR.PropRef(['date']),
      new IR.Value(early.date),
    ]),
  })
  assert.deepEqual(
    laterRows.map((entry) => entry.key),
    ['late'],
  )
})

test('control: Temporal exposes distinct JSON/string values before persistence', () => {
  const early = values()
  const late = values('2026-01-03')
  assert.equal(JSON.stringify(early.plainDate), '"2026-01-02"')
  assert.equal(JSON.stringify(early.instant), '"2026-01-02T00:00:00Z"')
  assert.equal(Temporal.PlainDate.compare(early.plainDate, late.plainDate), -1)
})

test('SQLite row Temporal values survive restart', async (t) => {
  const { adapter, database, early } = await seed(t)
  const table = createPersistedTableName(collectionId)
  console.log(
    'Stored row JSON:',
    database.prepare(`SELECT value FROM "${table}"`).get().value,
  )
  const rows = await adapter.loadSubset(collectionId, {})
  assertTemporalValues(rows.find((row) => row.key === early.id).value, early)
})

test('SQLite row metadata retains Temporal values', async (t) => {
  const { adapter } = await seed(t)
  const rows = await adapter.scanRows(collectionId)
  assertTemporalValues(rows[0].metadata, values())
})

test('SQLite collection metadata retains Temporal values', async (t) => {
  const { adapter } = await seed(t)
  const metadata = await adapter.loadCollectionMetadata(collectionId)
  assertTemporalValues(
    metadata.find((entry) => entry.key === 'checkpoint').value,
    values(),
  )
})

test('SQLite replay deltas retain Temporal values', async (t) => {
  const { adapter, late } = await seed(t)
  await adapter.applyCommittedTx(collectionId, {
    txId: 'update',
    term: 1,
    seq: 2,
    rowVersion: 2,
    mutations: [{ type: 'update', key: late.id, value: late }],
    rowMetadataMutations: [{ type: 'set', key: late.id, value: values() }],
    collectionMetadataMutations: [
      { type: 'set', key: 'checkpoint', value: values() },
    ],
  })
  const replay = await adapter.pullSince(collectionId, 1)
  assert.equal(replay.requiresFullReload, false)
  console.log('Replay delta:', JSON.stringify(replay.deltas[0]))
  assertTemporalValues(replay.deltas[0].changedRows[0].value, late)
  assertTemporalValues(replay.deltas[0].rowMetadataMutations[0].value, values())
  assertTemporalValues(
    replay.deltas[0].collectionMetadataMutations[0].value,
    values(),
  )
})

for (const indexed of [false, true]) {
  for (const operation of ['equality', 'range', 'ordered']) {
    test(`SQLite Temporal ${operation} (indexed=${indexed})`, async (t) => {
      const { adapter, early, late } = await seed(t)
      if (indexed) {
        await adapter.ensureIndex(collectionId, 'plain-date-index', {
          expressionSql: ["json_extract(value, '$.plainDate')"],
        })
      }
      const options = {
        equality: {
          where: new IR.Func('eq', [
            new IR.PropRef(['plainDate']),
            new IR.Value(early.plainDate),
          ]),
        },
        range: {
          where: new IR.Func('gt', [
            new IR.PropRef(['plainDate']),
            new IR.Value(early.plainDate),
          ]),
        },
        ordered: {
          orderBy: [
            {
              expression: new IR.PropRef(['plainDate']),
              compareOptions: { direction: 'asc', nulls: 'last' },
            },
          ],
          limit: 1,
        },
      }
      const rows = await adapter.loadSubset(collectionId, options[operation])
      const actual = rows.map((row) => row.key)
      const expected = operation === 'range' ? [late.id] : [early.id]
      console.log({ indexed, operation, actual, expected })
      assert.deepEqual(actual, expected)
    })
  }
}

test('control: current offline transaction serializer retains Temporal mutation data', async (t) => {
  const collection = createCollection(
    localOnlyCollectionOptions({
      id: collectionId,
      getKey: (row) => row.id,
    }),
  )
  t.after(() => collection.cleanup())
  const serializer = new TransactionSerializer({ events: collection })
  const row = { id: 'event', ...values() }
  const now = new Date('2026-01-02T00:00:00Z')
  const transaction = {
    id: 'offline',
    mutationFnName: 'saveEvent',
    keys: ['event'],
    idempotencyKey: 'offline',
    createdAt: now,
    retryCount: 0,
    nextAttemptAt: 0,
    version: 1,
    mutations: [
      {
        mutationId: 'mutation',
        globalKey: 'event',
        type: 'update',
        key: 'event',
        original: row,
        modified: row,
        changes: values(),
        collection,
        metadata: undefined,
        syncMetadata: {},
        optimistic: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
  }
  const serialized = serializer.serialize(transaction)
  const restored = serializer.deserialize(serialized)
  assert.ok(restored.mutations[0].modified.date instanceof Date)
  assert.equal(restored.mutations[0].modified.isoString, row.isoString)
  for (const field of ['original', 'modified', 'changes']) {
    assertTemporalValues(restored.mutations[0][field], row)
  }
})
