import type {
  Combination, RecordRepository, ReferenceController, TimingEngine, TimingFeature,
  TimingFeatureOptions, TimingFrame, WidgetSpec,
} from './contracts.ts';
import { createRecordRepository } from './records.ts';
import { createReferenceController, createTimingView } from './reference-control.ts';
import { createTimingEngine } from './timing-engine.ts';

/** Headless timing module. Rendered widgets and the raw bridge adapter follow separately. */
export function createTimingFeature(options: TimingFeatureOptions): TimingFeature {
  let active = false;
  let generation = 0;
  let controller: ReferenceController | null = null;
  let repository: RecordRepository | null = null;
  let engine: TimingEngine | null = null;
  let identity: string | null = null;
  let latestFrame: Pick<TimingFrame, 'lapElapsedUs' | 'distanceFraction'> | null = null;
  const enabled = { panel: true, delta: true };
  let widgets: WidgetSpec[] = [];
  const combinations = new Map<string, Combination>();

  function consume(frame: TimingFrame): void {
    if (!active) return;

    const supportedCombination = frame.layoutId === options.definition.layoutId &&
      Number.isSafeInteger(frame.modelId) && frame.modelId >= 0 &&
      typeof frame.sessionId === 'string' && frame.sessionId.length > 0;
    if (!supportedCombination) {
      engine?.dispose();
      engine = null;
      identity = null;
      latestFrame = null;
      return;
    }

    const playerFrame = frame.source === 'live' && frame.control === 'player' &&
      !frame.replay && !frame.paused && !frame.inMenus;
    if (!playerFrame) {
      // A prohibited observation must still interrupt any active/pending capture.
      // It must never choose or initialize a new player record combination.
      engine?.consume(frame);
      latestFrame = null;
      return;
    }

    // Retry only previously validated, unsaved improvements. Ordinary frames
    // with no dirty entry do not produce writes or retain non-record laps.
    for (const combination of combinations.values()) {
      if (repository!.isDirty(combination)) repository!.flush(combination);
    }

    const nextIdentity = JSON.stringify([frame.sessionId, frame.layoutId, frame.modelId]);
    if (identity !== nextIdentity) {
      engine?.dispose();
      const combination = { layoutId: frame.layoutId, modelId: frame.modelId };
      const records = repository!.load(combination, options.definition);
      combinations.set(JSON.stringify(combination), combination);
      engine = createTimingEngine({
        ...options,
        initialRecords: records,
        onImprovement(_update, candidate) {
          // Persist the actual complete captured lap. A stitched Opt reference
          // is never a real candidate and must not be promoted to Best.
          repository!.consider(candidate, options.definition);
        },
      });
      identity = nextIdentity;
    } else {
      // A denied startup read may have recovered during the retry above.
      // Synchronize better saved references without restarting this capture
      // or replacing its lap-start comparison snapshot.
      engine!.synchronizeRecords(repository!.load(frame, options.definition));
    }
    // Bridges may reuse and mutate their frame object after delivery. Keep only
    // the scalar comparison inputs from this observation for the view model.
    latestFrame = {
      lapElapsedUs: frame.lapElapsedUs,
      distanceFraction: frame.distanceFraction,
    };
    engine!.consume(frame);
  }

  return {
    id: 'timing',
    create(context) {
      if (active) throw new Error('Timing module is already active');
      repository = createRecordRepository(context.storage);
      controller = createReferenceController(context.storage);
      engine = null;
      identity = null;
      latestFrame = null;
      combinations.clear();
      widgets = [
        {
          id: 'timing.sectors', component: () => null,
          defaults: { x: 0, y: -200, scale: 1, enabled: enabled.panel },
        },
        {
          id: 'timing.delta', component: () => null,
          defaults: { x: 0, y: -150, scale: 1, enabled: enabled.delta },
        },
      ];
      active = true;
      const currentGeneration = ++generation;
      let unsubscribe: () => void;
      try {
        unsubscribe = context.subscribe(consume);
      } catch (error) {
        active = false;
        throw error;
      }
      return {
        widgets,
        actions: [{
          id: 'timing.cycleReference',
          run() {
            if (active && generation === currentGeneration) controller!.cycle();
          },
        }],
        dispose() {
          if (!active || generation !== currentGeneration) return;
          active = false;
          unsubscribe();
          engine?.dispose();
          for (const combination of combinations.values()) {
            if (repository!.isDirty(combination)) repository!.flush(combination);
          }
        },
      };
    },
    mode() {
      return controller?.mode() ?? 'off';
    },
    view() {
      return createTimingView({
        mode: controller?.mode() ?? 'off',
        snapshot: engine?.comparisonSnapshot() ?? {
          schemaVersion: 1, layoutId: options.definition.layoutId,
          modelId: -1, boundaries: options.definition.boundaries, best: null, opt: null,
        },
        lapElapsedUs: latestFrame?.lapElapsedUs ?? -1,
        distanceFraction: latestFrame?.distanceFraction ?? -1,
        panelEnabled: enabled.panel, deltaEnabled: enabled.delta,
        editing: false,
      });
    },
    records() {
      return engine?.records() ?? null;
    },
    setWidgetEnabled(widget, value) {
      enabled[widget] = value;
      const id = widget === 'panel' ? 'timing.sectors' : 'timing.delta';
      const descriptor = widgets.find(item => item.id === id);
      if (descriptor) descriptor.defaults.enabled = value;
    },
  };
}
