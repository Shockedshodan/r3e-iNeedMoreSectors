import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecordRepository, recordStorageKey, updateRecords } from '../src/records.ts';
import { book, candidate, combination, deepFreeze, definition, lap, MemoryStorage } from './helpers.ts';
import type { LapCandidate, RecordBook } from '../src/contracts.ts';

test('first complete valid lap creates both Best and Opt with their curves', () => {
  const incoming = deepFreeze(candidate());
  const update = updateRecords(deepFreeze(book()), incoming);
  assert.equal(update.bestChanged, true);
  assert.equal(update.optChanged, true);
  assert.deepEqual(update.records.best, incoming.reference);
  assert.deepEqual(update.records.opt, incoming.reference);
});

test('a faster Best replaces the entire lap, even a sector slower than old Opt', () => {
  const previous = deepFreeze(book([500_000, 500_000]));
  const incoming = deepFreeze(candidate([400_000, 550_000]));
  const update = updateRecords(previous, incoming);
  assert.deepEqual(update.records.best, incoming.reference);
  assert.deepEqual(update.records.opt, {
    totalUs: 900_000,
    sectors: [incoming.reference.sectors[0], previous.opt!.sectors[1]],
  });
  assert.deepEqual(previous.best, lap([500_000, 500_000]));
});

test('a slower complete lap can improve an Opt sector and its curve without changing Best', () => {
  const previous = deepFreeze(book([500_000, 500_000]));
  const incoming = deepFreeze(candidate([450_000, 650_000]));
  const update = updateRecords(previous, incoming);
  assert.equal(update.bestChanged, false);
  assert.equal(update.optChanged, true);
  assert.deepEqual(update.records.best, previous.best);
  assert.deepEqual(update.records.opt!.sectors[0], incoming.reference.sectors[0]);
  assert.deepEqual(update.records.opt!.sectors[1], previous.opt!.sectors[1]);
  assert.equal(update.records.opt!.totalUs, 950_000);
});

test('ties keep existing complete-lap and per-sector curves, even if shapes differ', () => {
  const previous = deepFreeze(book([500_000, 500_000]));
  const incoming = candidate();
  incoming.reference = {
    totalUs: 1_000_000,
    sectors: incoming.reference.sectors.map(s => ({
      durationUs: s.durationUs,
      curve: [{ fraction: 0, elapsedUs: 0 }, { fraction: 0.5, elapsedUs: 100_000 }, { fraction: 1, elapsedUs: 500_000 }],
    })),
  };
  const update = updateRecords(previous, incoming);
  assert.equal(update.bestChanged, false);
  assert.equal(update.optChanged, false);
  assert.deepEqual(update.records, previous);
});

for (const [name, overrides] of [
  ['invalid', { valid: false }], ['partial', { complete: false }],
] as [string, Partial<LapCandidate>][]) {
  test(`${name} capture cannot improve even one Opt sector`, () => {
    const previous = deepFreeze(book([500_000, 500_000]));
    const update = updateRecords(previous, candidate([100_000, 100_000], overrides));
    assert.deepEqual(update.records, previous);
    assert.equal(update.bestChanged || update.optChanged, false);
  });
}

test('a lap from another model cannot contaminate existing records', () => {
  assert.throws(() => updateRecords(book(), candidate(undefined, { modelId: 99 })), RangeError);
});

test('incompatible sector boundaries cannot be compared to the active definition', () => {
  assert.throws(() => updateRecords(book(), candidate(undefined, { boundaries: [0, 0.25, 1] })), RangeError);
});

for (const [name, mutate] of [
  ['total/sector disagreement', (c: LapCandidate) => { c.reference = { ...c.reference, totalUs: 1_000_001 }; }],
  ['curve endpoint disagrees with sector duration', (c: LapCandidate) => {
    c.reference = { ...c.reference, sectors: [{ durationUs: 500_000, curve: [{ fraction: 0, elapsedUs: 0 }, { fraction: 1, elapsedUs: 499_999 }] }, c.reference.sectors[1]] };
  }],
  ['nonfinite duration', (c: LapCandidate) => { c.reference = lap([Number.NaN, 500_000]); }],
  ['nonmonotonic curve', (c: LapCandidate) => {
    c.reference = { ...c.reference, sectors: [{ durationUs: 500_000, curve: [{ fraction: 0, elapsedUs: 0 }, { fraction: 0.5, elapsedUs: 600_000 }, { fraction: 1, elapsedUs: 500_000 }] }, c.reference.sectors[1]] };
  }],
] as const) {
  test(`malformed capture with ${name} preserves existing references`, () => {
    const incoming = candidate();
    mutate(incoming);
    const previous = deepFreeze(book([600_000, 600_000]));
    const update = updateRecords(previous, incoming);
    assert.deepEqual(update.records, previous);
    assert.equal(update.bestChanged || update.optChanged, false);
  });
}

