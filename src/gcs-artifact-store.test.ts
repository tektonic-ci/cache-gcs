import { describe, it, expect, vi, afterEach } from 'vitest';
import { App, Chart } from 'cdk8s';
import { Pipeline, Task, TektonicProject, Workspace, WorkspaceArtifactStore, defineAction, sh } from '@tektonic-ci/core';
import type { TaskStepSpec } from '@tektonic-ci/core';
import { synthTask } from '@tektonic-ci/core/testing';
import {
  gcsArtifacts,
  GcsArtifactStore,
  DEFAULT_GCS_ARTIFACT_RUN_KEY,
  GCS_ARTIFACT_LOCAL_DIR,
} from './gcs-artifact-store';

/**
 * Like the cache backend's tests, these reach the store through `@tektonic-ci/core`'s
 * published surface — the point of shipping it outside the core package is that the
 * `ArtifactStore` seam is exercised by an implementation with no in-tree privileges.
 */

/** A project image trusted for every capability; these steps need gcloud/nushell/tar/zstd. */
const CAPABLE = { injectedStepImage: 'ghcr.io/example/ci-base:test' } as const;

const step = (name: string, script = sh`true`): TaskStepSpec => ({ name, image: 'alpine', script });

const compile = defineAction<void, 'bundle'>({
  name: 'compile',
  image: 'ghcr.io/example/node:24',
  outputs: { bundle: 'app.tar' },
  steps: ({ name, outputs }) => [{ name, script: sh`tar cf ${outputs.bundle} dist` }],
});

