import type {
  ActionSpec, HudHost, HudModule, StorageLike, TelemetryBridge, TimingFrame, WidgetSpec,
} from './contracts.ts';

function requireId(id: unknown, kind: string): asserts id is string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new RangeError(`Invalid ${kind} ID`);
  }
}

function validateWidget(widget: WidgetSpec): void {
  if (!widget || typeof widget !== 'object') throw new RangeError('Invalid widget descriptor');
  requireId(widget.id, 'widget');
  const defaults = widget.defaults;
  if (!defaults || !Number.isFinite(defaults.x) || !Number.isFinite(defaults.y) ||
    !Number.isFinite(defaults.scale) || defaults.scale <= 0 || typeof defaults.enabled !== 'boolean') {
    throw new RangeError(`Invalid widget defaults: ${widget.id}`);
  }
}

export function createHudHost(modules: readonly HudModule[], bridge: TelemetryBridge, storage: StorageLike): HudHost {
  const moduleIds = new Set<string>();
  for (const module of modules) {
    if (!module || typeof module !== 'object') throw new RangeError('Invalid module descriptor');
    requireId(module.id, 'module');
    if (moduleIds.has(module.id)) throw new RangeError(`Duplicate module ID: ${module.id}`);
    if (typeof module.create !== 'function') throw new RangeError(`Invalid module factory: ${module.id}`);
    moduleIds.add(module.id);
  }

  let disposed = false;
  let disconnect: (() => void) | undefined;
  const instances: ReturnType<HudModule['create']>[] = [];
  const subscriptions = new Set<{ listener: (frame: TimingFrame) => void }>();
  const descriptors: WidgetSpec[] = [];
  const widgetIds = new Set<string>();
  const actions = new Map<string, ActionSpec>();

  function cleanup(): unknown[] {
    if (disposed) return [];
    disposed = true;
    subscriptions.clear();
    actions.clear();
    const failures: unknown[] = [];
    if (disconnect) {
      const close = disconnect;
      disconnect = undefined;
      try { close(); } catch (error) { failures.push(error); }
    }
    for (const instance of [...instances].reverse()) {
      try { instance.dispose(); } catch (error) { failures.push(error); }
    }
    instances.length = 0;
    return failures;
  }

  try {
    for (const module of modules) {
      // Escape the module ID so IDs containing the key delimiter cannot
      // overlap another module's namespace, regardless of their local keys.
      const prefix = `r3e-sectors:v1:module:${encodeURIComponent(module.id)}:`;
      const instance = module.create({
        subscribe(listener) {
          if (disposed) return () => {};
          if (typeof listener !== 'function') throw new TypeError('Invalid telemetry subscriber');
          const subscription = { listener };
          subscriptions.add(subscription);
          return () => { subscriptions.delete(subscription); };
        },
        storage: {
          getItem: key => storage.getItem(prefix + key),
          setItem: (key, value) => storage.setItem(prefix + key, value),
        },
      });
      if (!instance || typeof instance.dispose !== 'function') {
        throw new RangeError(`Invalid module instance: ${module.id}`);
      }
      // Register cleanup before checking descriptors, so invalid descriptors
      // cannot leak a module that has already allocated feature resources.
      instances.push(instance);
      if (!Array.isArray(instance.widgets)) throw new RangeError(`Invalid widgets: ${module.id}`);
      for (const widget of instance.widgets) {
        validateWidget(widget);
        if (widgetIds.has(widget.id)) throw new RangeError(`Duplicate widget ID: ${widget.id}`);
        widgetIds.add(widget.id);
        descriptors.push(Object.freeze({ ...widget, defaults: Object.freeze({ ...widget.defaults }) }));
      }
      if (instance.actions !== undefined && !Array.isArray(instance.actions)) {
        throw new RangeError(`Invalid actions: ${module.id}`);
      }
      for (const action of instance.actions ?? []) {
        if (!action || typeof action !== 'object') throw new RangeError('Invalid action descriptor');
        requireId(action.id, 'action');
        if (typeof action.run !== 'function') throw new RangeError(`Invalid action handler: ${action.id}`);
        if (actions.has(action.id)) throw new RangeError(`Duplicate action ID: ${action.id}`);
        actions.set(action.id, action);
      }
    }
    disconnect = bridge.connect(frame => {
      if (disposed) return;
      const failures: unknown[] = [];
      // Snapshot listeners so new subscriptions begin with the next frame;
      // removals and disposal take effect immediately during a broadcast.
      for (const subscription of [...subscriptions]) {
        if (disposed || !subscriptions.has(subscription)) continue;
        try { subscription.listener(frame); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'HUD telemetry subscribers failed');
    });
  } catch (error) {
    // Preserve the initialization failure, while still attempting every cleanup.
    cleanup();
    throw error;
  }

  const widgets = Object.freeze(descriptors);
  return {
    widgets: () => widgets,
    dispatch(actionId) {
      if (disposed) return false;
      const action = actions.get(actionId);
      if (!action) return false;
      action.run();
      return true;
    },
    dispose() {
      const failures = cleanup();
      if (failures.length > 0) throw new AggregateError(failures, 'HUD cleanup failed');
    },
  };
}
