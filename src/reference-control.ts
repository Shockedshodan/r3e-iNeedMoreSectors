import type { ReferenceController, StorageLike, TimingView, TimingViewOptions } from './contracts.ts';
import { notImplemented } from './not-implemented.ts';

export function createReferenceController(storage: StorageLike): ReferenceController {
  return notImplemented('createReferenceController');
}

export function createTimingView(options: TimingViewOptions): TimingView {
  return notImplemented('createTimingView');
}
