import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import type { Configuration, Stats } from 'webpack';
import type { HudModule } from '../src/contracts.ts';
import { modulesFromContext } from '../src/discover-modules.ts';
import { createModule } from '../src/modules/timing/module.ts';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

function module(id: string): HudModule {
  return { id, create: () => ({ widgets: [], dispose() {} }) };
}

test('the timing descriptor uses the supplied live feature instance', () => {
  const timing = module('timing');
  assert.equal(createModule({ timing }), timing);
});

test('module discovery loads descriptors in deterministic path order without a registry', () => {
  const timing = module('timing');
  const clock = module('clock');
  const exports: Record<string, unknown> = {
    './timing/module.ts': { createModule: () => timing },
    './clock/module.ts': { createModule: () => clock },
  };
  const context = Object.assign((key: string) => exports[key], { keys: () => Object.keys(exports) });
  assert.deepEqual(modulesFromContext(context, { timing }), [clock, timing]);
});

test('a module without its factory reports the offending path', () => {
  const context = Object.assign(() => ({ label: 'not a module' }), { keys: () => ['./broken/module.ts'] });
  assert.throws(() => modulesFromContext(context, { timing: module('timing') }), /broken\/module\.ts.*createModule/);
});

test('duplicate module IDs fail before a host can register conflicting actions or widgets', () => {
  const context = Object.assign(() => ({ createModule: () => module('duplicate') }), {
    keys: () => ['./one/module.ts', './two/module.ts'],
  });
  assert.throws(() => modulesFromContext(context, { timing: module('timing') }), /duplicate/i);
});

async function compile(configuration: Configuration): Promise<void> {
  const webpack = require('webpack') as typeof import('webpack');
  await new Promise<void>((resolve, reject) => {
    const compiler = webpack(configuration);
    compiler.run((error: Error | null | undefined, stats?: Stats) => {
      compiler.close(closeError => {
        if (error || closeError) reject(error || closeError);
        else if (!stats || stats.hasErrors()) reject(new Error(stats?.toString({ all: false, errors: true }) ?? 'No build result'));
        else resolve();
      });
    });
  });
}

test('adding a module folder and rebuilding registers its widget without changing discovery or host code', async () => {
  const outputRoot = path.join(projectRoot, '.test-results');
  await mkdir(outputRoot, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(outputRoot, 'module-discovery-'));
  const sourceRoot = path.join(fixtureRoot, 'src');
  try {
    await mkdir(path.join(sourceRoot, 'modules', 'timing'), { recursive: true });
    for (const filename of ['discover-modules.ts', 'module-host.ts', 'contracts.ts']) {
      await copyFile(path.join(projectRoot, 'src', filename), path.join(sourceRoot, filename));
    }
    await copyFile(path.join(projectRoot, 'src/modules/timing/module.ts'), path.join(sourceRoot, 'modules/timing/module.ts'));
    const entry = path.join(sourceRoot, 'entry.ts');
    await writeFile(entry, `
      import { discoverModules } from './discover-modules.ts';
      import { createHudHost } from './module-host.ts';
      const timing = { id: 'timing', create: () => ({
        widgets: [{id:'timing.sectors',component:()=>'<section>Timing</section>',defaults:{x:0,y:0,scale:1,enabled:true}}],dispose(){}
      })};
      const modules = discoverModules({timing});
      const host = createHudHost(modules, {connect(){return ()=>{}}}, {getItem(){return null},setItem(){}});
      globalThis.discoveryResult = {
        modules: modules.map(module => module.id),
        widgets: host.widgets().map(widget => widget.id),
        rendered: host.widgets().map(widget => widget.component()).join('')
      };
      host.dispose();
    `);
    const createConfig = require('../webpack.config.cjs') as (env: Record<string, unknown>, argv: { mode: string }) => Configuration;
    const configuration = createConfig({ entry, outputPath: path.join(fixtureRoot, 'dist'), html: false }, { mode: 'development' });
    configuration.devtool = false;
    const beforeDiscovery = await readFile(path.join(sourceRoot, 'discover-modules.ts'), 'utf8');
    const beforeHost = await readFile(path.join(sourceRoot, 'module-host.ts'), 'utf8');
    async function buildResult(): Promise<{ modules: string[]; widgets: string[]; rendered: string }> {
      await compile(configuration);
      const sandbox: Record<string, unknown> = {};
      runInNewContext(await readFile(path.join(fixtureRoot, 'dist/app.js'), 'utf8'), sandbox);
      return JSON.parse(JSON.stringify(sandbox.discoveryResult));
    }
    assert.deepEqual(await buildResult(), {
      modules: ['timing'], widgets: ['timing.sectors'], rendered: '<section>Timing</section>',
    });
    await mkdir(path.join(sourceRoot, 'modules', 'clock'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'modules/clock/module.ts'), `
      export function createModule() { return {id:'clock',create(){return {
        widgets:[{id:'clock.time',component:()=>'<output>12:34</output>',defaults:{x:10,y:20,scale:1,enabled:true}}],dispose(){}
      }}}; }
    `);
    assert.deepEqual(await buildResult(), {
      modules: ['clock', 'timing'], widgets: ['clock.time', 'timing.sectors'],
      rendered: '<output>12:34</output><section>Timing</section>',
    });
    assert.equal(await readFile(path.join(sourceRoot, 'discover-modules.ts'), 'utf8'), beforeDiscovery);
    assert.equal(await readFile(path.join(sourceRoot, 'module-host.ts'), 'utf8'), beforeHost);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('production output preserves the complete SealHUD license and upstream attribution', async () => {
  const outputRoot = path.join(projectRoot, '.test-results');
  await mkdir(outputRoot, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(outputRoot, 'distribution-notices-'));
  try {
    const entry = path.join(fixtureRoot, 'entry.js');
    await writeFile(entry, 'globalThis.exampleWidget = "registered";');
    const createConfig = require('../webpack.config.cjs') as (env: Record<string, unknown>, argv: { mode: string }) => Configuration;
    await compile(createConfig({ entry, outputPath: path.join(fixtureRoot, 'dist'), html: false }, { mode: 'production' }));
    const emitted = await readFile(path.join(fixtureRoot, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
    const license = await readFile(path.join(projectRoot, 'LICENSES/SealHUD-MIT.txt'), 'utf8');
    assert.ok(emitted.includes(license), 'the full upstream license is shipped unmodified');
    assert.match(emitted, /Copyright \(c\) 2026 Diego Junges and contributors/);
    assert.match(emitted, /github\.com\/sealhud\/sealhud_source\/tree\/d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b/);
    const bundle = await readFile(path.join(fixtureRoot, 'dist/app.js'), 'utf8');
    assert.match(bundle, /THIRD_PARTY_NOTICES\.txt/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
