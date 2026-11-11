import type { Combination, LapCandidate, RecordBook, RecordRepository, RecordUpdate, SectorDefinition, StorageLike } from './contracts.ts';
import { copyReference, immutable, isValidBoundaries, isValidCombination, isValidReference, sameBoundaries } from './validation.ts';

function validBook(value: unknown): value is RecordBook {
  if (!isValidCombination(value)) return false;
  const book = value as RecordBook;
  if (book.schemaVersion !== 1 || !isValidBoundaries(book.boundaries)) return false;
  const count = book.boundaries.length - 1;
  if (book.best === null && book.opt === null) return true;
  return isValidReference(book.best, count) && isValidReference(book.opt, count)
    && book.opt.sectors.every((sector, index) => sector.durationUs <= book.best!.sectors[index].durationUs);
}

function copyBook(book: RecordBook): RecordBook {
  return immutable({
    schemaVersion: 1, layoutId: book.layoutId, modelId: book.modelId,
    boundaries: [...book.boundaries],
    best: book.best && copyReference(book.best),
    opt: book.opt && copyReference(book.opt),
  });
}

export function mergeRecordBooks(existing: RecordBook, recovered: RecordBook): RecordBook {
  if (!validBook(existing) || !validBook(recovered)
    || existing.layoutId !== recovered.layoutId || existing.modelId !== recovered.modelId
    || !sameBoundaries(existing.boundaries, recovered.boundaries)) {
    throw new RangeError('Recovered records must have compatible identity, curves and boundaries');
  }
  if (recovered.best === null) return existing;
  if (existing.best === null) return copyBook(recovered);
  const best = recovered.best.totalUs < existing.best.totalUs ? recovered.best : existing.best;
  const sectors = existing.opt!.sectors.map((sector, index) =>
    recovered.opt!.sectors[index].durationUs < sector.durationUs ? recovered.opt!.sectors[index] : sector);
  if (best === existing.best && sectors.every((sector, index) => sector === existing.opt!.sectors[index])) return existing;
  return copyBook({
    ...existing, best,
    opt: { totalUs: sectors.reduce((sum, sector) => sum + sector.durationUs, 0), sectors },
  });
}

export function recordStorageKey(combination: Combination): string {
  if (!isValidCombination(combination)) throw new RangeError('A known layout and model are required');
  return `r3e-sectors:v1:records:${combination.layoutId}:${combination.modelId}`;
}

export function updateRecords(existing: RecordBook, candidate: LapCandidate): RecordUpdate {
  if (!isValidCombination(existing) || !isValidCombination(candidate)
    || existing.layoutId !== candidate.layoutId || existing.modelId !== candidate.modelId
    || !isValidBoundaries(existing.boundaries) || !isValidBoundaries(candidate.boundaries)
    || !sameBoundaries(existing.boundaries, candidate.boundaries)) {
    throw new RangeError('Lap identity and boundaries must match existing records');
  }
  const unchanged = { records: existing, bestChanged: false, optChanged: false };
  if (candidate.complete !== true || candidate.valid !== true
    || !isValidReference(candidate.reference, existing.boundaries.length - 1)) return unchanged;
  const incoming = candidate.reference;
  const bestChanged = existing.best === null || incoming.totalUs < existing.best.totalUs;
  const sectors = incoming.sectors.map((sector, index) => {
    const old = existing.opt?.sectors[index];
    return old && old.durationUs <= sector.durationUs ? old : sector;
  });
  const optChanged = existing.opt === null || sectors.some((sector, index) => sector !== existing.opt!.sectors[index]);
  if (!bestChanged && !optChanged) return unchanged;
  const best = bestChanged ? copyReference(incoming) : existing.best && copyReference(existing.best);
  const opt = optChanged ? copyReference({
    totalUs: sectors.reduce((sum, sector) => sum + sector.durationUs, 0), sectors,
  }) : existing.opt && copyReference(existing.opt);
  return {
    records: immutable({
      schemaVersion: 1, layoutId: existing.layoutId, modelId: existing.modelId,
      boundaries: [...existing.boundaries], best, opt,
    }),
    bestChanged, optChanged,
  };
}

export function createRecordRepository(storage: StorageLike): RecordRepository {
  interface Entry { records: RecordBook; dirty: boolean; readVerified: boolean }
  const entries = new Map<string, Entry>();
  const definitions = new Map<number, readonly number[]>();

  function recover(key: string, entry: Entry): void {
    // A failed read means unknown existing records, not an empty database.
    // Never overwrite them until a successful read allows a coherent merge.
    const serialized = storage.getItem(key);
    let saved: unknown = null;
    try { saved = serialized === null ? null : JSON.parse(serialized); } catch { /* Corrupt JSON is unusable. */ }
    if (validBook(saved) && saved.layoutId === entry.records.layoutId && saved.modelId === entry.records.modelId
      && sameBoundaries(saved.boundaries, entry.records.boundaries)) {
      entry.records = mergeRecordBooks(copyBook(saved), entry.records);
    }
    entry.readVerified = true;
  }

  function load(combination: Combination, definition: SectorDefinition): RecordBook {
    const key = recordStorageKey(combination);
    if (definition.layoutId !== combination.layoutId || !isValidBoundaries(definition.boundaries)) {
      throw new RangeError('Definition must match the combination');
    }
    const frozenDefinition = definitions.get(definition.layoutId);
    if (frozenDefinition && !sameBoundaries(frozenDefinition, definition.boundaries)) {
      throw new RangeError('Cannot replace a loaded sector definition across car models');
    }
    definitions.set(definition.layoutId, Object.freeze([...definition.boundaries]));
    let entry = entries.get(key);
    if (entry) {
      if (!entry.readVerified) {
        try { recover(key, entry); } catch { /* Retain memory until reads recover. */ }
      }
      return entry.records;
    }
    const records: RecordBook = immutable({
      schemaVersion: 1, layoutId: combination.layoutId, modelId: combination.modelId,
      boundaries: [...definition.boundaries], best: null, opt: null,
    });
    entry = { records, dirty: false, readVerified: false };
    try { recover(key, entry); } catch { /* Collect in memory while storage is unavailable. */ }
    entries.set(key, entry);
    return entry.records;
  }

  function flush(combination: Combination): boolean {
    const key = recordStorageKey(combination);
    const entry = entries.get(key);
    if (!entry?.dirty) return true;
    try {
      if (!entry.readVerified) recover(key, entry);
      storage.setItem(key, JSON.stringify(entry.records));
      entry.dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  return {
    load,
    consider(candidate, definition) {
      const previous = load(candidate, definition);
      const update = updateRecords(previous, candidate);
      if (update.bestChanged || update.optChanged) {
        const entry = entries.get(recordStorageKey(candidate))!;
        entry.records = update.records;
        entry.dirty = true;
        flush(candidate);
      }
      return update;
    },
    isDirty: combination => entries.get(recordStorageKey(combination))?.dirty ?? false,
    flush,
  };
}
