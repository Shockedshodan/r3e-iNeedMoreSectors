/** Deliberate RED-phase seam. Replace feature-by-feature after its tests are red. */
export function notImplemented(feature: string): never {
  throw new Error(`Not implemented: ${feature}`);
}
