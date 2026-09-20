import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { Task, Workspace } from '@pfenerty/tektonic';
import type { BackendCtx, CacheBackend, TaskCacheSpec } from '@pfenerty/tektonic';
import { synthTask } from '@pfenerty/tektonic/testing';
import { gcs, DEFAULT_GCS_CACHE_IMAGE } from './gcs-backend';

/**
 * These tests used to live inside the core package, where `gcs()` was one import away from
 * the code it was testing. They now reach the backend the way any consumer does — through
 * `@pfenerty/tektonic`'s published surface — which is the point of shipping it separately.
 */

/**
 * What a project sets as `injectedStepImage`; a bare string declares every capability, and
 * these caches are compressed, so the injected steps need nushell/tar/zstd (and gcloud).
 */
const PROJECT_IMAGE = 'ghcr.io/example/ci-base:test';
const CAPABLE = { injectedStepImage: PROJECT_IMAGE } as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

/** Synthesizes the task and returns its steps, as the core tests' helper did. */
const steps = (t: Task): AnyObj[] => {
  const chart = new Chart(new App(), 'test');
  t.synth(chart, 'ns', CAPABLE);
  return (chart.toJson()[0] as AnyObj).spec.steps;
};

/** The named step, or a failure naming the ones that were emitted. */
const step = (t: Task, name: string): AnyObj => {
  const all = steps(t);
  const found = all.find((s: AnyObj) => s.name === name);
  if (!found) throw new Error(`no step '${name}'. Steps: ${all.map((s: AnyObj) => s.name).join(', ')}`);
  return found;
};

const cacheSpec = (backend: CacheBackend, extra: Partial<TaskCacheSpec> = {}): TaskCacheSpec => ({
  name: 'npm',
  key: ['package-lock.json'],
  paths: ['node_modules'],
  backend,
  ...extra,
});

const taskWith = (backend: CacheBackend, extra: Partial<TaskCacheSpec> = {}, name = 'build'): Task =>
  new Task({ name, steps: [{ name: 's', image: 'alpine' }], caches: [cacheSpec(backend, extra)] });

describe('GcsBackend image default', () => {
  it("names no image of its own: it asks the project's for gcloud", () => {
    const t = taskWith(gcs({ bucket: 'my-ci-cache' }), { compress: true });
    expect(step(t, 'restore-npm-cache').image).toBe(PROJECT_IMAGE);
    expect(step(t, 'save-npm-cache').image).toBe(PROJECT_IMAGE);
  });

  it('fails synthesis when the project image does not declare gcloud', () => {
    const t = taskWith(gcs({ bucket: 'my-ci-cache' }), { compress: true });
    expect(() =>
      t.synth(new Chart(new App(), 'test'), 'ns', {
        injectedStepImage: { image: 'ghcr.io/example/ci-base:test', provides: ['sh', 'git', 'nushell', 'tar', 'zstd'] },
      }),
    ).toThrow(/needs an image providing gcloud/);
  });

  it('DEFAULT_GCS_CACHE_IMAGE is the one-line way back to the old default', () => {
    const t = taskWith(gcs({ bucket: 'my-ci-cache', image: DEFAULT_GCS_CACHE_IMAGE }), { compress: true });
    expect(step(t, 'restore-npm-cache').image).toBe(DEFAULT_GCS_CACHE_IMAGE);
  });

  it('is overridable per backend instance', () => {
    const backend = gcs({ bucket: 'my-ci-cache', image: 'ghcr.io/example/gcloud:pinned' });
    expect(backend.image).toBe('ghcr.io/example/gcloud:pinned');
    expect(step(taskWith(backend, { compress: true }), 'restore-npm-cache').image).toBe(
      'ghcr.io/example/gcloud:pinned',
    );
  });

  it('still yields to spec.image', () => {
    const backend = gcs({ bucket: 'my-ci-cache', image: 'ghcr.io/example/gcloud:pinned' });
    const t = taskWith(backend, { compress: true, image: 'spec-image' });
    expect(step(t, 'restore-npm-cache').image).toBe('spec-image');
  });
});