test('versioned record key contains layout and model, excluding livery', () => {
  assert.equal(recordStorageKey(combination), 'r3e-sectors:v1:records:10:20');
  // A richer bridge object may carry a livery, but it is not part of identity.
  assert.equal(recordStorageKey({ ...combination, ...{ liveryId: 123 } }), recordStorageKey(combination));
  assert.notEqual(recordStorageKey({ ...combination, modelId: 21 }), recordStorageKey(combination));
  assert.notEqual(recordStorageKey({ ...combination, layoutId: 11 }), recordStorageKey(combination));
});

test('one entry contains only the two active references, with a round-trip across repository instances', () => {
  const storage = new MemoryStorage();
  const repository = createRecordRepository(storage);
  repository.consider(candidate(), definition);
  repository.consider(candidate([400_000, 550_000]), definition);
  assert.equal(storage.values.size, 1);
  assert.equal(storage.writes.length, 2);
  const stored = JSON.parse(storage.values.get('r3e-sectors:v1:records:10:20')!) as RecordBook;
  assert.deepEqual(Object.keys(stored).sort(), ['best', 'boundaries', 'layoutId', 'modelId', 'opt', 'schemaVersion']);
  assert.deepEqual(createRecordRepository(storage).load(combination, definition), stored);
});

test('ties and non-record laps cause no extra storage writes', () => {
  const storage = new MemoryStorage();
  const repository = createRecordRepository(storage);
  repository.consider(candidate(), definition);
  repository.consider(candidate(), definition);
  repository.consider(candidate([600_000, 600_000]), definition);
  assert.equal(storage.writes.length, 1);
});

test('storage failure retains improved references in memory and retries the latest state', () => {
  const storage = new MemoryStorage();
  const repository = createRecordRepository(storage);
  storage.failWrites = true;
  repository.consider(candidate(), definition);
  repository.consider(candidate([400_000, 550_000]), definition);
  assert.equal(repository.isDirty(combination), true);
  assert.equal(repository.load(combination, definition).best!.totalUs, 950_000);
  storage.failWrites = false;
  assert.equal(repository.flush(combination), true);
  assert.equal(repository.isDirty(combination), false);
  assert.equal(storage.writes.length, 1);
  assert.equal(JSON.parse(storage.writes[0].value).best.totalUs, 950_000);
});

test('storage reads being unavailable do not prevent in-memory improvements', () => {
  const storage = new MemoryStorage();
  storage.failReads = true;
  storage.failWrites = true;
  const repository = createRecordRepository(storage);
  repository.consider(candidate(), definition);
  assert.equal(repository.load(combination, definition).best!.totalUs, 1_000_000);
});

for (const [name, serialized] of [
  ['invalid JSON', '{broken'],
  ['unknown version', JSON.stringify({ ...book([500_000, 500_000]), schemaVersion: 2 })],
  ['wrong combination', JSON.stringify({ ...book([500_000, 500_000]), modelId: 99 })],
  ['wrong boundaries', JSON.stringify({ ...book([500_000, 500_000]), boundaries: [0, 0.2, 1] })],
  ['unvalidated shape', JSON.stringify({ schemaVersion: 1, ...combination, best: 'fast' })],
  ['inconsistent totals', JSON.stringify({ ...book(), best: { ...lap(), totalUs: 3 }, opt: lap() })],
]) {
  test(`${name} storage is ignored without overwriting it during load`, () => {
    const storage = new MemoryStorage();
    storage.values.set('r3e-sectors:v1:records:10:20', serialized);
    const loaded = createRecordRepository(storage).load(combination, definition);
    assert.equal(loaded.best, null);
    assert.equal(loaded.opt, null);
    assert.equal(storage.writes.length, 0);
    assert.equal(storage.values.get('r3e-sectors:v1:records:10:20'), serialized);
  });
}
