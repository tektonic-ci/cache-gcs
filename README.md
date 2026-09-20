# @pfenerty/tektonic-cache-gcs

Google Cloud Storage cache backend for [tektonic](https://github.com/pfenerty/tektonic).

Stores cache archives as `.tar.zst` objects in a GCS bucket instead of on a PVC, so caching
works for tasks that mount no persistent workspace and survives cluster rebuilds.
Authentication is GKE Workload Identity: the pod's Kubernetes ServiceAccount must be
annotated with `iam.gke.io/gcp-service-account` pointing at a GCP service account holding
`roles/storage.objectAdmin` on the bucket. No token handling in the step scripts.

## Install

```bash
npm install @pfenerty/tektonic-cache-gcs
```

`@pfenerty/tektonic` is a **peer** dependency, deliberately: a cache backend is matched to a
`Task` by object identity, and two copies of the core package are two incompatible sets of
classes. Your project pins the version; this package follows it.

## Use

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

The injected restore/save steps need an image providing `gcloud`, `nushell`, `tar` and
`zstd`. They resolve through the project's `injectedStepImage`, and synthesis fails naming
the missing capability if it does not declare `gcloud`. `DEFAULT_GCS_CACHE_IMAGE` is one
image known to have all four:

```ts
gcs({ bucket: 'my-ci-cache', image: DEFAULT_GCS_CACHE_IMAGE })
```

## Exports

| Export | What it is |
|---|---|
| `gcs(opts)` | Factory — the usual way to construct one |
| `GcsBackend` | The `CacheBackend` implementation |
| `GcsBackendOptions` | `{ bucket, prefix?, image? }` |
| `DEFAULT_GCS_CACHE_IMAGE` | An image providing `gcloud`/`nushell`/`tar`/`zstd` |
| `DEFAULT_GCS_COMPRESSION_LEVEL` | `3` — this backend's zstd level, overridable per cache |

## Why it is a separate package

Because nothing else proves the `CacheBackend` seam works. This package imports only
`@pfenerty/tektonic`'s published surface — a build-time check enforces it — so anything a
third-party backend would need and cannot reach fails here first. See
[docs/cache-backends.md](../../docs/cache-backends.md) to write your own.

## License

[Apache-2.0](../../LICENSE)
