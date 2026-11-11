export interface ContinuityLimits {
  maxFrameGapMs: number;
  maxDistanceStep: number;
  finishTimeoutMs: number;
}

// Operational interruption bounds, shared by the HUD, adapter and replay.
// One continuous capture is not enough to tighten these into portable safety
// bounds. Evidence describes the headroom; it never authorizes record writes.
export const DEFAULT_CONTINUITY_LIMITS: Readonly<ContinuityLimits> = Object.freeze({
  maxFrameGapMs: 300,
  maxDistanceStep: 0.3,
  finishTimeoutMs: 500,
});

export function describeContinuitySettings(overrides: Partial<ContinuityLimits> = {}) {
  const maxFrameGapMs = overrides.maxFrameGapMs ?? DEFAULT_CONTINUITY_LIMITS.maxFrameGapMs;
  const maxDistanceStep = overrides.maxDistanceStep ?? DEFAULT_CONTINUITY_LIMITS.maxDistanceStep;
  const finishTimeoutMs = overrides.finishTimeoutMs ?? DEFAULT_CONTINUITY_LIMITS.finishTimeoutMs;
  // Recomputed from adjacent original receipts, not from sparse fixture windows
  // or the document being diagnosed. Nearest-rank percentiles retain outliers.
  // Return fresh evidence so modifying one report cannot affect another run.
  const evidence = {
    captureId: 'f489307d-60e5-4188-9e9b-fce95b169b88',
    sha256: '67e59c0b3f83e05e4d0d1989fef1507bc83342788799cc40ea87ea3ba32cb88b',
    receiveGaps: {
      count: 56938, minMs: 1.1000001430511475, maxMs: 42.10000014305115,
      meanMs: 16.707743510485088, p50Ms: 16.59999990463257,
      p95Ms: 17.800000190734863, p99Ms: 18.299999952316284,
    },
    uniqueSimulationUpdateGaps: {
      count: 56929, minMs: 1.1000001430511475, maxMs: 49.700000047683716,
      meanMs: 16.710384865358606, p50Ms: 16.59999990463257,
      p95Ms: 17.800000190734863, p99Ms: 18.299999952316284,
    },
    movement: {
      sampleCount: 29476,
      maxDistanceStep: 0.0010256099999999962,
      maxDistanceM: 7.158431286800374,
      p50DistanceStep: 0.0001315000000000066,
      p95DistanceStep: 0.00022481399999998986,
      p99DistanceStep: 0.00023236900000001004,
      p50DistanceM: 0.9178281356600462,
      p95DistanceM: 1.5691301482148892,
      p99DistanceM: 1.62186164300523,
      maxDistanceSeq: 10972,
      filtering: 'Adjacent original message receipts only; reset adjacency on every non-message event. '
        + 'Require the same connection and identity (LayoutId, ModelId, SessionType, SessionIteration, EventIndex). '
        + 'Both ends must be active player practice, LapValidState=0, with finite nonnegative current clocks, '
        + 'integral nonnegative lap counts, fractions in [0,1], positive finite LayoutLength and finite GameSimulationTime. '
        + 'Exclude count changes/wraps, then non-advancing simulation clocks, then backward current clocks or distance. '
        + 'Retain zero steps and every positive outlier without a speed or candidate-threshold filter. '
        + 'DistanceM uses the latter LayoutLength; percentiles use nearest rank.',
      excludedPairCounts: {
        identity: 0, inactiveInvalidUnavailable: 27446, countBoundary: 2,
        nonAdvancingSimulation: 6, backwardClockOrDistance: 8,
      },
    },
  };
  return {
    maxFrameGapMs, maxDistanceStep, finishTimeoutMs, evidence,
    margins: {
      maxFrameGapMs: {
        observations: [
          { statistic: 'receiveGaps.maxMs', value: evidence.receiveGaps.maxMs },
          { statistic: 'uniqueSimulationUpdateGaps.maxMs', value: evidence.uniqueSimulationUpdateGaps.maxMs },
        ],
        calculation: `${maxFrameGapMs} ms limit - receiveGaps.maxMs (${evidence.receiveGaps.maxMs}) = `
          + `${maxFrameGapMs - evidence.receiveGaps.maxMs} ms receipt headroom; `
          + `${maxFrameGapMs} - uniqueSimulationUpdateGaps.maxMs (${evidence.uniqueSimulationUpdateGaps.maxMs}) = `
          + `${maxFrameGapMs - evidence.uniqueSimulationUpdateGaps.maxMs} ms source-update headroom.`,
        selectedLimit: maxFrameGapMs,
        justification: 'Retain the operational gap bound unless explicitly overridden. The captured maxima leave jitter '
          + 'headroom but one uninterrupted trace cannot establish a worst-case load margin or justify a tighter portable bound.',
      },
      maxDistanceStep: {
        observations: [{ statistic: 'movement.maxDistanceStep', value: evidence.movement.maxDistanceStep }],
        calculation: `${maxDistanceStep} limit - movement.maxDistanceStep (${evidence.movement.maxDistanceStep}) = `
          + `${maxDistanceStep - evidence.movement.maxDistanceStep} normalized distance headroom.`,
        selectedLimit: maxDistanceStep,
        justification: 'Retain the coarse operational discontinuity bound unless explicitly overridden. Its large margin '
          + 'above observed movement is not an accuracy tolerance: one captured car/layout and receipt cadence do not '
          + 'establish a portable movement maximum across track lengths, speeds and observation gaps.',
      },
      finishTimeoutMs: {
        kind: 'provisional', fallbackMs: finishTimeoutMs,
        justification: 'Authoritative finish finality is not established by the capture. Retain the provisional 500 ms '
          + 'association fallback unless explicitly overridden; observed result latency or stability is not a finality bound.',
      },
    },
    rounding: {
      secondsToMicroseconds: 'nearest', additionalToleranceUs: 0,
      nativePrecision: 'Captured decimal-second clocks retain sub-millisecond values (including totals 149494965 and '
        + '149835876 microseconds). Native source precision is unestablished; round cumulative clocks to the nearest '
        + 'integer microsecond before subtraction and require exact agreement with the rounded total.',
    },
    evidenceGaps: [
      'Authoritative finish finality and worst-case result delay are unmeasured; unchanged/tied results remain ambiguous.',
      'Worst-case load, polling jitter and movement across other car/layout combinations are unmeasured.',
      'Controlled disconnect/reconnect, reset, pause/menu/pit and identity-change scenarios are missing from this continuous trace.',
      'Independent final validity, delta accuracy and native clock precision are not established by captured telemetry.',
    ],
  };
}

export type ContinuitySettings = ReturnType<typeof describeContinuitySettings>;
