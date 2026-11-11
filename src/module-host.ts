import type { HudHost, HudModule, StorageLike, TelemetryBridge } from './contracts.ts';
import { notImplemented } from './not-implemented.ts';

export function createHudHost(modules: readonly HudModule[], bridge: TelemetryBridge, storage: StorageLike): HudHost {
  return notImplemented('createHudHost');
}