/** The same producer/consumer pair, built against whichever store is passed. */
const pair = (store?: GcsArtifactStore) => {
  const source = new Workspace({ name: 'source' });
  const build = new Task({
    name: 'build',
    steps: [compile()],
    ...(store ? { artifactStore: store } : { workspaces: [source] }),
    produces: { dist: compile().outputs.bundle.toArtifact() },
  });
  const test = new Task({
    name: 'test',
    needs: [build],
    consumes: [build.artifacts.dist],
    steps: [step('run', sh`tar xf ${build.artifacts.dist}`)],
  });
  return { build, test };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GcsArtifactStore', () => {
  it('needs no workspace, so a pipeline using it binds none at all', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { build, test } = pair(gcsArtifacts({ bucket: 'ci-artifacts' }));

    // The constraint the workspace-backed store inherits, and the whole reason this exists:
    // nothing is shared between the two pods but a bucket, so neither binds a PVC and the
    // tasks are free to schedule on different nodes.
    expect(build.workspaces).toEqual([]);
    expect(test.workspaces).toEqual([]);
    const pipeline = new Pipeline({ name: 'ci', tasks: [build, test] });
    expect(pipeline._buildSpec().workspaces ?? []).toEqual([]);

    // And nothing downstream invents one: a project binds exactly the workspaces the spec
    // declares, so there is no PVC and no volumeClaimTemplate to pin the run to a node.
    // `targets: []` because constructing a project emits through its targets, and a unit test
    // has no business writing manifests into the repository.
    const project = new TektonicProject({ namespace: 'ci', pipelines: [pipeline], targets: [], ...CAPABLE });
    expect(project.model.pipelines[0].workspaceBindings).toEqual([]);
  });

  it('keys the object by run, producing task and artifact name', () => {
    const store = gcsArtifacts({ bucket: 'ci-artifacts', prefix: 'runs/' });
    const { build } = pair(store);

    expect(store.uri(build.artifacts.dist)).toBe(
      `gs://ci-artifacts/runs/${DEFAULT_GCS_ARTIFACT_RUN_KEY}/build/dist.tar.zst`,
    );
    // The run key is what keeps one run from reading another's artifacts, so it has to be in
    // the key rather than assumed from the bucket being fresh.
    expect(store.uri(build.artifacts.dist)).toContain('$(context.pipelineRun.uid)');
  });

  it('lands the artifact where every step of the consumer can see it', () => {
    const store = gcsArtifacts({ bucket: 'ci-artifacts' });
    const { build } = pair(store);

    // Steps are separate containers: /tekton/home is the one directory they all share.
    expect(build.artifacts.dist.path).toBe(`${GCS_ARTIFACT_LOCAL_DIR}/build/dist/app.tar`);
    expect(`${build.artifacts.dist}`).toBe(build.artifacts.dist.path);
  });

  it('uploads in the producer and downloads in the consumer, in the built-in positions', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { build, test } = pair(gcsArtifacts({ bucket: 'ci-artifacts' }));

    expect(synthTask(build, CAPABLE).stepNames).toEqual(['compile', 'publish-dist-artifact']);
    expect(synthTask(test, CAPABLE).stepNames).toEqual(['fetch-build-dist-artifact', 'run']);

    const publish = synthTask(build, CAPABLE).script('publish-dist-artifact');
    expect(publish).toContain('^tar cf - -C $parent $entry');
    expect(publish).toContain('^zstd -3 -T0 -c');
    expect(publish).toContain('^gcloud --verbosity=error storage cp - $object');

    const fetch = synthTask(test, CAPABLE).script('fetch-build-dist-artifact');
    expect(fetch).toContain('^gcloud --verbosity=error storage cp $object -');
    expect(fetch).toContain('^zstd -d -T0 -c');
    expect(fetch).toContain(`^tar xf - -C $dest`);
  });

  it('fails the consumer when the object is missing, rather than proceeding without it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { test } = pair(gcsArtifacts({ bucket: 'ci-artifacts' }));
    const fetch = synthTask(test, CAPABLE).script('fetch-build-dist-artifact');

    expect(fetch).toContain("could not be fetched");
    expect(fetch).toContain('exit 1');
    // An artifact is a declared handoff, not a cache: there is no "miss" to continue past.
    expect(synthTask(test, CAPABLE).step('fetch-build-dist-artifact').onError).toBeUndefined();
  });

  it('runs its steps in an image with gcloud, not in the producing action\'s image', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { build } = pair(gcsArtifacts({ bucket: 'ci-artifacts' }));

    // The workspace store uses the action's own image, because `cp` needs nothing. Uploading
    // does, and there is no reason a Node image carries gcloud.
    expect(build.artifacts.dist.publishImage).toBe('ghcr.io/example/node:24');
    expect(synthTask(build, CAPABLE).step('publish-dist-artifact').image).toBe(
      CAPABLE.injectedStepImage,
    );
  });

  it('resolves through the project image, and says which capability is missing when it cannot', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { build } = pair(gcsArtifacts({ bucket: 'ci-artifacts' }));

    expect(() =>
      synthTask(build, { injectedStepImage: { image: 'docker.io/alpine/git:v2', provides: ['sh', 'git'] } }),
    ).toThrow(/needs an image providing nushell, tar, zstd, gcloud/);
    // And an explicit image is taken as given.
    const explicit = pair(gcsArtifacts({ bucket: 'b', image: 'ghcr.io/example/gcloud:1' }));
    expect(synthTask(explicit.build).step('publish-dist-artifact').image).toBe(
      'ghcr.io/example/gcloud:1',
    );
  });

  it('changes no produces/consumes declaration when swapped for the workspace store', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onWorkspace = pair();
    const inGcs = pair(gcsArtifacts({ bucket: 'ci-artifacts' }));

    // Identical declarations, identical handle shape — only the path the handle resolves to
    // and the steps behind it differ. This is the "backend swap, not a redesign" claim.
    for (const { build, test } of [onWorkspace, inGcs]) {
      expect(Object.keys(build.artifacts)).toEqual(['dist']);
      expect(build.produces.map(a => a.name)).toEqual(['dist']);
      expect(test.consumes.map(a => a.name)).toEqual(['dist']);
      expect(build.artifacts.dist.sourcePath).toBe('/tektonic/actions/compile-app.tar');
      expect(build.artifacts.dist.fileName).toBe('app.tar');
      expect(synthTask(build, CAPABLE).stepNames).toEqual(['compile', 'publish-dist-artifact']);
      expect(synthTask(test, CAPABLE).stepNames).toEqual(['fetch-build-dist-artifact', 'run']);
      // The synth-time checks are the declaration's business and know nothing of the store.
      expect(() => new Pipeline({ name: 'ci', tasks: [build, test] })).not.toThrow();
    }

    expect(onWorkspace.build.artifacts.dist.store).toBeInstanceOf(WorkspaceArtifactStore);
    expect(inGcs.build.artifacts.dist.store).toBeInstanceOf(GcsArtifactStore);
    expect(onWorkspace.build.artifacts.dist.path).not.toBe(inGcs.build.artifacts.dist.path);
  });

  it('feeds the store URI into TEP-0147 provenance rather than a path that stops existing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = gcsArtifacts({ bucket: 'ci-artifacts' });
    const build = new Task({
      name: 'build',
      steps: [compile()],
      artifactStore: store,
      produces: { dist: { from: compile().outputs.bundle.toArtifact(), buildOutput: true } },
      artifactProvenance: true,
    });

    const script = synthTask(build, CAPABLE).script('artifact-provenance');
    expect(script).toContain(store.uri(build.artifacts.dist));
    expect(script).toContain('"buildOutput":true');
  });

  it('honours the compression and run-key options', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = gcsArtifacts({
      bucket: 'b',
      compressionLevel: 9,
      multiThreadCompression: false,
      runKey: '$(context.pipelineRun.name)',
      localDir: '/tekton/home/art',
    });
    const { build } = pair(store);

    expect(store.uri(build.artifacts.dist)).toBe(
      'gs://b/$(context.pipelineRun.name)/build/dist.tar.zst',
    );
    expect(build.artifacts.dist.path).toBe('/tekton/home/art/build/dist/app.tar');
    expect(synthTask(build, CAPABLE).script('publish-dist-artifact')).toContain('^zstd -9 -T1 -c');
  });
});

/** The manifest, for assertions the TaskView does not cover. */
const manifest = (task: Task) => {
  const chart = new Chart(new App(), task.name);
  task.synth(chart, 'ns', CAPABLE);
  return chart.toJson()[0] as Record<string, unknown>;
};

describe('GcsArtifactStore steps', () => {
  it('points gcloud at a config directory on the shared home volume, as the cache backend does', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { build } = pair(gcsArtifacts({ bucket: 'b' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spec = manifest(build) as any;
    const publish = spec.spec.steps.find((s: { name: string }) => s.name === 'publish-dist-artifact');
    expect(publish.env).toEqual([{ name: 'CLOUDSDK_CONFIG', value: '/tekton/home/.config/gcloud' }]);
  });
});