describe('GCS cache backend', () => {
  const gcsCacheSpec = {
    name: 'npm',
    key: ['package-lock.json'],
    paths: ['node_modules'],
    compress: true,
    backend: gcs({ bucket: 'my-ci-cache', prefix: 'tekton/' }),
  };

  it('does not auto-add workspace for GCS cache', () => {
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    expect(t.workspaces).toHaveLength(0);
  });

  it('injects restore and save steps named after cache name', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 'run', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const names = chart.toJson()[0].spec.steps.map((s: any) => s.name);
    expect(names[0]).toBe('restore-npm-cache');
    expect(names[1]).toBe('run');
    expect(names[2]).toBe('save-npm-cache');
  });

  it('restore script uses gcloud storage ls for existence check', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(restore.script).toContain('gcloud storage ls $gcs_url | complete');
    expect(restore.script).not.toContain('metadata.google.internal');
    expect(restore.script).not.toContain('access_token');
  });

  it('restore script checks GCS object and uses prefix', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(restore.script).toContain('gcloud storage');
    expect(restore.script).toContain('my-ci-cache');
    expect(restore.script).toContain('tekton/');
  });

  it('restore script logs download speed', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(restore.script).toContain('MB/s');
    expect(restore.script).toContain('restored in');
  });

  it('save script uploads archive to GCS', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
    expect(save.script).toContain('gcloud storage cp');
    expect(save.script).toContain('my-ci-cache');
  });

  it('save script logs compression ratio and upload speed', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
    expect(save.script).toContain('ratio=');
    expect(save.script).toContain('MB/s');
    expect(save.script).toContain('uploaded ($gcs_url)');
  });

  it('save script evicts old entries via gcloud storage', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
    expect(save.script).toContain('gcloud storage ls -l');
    expect(save.script).toContain('let result = (^gcloud storage rm $e.url | complete)');
    expect(save.script).toContain('if $result.exit_code == 0');
    expect(save.script).toContain('warn: failed to evict');
    expect(save.script).toContain('sort-by created');
  });

  it('uses default GCS compression level (3)', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
    expect(save.script).toContain('zstd -3');
  });

  it('respects custom compression level', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [{ ...gcsCacheSpec, compressionLevel: 7 }],
    });
    t.synth(chart, 'ns', CAPABLE);
    const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
    expect(save.script).toContain('zstd -7');
  });

  it('save step has onError: continue', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
    expect(save.onError).toBe('continue');
  });

  it('GCS without prefix uses empty string', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const noPrefix = { ...gcsCacheSpec, backend: gcs({ bucket: 'my-bucket' }) };
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [noPrefix],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(restore.script).toContain('let object = $"($hash).tar.zst"');
  });

  it('forceSave removes the skip-existing check', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [{ ...gcsCacheSpec, forceSave: true }],
    });
    t.synth(chart, 'ns', CAPABLE);
    const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
    expect(save.script).not.toContain('exists, skipping');
  });

  it('uses hash file in pod-local path keyed by cache name', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(restore.script).toContain('/tekton/home/.cache-npm-hash');
  });

  it('getCacheFinallyTasks returns tasks without cache workspace for GCS', () => {
    const ws = new Workspace({ name: 'workspace' });
    const t = new Task({
      name: 'gcs-task',
      workspaces: [ws],
      steps: [{ name: 's', image: 'alpine' }],
      caches: [{ ...gcsCacheSpec, saveStrategy: 'finally' }],
    });
    const finallyTasks = t.getCacheFinallyTasks();
    expect(finallyTasks).toHaveLength(1);
    expect(finallyTasks[0].name).toBe('save-npm-cache-gcs-task');
    expect(finallyTasks[0].workspaces.map(w => w.name)).toEqual(['workspace']);
  });

  it("uses the project's injectedStepImage for GCS cache steps when the backend names none", () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-npm-cache');
    expect(restore.image).toBe(CAPABLE.injectedStepImage);
    expect(save.image).toBe(CAPABLE.injectedStepImage);
  });

  it('rejects a GCS cache whose project image does not declare gcloud', () => {
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [gcsCacheSpec],
    });
    expect(() => t.synth(new Chart(new App(), 'test'), 'ns')).toThrow(/needs an image providing nushell, tar, zstd, gcloud/);
    expect(() =>
      t.synth(new Chart(new App(), 'test2'), 'ns', {
        injectedStepImage: { image: DEFAULT_GCS_CACHE_IMAGE, provides: ['gcloud', 'nushell', 'tar', 'zstd'] },
      }),
    ).not.toThrow();
  });

  it('respects custom image override for GCS steps', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [{ ...gcsCacheSpec, image: 'my-custom-image:latest' }],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(restore.image).toBe('my-custom-image:latest');
  });

  it('empty key produces static hash', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [{ ...gcsCacheSpec, key: [] }],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(restore.script).toContain('"" | hash sha256');
  });

  it('propagates workingDir to cache steps', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [{ ...gcsCacheSpec, workingDir: '$(workspaces.workspace.path)' }],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(restore.workingDir).toBe('$(workspaces.workspace.path)');
  });

  it('restore script handles subdirectory paths in cache_paths', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const subdirSpec = {
      name: 'go',
      key: ['api/go.sum'],
      paths: ['api/vendor'],
      compress: true,
      backend: gcs({ bucket: 'my-ci-cache' }),
      workingDir: '$(workspaces.workspace.path)',
    };
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [subdirSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-go-cache');
    expect(restore.script).toContain('"api/vendor"');
    expect(restore.script).toContain('"api/go.sum"');
    // Extraction goes through a staging dir and the path is swapped in, never deleted
    // in place — a concurrent task on the same workspace may be reading it.
    expect(restore.script).toContain('tar xf - -C $stage');
    expect(restore.script).toContain('mv $staged $p');
    expect(restore.script).not.toContain('rm -rf $p');
  });

  it('save script handles subdirectory paths', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const subdirSpec = {
      name: 'go',
      key: ['api/go.sum'],
      paths: ['api/vendor'],
      compress: true,
      backend: gcs({ bucket: 'my-ci-cache' }),
      workingDir: '$(workspaces.workspace.path)',
    };
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [subdirSpec],
    });
    t.synth(chart, 'ns', CAPABLE);
    const save = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'save-go-cache');
    expect(save.script).toContain('"api/vendor"');
    expect(save.script).toContain('tar cf - ...$paths');
  });

  it('supports multiple caches for different subdirectory projects', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const goCache = {
      name: 'go',
      key: ['api/go.sum'],
      paths: ['api/vendor'],
      compress: true,
      backend: gcs({ bucket: 'my-ci-cache' }),
      workingDir: '$(workspaces.workspace.path)',
    };
    const npmCache = {
      name: 'npm',
      key: ['web/package-lock.json'],
      paths: ['web/node_modules'],
      compress: true,
      backend: gcs({ bucket: 'my-ci-cache' }),
      workingDir: '$(workspaces.workspace.path)',
    };
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [goCache, npmCache],
    });
    t.synth(chart, 'ns', CAPABLE);
    const steps = chart.toJson()[0].spec.steps;
    const goRestore = steps.find((s: any) => s.name === 'restore-go-cache');
    const npmRestore = steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(goRestore).toBeDefined();
    expect(npmRestore).toBeDefined();
    expect(goRestore.script).toContain('api/go.sum');
    expect(goRestore.script).toContain('"api/vendor"');
    expect(npmRestore.script).toContain('web/package-lock.json');
    expect(npmRestore.script).toContain('"web/node_modules"');
  });

  it('propagates computeResources to cache steps', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const resources = { requests: { cpu: '50m', memory: '64Mi' } };
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [{ ...gcsCacheSpec, computeResources: resources }],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(restore.computeResources).toEqual(resources);
  });

  it('respects custom image', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'gcs-task',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [{ ...gcsCacheSpec, image: 'custom:latest' }],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(restore.image).toBe('custom:latest');
  });
});

