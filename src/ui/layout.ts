import type { StorageLike, WidgetSpec } from '../contracts.ts';

// SPDX-License-Identifier: MIT
// Interaction/profile behavior adapted from SealHUD app.tsx, commit
// d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b.
// Copyright (c) 2026 Diego Junges and contributors. See THIRD_PARTY_NOTICES.md.

const STORAGE_KEY = 'r3e-sectors:v1:layout';

export interface WidgetLayout { x: number; y: number; scale: number; enabled: boolean }
export type LayoutProfile = 1 | 2 | 3;
export interface LayoutState {
  profile: LayoutProfile;
  editing: boolean;
  locked: boolean;
  widgets: Readonly<Record<string, Readonly<WidgetLayout>>>;
}
export interface LayoutController {
  getState(): LayoutState;
  subscribe(listener: () => void): () => void;
  registerWidgets(descriptors: readonly WidgetSpec[]): void;
  setEditing(editing: boolean): void;
  setLocked(locked: boolean): void;
  setPosition(id: string, position: { x: number; y: number }): void;
  setScale(id: string, scale: number): void;
  setEnabled(id: string, enabled: boolean): void;
  setProfile(profile: LayoutProfile): void;
  resetProfile(): void;
}

export function createLayoutController(storage: StorageLike, descriptors: readonly WidgetSpec[]): LayoutController {
  let defaults = new Map<string, WidgetLayout>();
  let profile: LayoutProfile = 1;
  let locked = false;
  let editing = false;
  const profiles: Record<LayoutProfile, Record<string, WidgetLayout>> = {
    1: Object.create(null), 2: Object.create(null), 3: Object.create(null),
  };
  const listeners = new Set<() => void>();

  function validWidget(value: unknown): value is WidgetLayout {
    if (value === null || typeof value !== 'object') return false;
    const widget = value as Partial<WidgetLayout>;
    return typeof widget.x === 'number' && Number.isFinite(widget.x)
      && typeof widget.y === 'number' && Number.isFinite(widget.y)
      && typeof widget.scale === 'number' && Number.isFinite(widget.scale)
      && widget.scale >= 0.1 && widget.scale <= 3 && typeof widget.enabled === 'boolean';
  }

  function copyWidget(value: WidgetLayout): WidgetLayout {
    return { x: value.x, y: value.y, scale: value.scale, enabled: value.enabled };
  }

  function register(values: readonly WidgetSpec[]): void {
    const next = new Map<string, WidgetLayout>();
    for (const descriptor of values) {
      if (!descriptor || typeof descriptor.id !== 'string' || descriptor.id.trim().length === 0
        || next.has(descriptor.id) || !validWidget(descriptor.defaults)) {
        throw new RangeError('Widgets require unique IDs and valid layout defaults');
      }
      next.set(descriptor.id, copyWidget(descriptor.defaults));
    }
    defaults = next;
    for (const selected of [1, 2, 3] as const) {
      for (const [id, value] of defaults) {
        if (!validWidget(profiles[selected][id])) profiles[selected][id] = copyWidget(value);
      }
    }
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    const saved: unknown = raw === null ? null : JSON.parse(raw);
    if (saved !== null && typeof saved === 'object' && !Array.isArray(saved)) {
      const value = saved as { schemaVersion?: unknown; profile?: unknown; locked?: unknown; profiles?: unknown };
      if (value.schemaVersion === 1) {
        if (value.profile === 1 || value.profile === 2 || value.profile === 3) profile = value.profile;
        if (typeof value.locked === 'boolean') locked = value.locked;
        if (value.profiles !== null && typeof value.profiles === 'object') {
          const storedProfiles = value.profiles as Record<string, unknown>;
          for (const selected of [1, 2, 3] as const) {
            const widgets = storedProfiles[String(selected)];
            if (widgets !== null && typeof widgets === 'object' && !Array.isArray(widgets)) {
              for (const [id, widget] of Object.entries(widgets)) {
                if (validWidget(widget)) profiles[selected][id] = copyWidget(widget);
              }
            }
          }
        }
      }
    }
  } catch {
    // Corrupt or unavailable browser storage must not block local placement.
  }
  register(descriptors);

  function snapshot(): LayoutState {
    const widgets = Object.fromEntries([...defaults.keys()].map(id => [
      id, Object.freeze(copyWidget(profiles[profile][id])),
    ]));
    return Object.freeze({ profile, editing, locked, widgets: Object.freeze(widgets) });
  }
  let state = snapshot();

  function publish(persist = true): void {
    state = snapshot();
    if (persist) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, profile, locked, profiles }));
      } catch {
        // Keep edits in memory; the next persisted change retries latest state.
      }
    }
    for (const listener of [...listeners]) listener();
  }

  function widget(id: string): WidgetLayout {
    if (!defaults.has(id)) throw new RangeError(`Unknown widget: ${id}`);
    return profiles[profile][id];
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    registerWidgets(values) { register(values); publish(); },
    setEditing(value) {
      if (typeof value !== 'boolean') throw new RangeError('Editing must be a boolean');
      if (editing === value) return;
      editing = value;
      publish(false);
    },
    setLocked(value) {
      if (typeof value !== 'boolean') throw new RangeError('Lock state must be a boolean');
      if (locked === value) return;
      locked = value;
      publish();
    },
    setPosition(id, position) {
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new RangeError('Position must be finite');
      const setting = widget(id);
      setting.x = position.x;
      setting.y = position.y;
      publish();
    },
    setScale(id, value) {
      if (!Number.isFinite(value)) throw new RangeError('Scale must be finite');
      widget(id).scale = Math.max(0.1, Math.min(3, value));
      publish();
    },
    setEnabled(id, value) {
      if (typeof value !== 'boolean') throw new RangeError('Visibility must be a boolean');
      widget(id).enabled = value;
      publish();
    },
    setProfile(value) {
      if (value !== 1 && value !== 2 && value !== 3) throw new RangeError('Unknown layout profile');
      if (profile === value) return;
      profile = value;
      publish();
    },
    resetProfile() {
      for (const [id, value] of defaults) profiles[profile][id] = copyWidget(value);
      publish();
    },
  };
}
