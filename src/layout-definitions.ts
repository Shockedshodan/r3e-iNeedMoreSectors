import type { SectorDefinition, StorageLike } from './contracts.ts';
import { createSectorDefinition } from './sector-definition.ts';
import { isValidBoundaries, sameBoundaries } from './validation.ts';

export interface LayoutDefinitionRegistry {
  resolve(layoutId: number, lengthM: number): SectorDefinition;
}

export function createLayoutDefinitionRegistry(storage: StorageLike): LayoutDefinitionRegistry {
  const entries = new Map<number, { definition: SectorDefinition; dirty: boolean }>();

  function persist(layoutId: number): void {
    const entry = entries.get(layoutId)!;
    if (!entry.dirty) return;
    try {
      storage.setItem(`r3e-sectors:v1:layout-definition:${layoutId}`, JSON.stringify({
        schemaVersion: 1, ...entry.definition,
      }));
      entry.dirty = false;
    } catch {
      // Keep the layout fixed in memory and retry the same definition later.
    }
  }

  return {
    resolve(layoutId, lengthM) {
      const cached = entries.get(layoutId);
      if (cached) {
        persist(layoutId);
        return cached.definition;
      }
      const automatic = createSectorDefinition(layoutId, lengthM);
      // A denied read is not an empty registry: let the caller defer timing
      // initialization rather than overwriting an unknown existing definition.
      const raw = storage.getItem(`r3e-sectors:v1:layout-definition:${layoutId}`);
      let value: unknown = null;
      try { value = raw === null ? null : JSON.parse(raw); } catch { /* Corrupt data is not a definition. */ }
      let definition = automatic;
      let dirty = true;
      if (value && typeof value === 'object') {
        const saved = value as SectorDefinition & { schemaVersion?: unknown };
        if (saved.schemaVersion === 1 && saved.layoutId === layoutId
          && Number.isFinite(saved.layoutLengthM) && saved.layoutLengthM > 0
          && isValidBoundaries(saved.boundaries)) {
          const expected = createSectorDefinition(layoutId, saved.layoutLengthM);
          if (sameBoundaries(expected.boundaries, saved.boundaries)) {
            definition = expected;
            dirty = false;
          }
        }
      }
      entries.set(layoutId, { definition, dirty });
      persist(layoutId);
      return definition;
    },
  };
}
