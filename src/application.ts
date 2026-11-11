import type {
  HudModule, KeyBinding, KeyInput, RecordBook, RecordRepository, ReferenceMode, SectorDefinition,
  ModuleContext, StorageLike, TelemetryBridge, TimingFeature, TimingFrame, TimingView, WidgetSpec,
} from './contracts.ts';
import { createHudHost } from './module-host.ts';
import { createTimingFeature } from './timing-feature.ts';
import { createRecordRepository } from './records.ts';
import { DEFAULT_CONTINUITY_LIMITS } from './telemetry/continuity-settings.ts';

export interface ApplicationSnapshot {
  mode: ReferenceMode;
  view: TimingView;
  records: RecordBook | null;
  binding: KeyBinding;
  revision: number;
}

export interface ApplicationOptions {
  storage: StorageLike;
  bridge: TelemetryBridge;
  resolveDefinition(frame: TimingFrame): SectorDefinition | null;
  discoverModules(services: { timing: HudModule }): HudModule[];
  components?: { panel: unknown; delta: unknown };
  maxFrameGapMs?: number;
  maxDistanceStep?: number;
  finishTimeoutMs?: number;
}

export interface HudApplication {
  getSnapshot(): ApplicationSnapshot;
  subscribe(listener: () => void): () => void;
  widgets(): readonly WidgetSpec[];
  cycleReference(): void;
  setBinding(binding: KeyBinding): void;
  handleKey(input: KeyInput, layoutLocked: boolean): boolean;
  setEditing(editing: boolean): void;
  setWidgetEnabled(widget: 'panel' | 'delta', enabled: boolean): void;
  dispose(): void;
}

export function createHudApplication(options: ApplicationOptions): HudApplication {
  const listeners = new Set<() => void>();
  const enabled = { panel: true, delta: true };
  let editing = false;
  let disposed = false;
  let revision = 0;
  let snapshot: ApplicationSnapshot;
  let feature: TimingFeature;
  let instance: ReturnType<HudModule['create']>;
  let localListener: ((frame: TimingFrame) => void) | null = null;
  let activeLayoutId: number | null = null;
  let repository: RecordRepository | null = null;

  function publish(): void {
    if (disposed) return;
    snapshot = Object.freeze({
      mode: feature.mode(), view: feature.view(), records: feature.records(),
      binding: feature.binding(), revision: ++revision,
    });
    for (const listener of [...listeners]) listener();
  }

  function initialize(definition: SectorDefinition, context: ModuleContext): void {
    // Preferences and references remain application-lifetime state even when
    // browser storage is unavailable and timing internals change layouts.
    const previous = feature ? { mode: feature.mode(), binding: feature.binding() } : null;
    instance?.dispose();
    repository ??= createRecordRepository(context.storage);
    feature = createTimingFeature({
      definition,
      repository,
      maxFrameGapMs: options.maxFrameGapMs ?? DEFAULT_CONTINUITY_LIMITS.maxFrameGapMs,
      maxDistanceStep: options.maxDistanceStep ?? DEFAULT_CONTINUITY_LIMITS.maxDistanceStep,
      finishTimeoutMs: options.finishTimeoutMs ?? DEFAULT_CONTINUITY_LIMITS.finishTimeoutMs,
    });
    instance = feature.create({
      storage: context.storage,
      subscribe(listener) {
        localListener = listener;
        return () => { if (localListener === listener) localListener = null; };
      },
    });
    if (previous) {
      if (JSON.stringify(feature.binding()) !== JSON.stringify(previous.binding)) feature.setBinding(previous.binding);
      for (let attempts = 0; attempts < 3 && feature.mode() !== previous.mode; attempts++) {
        instance.actions?.find(action => action.id === 'timing.cycleReference')?.run();
      }
    }
    feature.setEditing(editing);
    feature.setWidgetEnabled('panel', enabled.panel);
    feature.setWidgetEnabled('delta', enabled.delta);
  }

  const timing: HudModule = {
    id: 'timing',
    create(context) {
      // Initialize preferences/commands without accepting telemetry into a
      // made-up layout. The real definition is selected before the first frame.
      initialize({ layoutId: 0, layoutLengthM: 1, boundaries: [0, 1] }, context);
      const descriptors = instance.widgets.map(widget => ({
        ...widget,
        component: options.components
          ? widget.id === 'timing.sectors' ? options.components.panel : options.components.delta
          : widget.component,
      }));
      const unsubscribe = context.subscribe(frame => {
        const player = frame.source === 'live' && frame.control === 'player'
          && frame.replay === false && frame.paused === false && frame.inMenus === false;
        let definition: SectorDefinition | null = null;
        if (player) {
          try { definition = options.resolveDefinition(frame); } catch {
            // An unreadable frozen-definition registry is not permission to
            // derive new geometry or to continue writing with stale metadata.
          }
        }
        if (definition !== null && definition.layoutId === frame.layoutId) {
          if (activeLayoutId !== definition.layoutId) {
            initialize(definition, context);
            activeLayoutId = definition.layoutId;
          }
          localListener?.(frame);
        } else if (activeLayoutId !== null) {
          // Unsupported/prohibited input must still interrupt an existing
          // capture, but can never initialize an unknown player combination.
          localListener?.(player ? { ...frame, source: 'debug' } : frame);
        }
        publish();
      });
      return {
        widgets: descriptors,
        actions: [{ id: 'timing.cycleReference', run() {
          instance.actions?.find(action => action.id === 'timing.cycleReference')?.run();
          publish();
        } }],
        dispose() { unsubscribe(); instance.dispose(); },
      };
    },
  };

  const host = createHudHost(options.discoverModules({ timing }), options.bridge, options.storage);
  publish();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    widgets: () => host.widgets(),
    cycleReference() { if (!disposed) host.dispatch('timing.cycleReference'); },
    setBinding(binding) { if (!disposed) { feature.setBinding(binding); publish(); } },
    handleKey(input, locked) {
      if (disposed) return false;
      const handled = feature.handleKey(input, locked);
      if (handled) publish();
      return handled;
    },
    setEditing(value) { if (!disposed) { editing = value; feature.setEditing(value); publish(); } },
    setWidgetEnabled(widget, value) {
      if (disposed) return;
      enabled[widget] = value;
      feature.setWidgetEnabled(widget, value);
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      host.dispose();
    },
  };
}