describe('multiThreadCompression', () => {
  it('defaults to -T0 for GCS backend', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'c',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'], compress: true, backend: gcs({ bucket: 'my-bucket' }) }],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(restore.script).toContain('-T0');
  });

  it('GCS backend can be overridden to -T1', () => {
    const app = new App();
    const chart = new Chart(app, 'test');
    const t = new Task({
      name: 'c',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'], compress: true, backend: gcs({ bucket: 'my-bucket' }), multiThreadCompression: false }],
    });
    t.synth(chart, 'ns', CAPABLE);
    const restore = chart.toJson()[0].spec.steps.find((s: any) => s.name === 'restore-npm-cache');
    expect(restore.script).toContain('-T1');
  });
});

describe('script language routing', () => {
  const rendered = (spec: Partial<TaskCacheSpec>) => {
    const t = new Task({
      name: 'c',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [cacheSpec(gcs({ bucket: 'my-bucket' }), { compress: true, ...spec })],
    });
    return { restore: step(t, 'restore-npm-cache').script, save: step(t, 'save-npm-cache').script };
  };

  it('routes through the nushell plugin preamble rather than a hand-written shebang', () => {
    const { restore, save } = rendered({});
    for (const script of [restore, save]) {
      expect(script.match(/#!\/usr\/bin\/env nu/g)).toHaveLength(1);
      expect(script).toContain("def log [msg: string] { print $\"[(date now | format date '%H:%M:%S')] ($msg)\" }");
    }
    expect(restore).toContain('restore-npm-cache: checking');
    expect(save).toContain('save-npm-cache: uploading');
  });
});

describe('capability checking through the published seam', () => {
  const npmCache = (extra: Record<string, unknown> = {}) => ({
    name: 'npm',
    key: ['package-lock.json'],
    paths: ['node_modules'],
    compress: true,
    ...extra,
  });

  it('holds a GCS cache to gcloud, and DEFAULT_GCS_CACHE_IMAGE satisfies it', () => {
    const task = new Task({
      name: 'c',
      steps: [{ name: 's', image: 'alpine' }],
      caches: [npmCache({ backend: gcs({ bucket: 'b' }) })],
    });
    expect(() =>
      synthTask(task, { injectedStepImage: { image: PROJECT_IMAGE, provides: ['nushell', 'tar', 'zstd'] } }),
    ).toThrow(/providing gcloud/);
    expect(() =>
      synthTask(
        new Task({
          name: 'c2',
          steps: [{ name: 's', image: 'alpine' }],
          caches: [npmCache({ backend: gcs({ bucket: 'b', image: DEFAULT_GCS_CACHE_IMAGE }) })],
        }),
      ),
    ).not.toThrow();
  });
});

describe('concurrent restore on a shared workspace', () => {
  // The production failure this guards: a restore rm -rf'd the module cache while another
  // task on the same workspace was compiling against it. Core tests the same property for
  // the PVC backend; this is the GCS half, and it comes from the shared `stagedExtract`
  // helper the core package publishes for exactly this reason.
  it('extracts into a staging dir and swaps each path in, never deleting in place', () => {
    const ws = new Workspace({ name: 'workspace' });
    const t = new Task({
      name: 'go-test',
      workspaces: [ws],
      steps: [{ name: 's', image: 'go' }],
      caches: [
        {
          name: 'go',
          key: ['go.sum'],
          paths: ['.go-mod', '.go-build'],
          compress: true,
          workingDir: `$(workspaces.${ws.name}.path)`,
          backend: gcs({ bucket: 'ci-cache' }),
        },
      ],
    });
    const script = step(t, 'restore-go-cache').script;
    expect(script).toContain('tar xf - -C $stage');
    expect(script).not.toContain('rm -rf $p');
  });
});

describe('BackendCtx', () => {
  it('reaches the backend carrying nothing provider-specific', () => {
    const seen: BackendCtx[] = [];
    const spy: CacheBackend = {
      type: 'spy',
      needsPvcWorkspace: false,
      restoreStep(spec, ctx) {
        seen.push(ctx);
        return gcs({ bucket: 'b' }).restoreStep(spec, ctx);
      },
      saveStep(spec, ctx) {
        seen.push(ctx);
        return gcs({ bucket: 'b' }).saveStep(spec, ctx);
      },
    };
    steps(taskWith(spy, { compress: true }, 'compile'));
    expect(seen.length).toBeGreaterThan(0);
    for (const ctx of seen) {
      expect(Object.keys(ctx).sort()).toEqual(['defaultImage', 'taskName']);
      expect(ctx.taskName).toBe('compile');
    }
  });
});
