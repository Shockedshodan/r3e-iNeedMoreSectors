import type { Combination, LapCandidate, RecordBook, RecordRepository, RecordUpdate, StorageLike } from './contracts.ts';
import { notImplemented } from './not-implemented.ts';

export function recordStorageKey(combination: Combination): string {
  return notImplemented('recordStorageKey');
}

export function updateRecords(existing: RecordBook, candidate: LapCandidate): RecordUpdate {
  return notImplemented('updateRecords');
}

export function createRecordRepository(storage: StorageLike): RecordRepository {
  return notImplemented('createRecordRepository');
}
