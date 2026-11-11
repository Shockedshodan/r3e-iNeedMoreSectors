import type { HudModule } from './contracts.ts';

export interface ModuleServices { timing: HudModule }
export interface ModuleContext {
  keys(): string[];
  (path: string): unknown;
}

declare const require: {
  context(directory: string, recursive: boolean, filter: RegExp): ModuleContext;
};

export function modulesFromContext(context: ModuleContext, services: ModuleServices): HudModule[] {
  const ids = new Set<string>();
  return context.keys().sort().map(path => {
    const exported = context(path) as { createModule?: unknown } | null;
    if (!exported || typeof exported.createModule !== 'function') {
      throw new TypeError(`Module ${path} must export createModule`);
    }
    const module = (exported.createModule as (services: ModuleServices) => HudModule)(services);
    if (!module || typeof module.id !== 'string' || module.id.trim().length === 0 || typeof module.create !== 'function') {
      throw new TypeError(`Module ${path} returned an invalid HUD descriptor`);
    }
    if (ids.has(module.id)) throw new RangeError(`Duplicate module ID ${module.id} from ${path}`);
    ids.add(module.id);
    return module;
  });
}

export function discoverModules(services: ModuleServices): HudModule[] {
  // Webpack resolves this literal directory recursively at build time. New
  // modules need only their folder and descriptor, followed by a rebuild.
  return modulesFromContext(require.context('./modules', true, /\/module\.ts$/), services);
}
