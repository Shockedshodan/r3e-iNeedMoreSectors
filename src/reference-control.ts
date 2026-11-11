import type {
  KeyBinding, ReferenceController, ReferenceMode, StorageLike, TimingView, TimingViewOptions,
} from './contracts.ts';
import { referenceDeltaUs } from './curves.ts';

const PREFERENCES_KEY = 'r3e-sectors:v1:preferences:timing';
const DEFAULT_BINDING: KeyBinding = {
  code: 'KeyT', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
};

function validBinding(value: unknown): value is KeyBinding {
  if (value === null || typeof value !== 'object') return false;
  const binding = value as Partial<KeyBinding>;
  return typeof binding.code === 'string' && binding.code.trim().length > 0 &&
    binding.code === binding.code.trim() &&
    typeof binding.altKey === 'boolean' && typeof binding.ctrlKey === 'boolean' &&
    typeof binding.shiftKey === 'boolean' && typeof binding.metaKey === 'boolean';
}

function copyBinding(binding: KeyBinding): KeyBinding {
  const { code, altKey, ctrlKey, shiftKey, metaKey } = binding;
  return { code, altKey, ctrlKey, shiftKey, metaKey };
}

export function createReferenceController(storage: StorageLike): ReferenceController {
  let mode: ReferenceMode = 'off';
  let binding = copyBinding(DEFAULT_BINDING);
  try {
    const raw = storage.getItem(PREFERENCES_KEY);
    const preferences: unknown = raw === null ? null : JSON.parse(raw);
    if (preferences !== null && typeof preferences === 'object') {
      const saved = preferences as { mode?: unknown; binding?: unknown };
      if (saved.mode === 'off' || saved.mode === 'opt' || saved.mode === 'best') mode = saved.mode;
      if (validBinding(saved.binding)) binding = copyBinding(saved.binding);
    }
  } catch {
    // Restricted browser storage and malformed saved data must not prevent
    // in-memory commands from working. Reads never overwrite the original.
  }

  function persist(): void {
    try {
      storage.setItem(PREFERENCES_KEY, JSON.stringify({ mode, binding }));
    } catch {
      // Keep the latest in memory. The next preference change retries storage.
    }
  }

  function cycle(): void {
    mode = mode === 'off' ? 'opt' : mode === 'opt' ? 'best' : 'off';
    persist();
  }

  return {
    mode: () => mode,
    binding: () => copyBinding(binding),
    setBinding(value) {
      if (!validBinding(value)) throw new RangeError('Invalid reference hotkey binding');
      binding = copyBinding(value);
      persist();
    },
    cycle,
    handleKey(event, _layoutLocked) {
      const target = event.target;
      if (event.repeat || target?.isContentEditable ||
        (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName.toUpperCase()))) {
        return false;
      }
      if (event.code !== binding.code || event.altKey !== binding.altKey ||
        event.ctrlKey !== binding.ctrlKey || event.shiftKey !== binding.shiftKey ||
        event.metaKey !== binding.metaKey) {
        return false;
      }
      cycle();
      return true;
    },
  };
}

export function createTimingView(options: TimingViewOptions): TimingView {
  const reference = options.mode === 'off' ? null : options.snapshot[options.mode];
  const preview = options.editing;
  const visible = options.mode !== 'off';
  return {
    panel: {
      visible: preview || (visible && options.panelEnabled),
      preview,
      reference,
    },
    delta: {
      visible: preview || (visible && options.deltaEnabled),
      preview,
      reference,
      valueUs: reference && !preview
        ? referenceDeltaUs(reference, options.snapshot, options.distanceFraction, options.lapElapsedUs)
        : null,
    },
  };
}
