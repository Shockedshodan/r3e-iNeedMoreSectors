/** Timing and module contracts. Units and normalization are in docs/TDD_PLAN.md. */
export interface Combination {
  layoutId: number;
  modelId: number;
}

export interface SectorDefinition {
  layoutId: number;
  layoutLengthM: number;
  boundaries: readonly number[];
}

/** Sector-local normalized distance and elapsed microseconds. */
export interface CurvePoint {
  fraction: number;
  elapsedUs: number;
}

export interface SectorReference {
  durationUs: number;
  curve: readonly CurvePoint[];
}

export interface LapReference {
  totalUs: number;
  sectors: readonly SectorReference[];
}

export interface RecordBook extends Combination {
  schemaVersion: 1;
  boundaries: readonly number[];
  best: LapReference | null;
  opt: LapReference | null;
}

export interface LapCandidate extends Combination {
  complete: boolean;
  valid: boolean;
  boundaries: readonly number[];
  reference: LapReference;
}

export interface RecordUpdate {
  records: RecordBook;
  bestChanged: boolean;
  optChanged: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RecordRepository {
  load(combination: Combination, definition: SectorDefinition): RecordBook;
  consider(candidate: LapCandidate, definition: SectorDefinition): RecordUpdate;
  isDirty(combination: Combination): boolean;
  flush(combination: Combination): boolean;
}

/** An adapter-proven association, NOT a field supplied by the native R3E API. */
export interface FinishResult extends Combination {
  sessionId: string;
  completedLap: number;
  valid: boolean | null;
  totalUs: number;
  /** Normalized independent native sector durations, not raw cumulative fields. */
  officialSectorDurationsUs: readonly number[];
}

/** Normalized player telemetry from the adapter or synthetic fixtures. Live record writes remain gated. */
export interface TimingFrame extends Combination {
  sessionId: string;
  observedAtMs: number;
  completedLaps: number;
  distanceFraction: number;
  lapElapsedUs: number;
  currentLapValid: boolean | null;
  source: 'live' | 'debug';
  control: 'player' | 'ai' | 'remote';
  replay: boolean;
  paused: boolean;
  inMenus: boolean;
  /** Null until freshness and identity are proven by the bridge adapter. */
  finishResult: FinishResult | null;
}

export interface TimingEngineOptions {
  definition: SectorDefinition;
  initialRecords: RecordBook;
  maxFrameGapMs: number;
  maxDistanceStep: number;
  finishTimeoutMs: number;
  onImprovement(update: RecordUpdate, candidate: LapCandidate): void;
  /** Diagnostic acceptance of normalized captured laps, independent of records. */
  onLapAccepted?: (candidate: LapCandidate, result: FinishResult) => void;
}

export interface TimingEngine {
  consume(frame: TimingFrame): void;
  synchronizeRecords(recovered: RecordBook): void;
  records(): RecordBook;
  comparisonSnapshot(): RecordBook;
  pendingFinishCount(): number;
  dispose(): void;
}

export type ReferenceMode = 'off' | 'opt' | 'best';
export interface KeyBinding {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}
export interface KeyInput extends KeyBinding {
  repeat: boolean;
  target: { tagName: string; isContentEditable: boolean } | null;
}
export interface ReferenceController {
  mode(): ReferenceMode;
  binding(): KeyBinding;
  setBinding(binding: KeyBinding): void;
  cycle(): void;
  handleKey(event: KeyInput, layoutLocked: boolean): boolean;
}

export interface TimingViewOptions {
  mode: ReferenceMode;
  snapshot: RecordBook;
  lapElapsedUs: number;
  distanceFraction: number;
  panelEnabled: boolean;
  deltaEnabled: boolean;
  editing: boolean;
}
export interface TimingView {
  panel: { visible: boolean; preview: boolean; reference: LapReference | null };
  delta: { visible: boolean; preview: boolean; reference: LapReference | null; valueUs: number | null };
}

export interface WidgetSpec {
  id: string;
  component: unknown;
  defaults: { x: number; y: number; scale: number; enabled: boolean };
}
export interface ActionSpec { id: string; run(): void }
export interface ModuleContext {
  subscribe(listener: (frame: TimingFrame) => void): () => void;
  storage: StorageLike;
}
export interface HudModule {
  id: string;
  create(context: ModuleContext): {
    widgets: WidgetSpec[];
    actions?: ActionSpec[];
    dispose(): void;
  };
}
export interface TelemetryBridge {
  connect(listener: (frame: TimingFrame) => void): () => void;
}
export interface HudHost {
  widgets(): readonly WidgetSpec[];
  dispatch(actionId: string): boolean;
  dispose(): void;
}

export interface TimingFeatureOptions {
  definition: SectorDefinition;
  /** Shared application-lifetime records preserve unsaved references across layout changes. */
  repository?: RecordRepository;
  maxFrameGapMs: number;
  maxDistanceStep: number;
  finishTimeoutMs: number;
}
export interface TimingFeature extends HudModule {
  mode(): ReferenceMode;
  binding(): KeyBinding;
  setBinding(binding: KeyBinding): void;
  handleKey(event: KeyInput, layoutLocked: boolean): boolean;
  setEditing(editing: boolean): void;
  view(): TimingView;
  records(): RecordBook | null;
  setWidgetEnabled(widget: 'panel' | 'delta', enabled: boolean): void;
}
