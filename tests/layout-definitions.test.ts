import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLayoutDefinitionRegistry } from '../src/layout-definitions.ts';
import { MemoryStorage } from './helpers.ts';

test('automatic definitions are frozen once per layout, not per current car or length sample', () => {
  const storage = new MemoryStorage();
  const registry = createLayoutDefinitionRegistry(storage);
  const first = registry.resolve(10, 3000);
  assert.deepEqual(first.boundaries, [0, 0.5, 1]);
  assert.equal(registry.resolve(10, 4500), first);
  assert.equal(first.layoutLengthM, 3000);
  assert.equal(storage.writes.length, 1);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.boundaries));
});

test('saved layout definitions survive a registry recreation independently of records and preferences', () => {
  const storage = new MemoryStorage();
  const first = createLayoutDefinitionRegistry(storage).resolve(10, 3000);
  assert.deepEqual(createLayoutDefinitionRegistry(storage).resolve(10, 4500), first);
  assert.equal(storage.values.size, 1);
  const key = [...storage.values.keys()][0];
  assert.equal(key, 'r3e-sectors:v1:layout-definition:10');
  assert.equal(key.includes('records'), false);
});

test('different layouts retain distinct automatic definitions', () => {
  const registry = createLayoutDefinitionRegistry(new MemoryStorage());
  assert.deepEqual(registry.resolve(10, 3000).boundaries, [0, 0.5, 1]);
  assert.deepEqual(registry.resolve(11, 4500).boundaries, [0, 1 / 3, 2 / 3, 1]);
});

for (const serialized of ['{broken', JSON.stringify({ schemaVersion: 7 }), JSON.stringify({ schemaVersion: 1, layoutId: 99, layoutLengthM: 3000, boundaries: [0, 0.5, 1] })]) {
  test(`corrupt or incompatible saved definition is replaced by a valid automatic definition: ${serialized}`, () => {
    const storage = new MemoryStorage();
    storage.values.set('r3e-sectors:v1:layout-definition:10', serialized);
    assert.deepEqual(createLayoutDefinitionRegistry(storage).resolve(10, 3000).boundaries, [0, 0.5, 1]);
  });
}

test('denied reads cannot overwrite an existing saved definition', () => {
  const storage = new MemoryStorage();
  createLayoutDefinitionRegistry(storage).resolve(10, 3000);
  const saved = storage.values.get('r3e-sectors:v1:layout-definition:10');
  storage.failReads = true;
  const registry = createLayoutDefinitionRegistry(storage);
  assert.throws(() => registry.resolve(10, 4500), /storage|unavailable/i);
  assert.equal(storage.values.get('r3e-sectors:v1:layout-definition:10'), saved);
  storage.failReads = false;
  assert.deepEqual(registry.resolve(10, 4500).boundaries, [0, 0.5, 1]);
});

test('denied writes preserve the in-memory frozen definition and retry later', () => {
  const storage = new MemoryStorage();
  storage.failWrites = true;
  const registry = createLayoutDefinitionRegistry(storage);
  const definition = registry.resolve(10, 3000);
  assert.equal(storage.writes.length, 0);
  storage.failWrites = false;
  assert.equal(registry.resolve(10, 4500), definition);
  assert.equal(storage.writes.length, 1);
});
