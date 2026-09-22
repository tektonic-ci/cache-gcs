# @pfenerty/tektonic-cache-gcs

Google Cloud Storage providers for [tektonic](https://github.com/pfenerty/tektonic): a
`CacheBackend` and an `ArtifactStore`.

- **`gcs()`** stores cache archives as `.tar.zst` objects in a GCS bucket instead of on a PVC,
  so caching works for tasks that mount no persistent workspace and survives cluster rebuilds.
- **`gcsArtifacts()`** does the same for declared artifacts: the producing task uploads, the
  consuming task downloads, and neither binds a workspace — which is what frees a pipeline's
  tasks to be scheduled across nodes.

They are separate strategies sharing a bucket and an auth story, not one thing. A cache is
content-addressed and reused across runs; an artifact is run-scoped with one writer, and a
missing one is a failure rather than a miss.

Authentication for both is GKE Workload Identity: the pod's Kubernetes ServiceAccount must be
annotated with `iam.gke.io/gcp-service-account` pointing at a GCP service account holding
`roles/storage.objectAdmin` on the bucket. No token handling in the step scripts.

> The package name predates the artifact store. Nothing is published yet, so whether it keeps
> this name is still open — see `tektonic-46j.18`.

## Install

```bash
npm install @pfenerty/tektonic-cache-gcs
```

`@pfenerty/tektonic` is a **peer** dependency, deliberately: a cache backend is matched to a
`Task` by object identity, and two copies of the core package are two incompatible sets of
classes. Your project pins the version; this package follows it.

## Use

### Caches

```ts
import { Task } from '@pfenerty/tektonic';
import { gcs } from '@pfenerty/tektonic-cache-gcs';

new Task({
  name: 'test',
  caches: [{
    name: 'npm',
    key: ['package-lock.json'],
    paths: ['node_modules'],
    compress: true,
    backend: gcs({ bucket: 'my-ci-cache', prefix: 'tekton/' }),
  }],
  steps: [/* … */],
});
```

### Artifacts

```ts
import { Task } from '@pfenerty/tektonic';
import { gcsArtifacts } from '@pfenerty/tektonic-cache-gcs';

const store = gcsArtifacts({ bucket: 'my-ci-artifacts', prefix: 'runs/' });

const build = new Task({
  name: 'build',
  steps: [compile],
  artifactStore: store,
  produces: { dist: compile.outputs.bundle.toArtifact() },
});

const test = new Task({
  name: 'test',
  needs: [build],
  consumes: [build.artifacts.dist],                // no workspace on either task
  steps: [{ name: 'run', image, script: sh`tar xf ${build.artifacts.dist}` }],
});
```

Objects are keyed by `$(context.pipelineRun.uid)`, the producing task and the artifact name,
so a store-backed artifact needs a PipelineRun — `$(context.taskRun.uid)` differs between
producer and consumer and is not a fallback.

Because the store binds no workspace, the path in `produces` has to be somewhere *every* step
of the task can see: a promoted action output (`.toArtifact()`, which lives on the pod-scoped
action volume) always works; a plain path must be under a workspace the task mounts anyway,
`/tekton/home`, or a volume it declares. Fetched artifacts land under
`/tekton/home/artifacts/<producer>/<name>/`.

### The step image

The injected steps — restore/save for caches, publish/fetch for artifacts — need an image
providing `gcloud`, `nushell`, `tar` and `zstd`. They resolve through the project's
`injectedStepImage`, and synthesis fails naming the missing capability if it does not declare
`gcloud`. `DEFAULT_GCS_CACHE_IMAGE` is one image known to have all four:

```ts
gcs({ bucket: 'my-ci-cache', image: DEFAULT_GCS_CACHE_IMAGE })
gcsArtifacts({ bucket: 'my-ci-artifacts', image: DEFAULT_GCS_CACHE_IMAGE })
```

Note that `gcsArtifacts` ignores a promoted output's own image, unlike the in-core workspace
store: that is the image the *action* ran in, and copying a file needs nothing while uploading
one needs `gcloud`.

## Exports

| Export | What it is |
|---|---|
| `gcs(opts)` | Factory for the cache backend — the usual way to construct one |
| `GcsBackend` | The `CacheBackend` implementation |
| `GcsBackendOptions` | `{ bucket, prefix?, image? }` |
| `gcsArtifacts(opts)` | Factory for the artifact store |
| `GcsArtifactStore` | The `ArtifactStore` implementation |
| `GcsArtifactStoreOptions` | `{ bucket, prefix?, runKey?, image?, localDir?, compressionLevel?, multiThreadCompression? }` |
| `DEFAULT_GCS_CACHE_IMAGE` | An image providing `gcloud`/`nushell`/`tar`/`zstd` |
| `DEFAULT_GCS_COMPRESSION_LEVEL` | `3` — the cache backend's zstd level, overridable per cache |
| `DEFAULT_GCS_ARTIFACT_COMPRESSION_LEVEL` | `3` — the artifact store's zstd level |
| `DEFAULT_GCS_ARTIFACT_RUN_KEY` | `$(context.pipelineRun.uid)` — what scopes objects to a run |
| `GCS_ARTIFACT_LOCAL_DIR` | `/tekton/home/artifacts` — where fetched artifacts land |

## Why it is a separate package

Because nothing else proves the `CacheBackend` and `ArtifactStore` seams work. This package
imports only `@pfenerty/tektonic`'s published surface — a build-time check enforces it — so
anything a third-party backend or store would need and cannot reach fails here first. See
[docs/cache-backends.md](../../docs/cache-backends.md) and
[docs/artifacts.md](../../docs/artifacts.md) to write your own.

## License

[Apache-2.0](../../LICENSE)
