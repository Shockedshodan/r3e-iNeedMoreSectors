import type { HudModule } from '../../contracts.ts';
import type { ModuleServices } from '../../discover-modules.ts';

export function createModule(services: ModuleServices): HudModule {
  return services.timing;
}
