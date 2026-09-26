# Changelog

Notable changes to `@tektonic-ci/cache-gcs`. Until 2.1.0 this package lived in
[tektonic-ci/core](https://github.com/tektonic-ci/core) and versioned together with core;
the entries below are the ones from core's changelog that concern it. From here on it
versions on its own, and releases only when it changes
([ADR 0002](https://github.com/tektonic-ci/core/blob/main/docs/adr/0002-npm-scope-and-versioning.md)).

## 2.1.1

### Moved: the package has a repo of its own

The source now lives in `tektonic-ci/cache-gcs`, with its history carried over, and it
builds, tests and publishes against `@tektonic-ci/core` from npm. Nothing about the
package's API or output changes.

## 2.1.0

### Renamed: published as `@tektonic-ci/cache-gcs`

Was `@pfenerty/tektonic-cache-gcs`, which gets no further releases. The peer dependency is
now `@tektonic-ci/core` `^2`. Change the dependency name in `package.json` and the import:

```ts
import { gcs, gcsArtifacts } from '@tektonic-ci/cache-gcs';
```

No other changes.

## 2.0.1

First release as a package of its own, as `@pfenerty/tektonic-cache-gcs`. `GcsBackend`,
`gcs` and `DEFAULT_GCS_CACHE_IMAGE` were previously exported from `@pfenerty/tektonic`:

| Was | Is |
|---|---|
| `import { gcs, DEFAULT_GCS_CACHE_IMAGE } from '@pfenerty/tektonic'` | `import { gcs, DEFAULT_GCS_CACHE_IMAGE } from '@pfenerty/tektonic-cache-gcs'` |

The package takes core as a peer dependency so a project only ever has one copy of it, and
the synthesized YAML is byte-identical.

### Added

- A GCS-backed `ArtifactStore` (`gcsArtifacts`), for moving declared artifacts between
  tasks through a bucket instead of the shared workspace.
- `DEFAULT_GCS_COMPRESSION_LEVEL`, moved from core: it is GCS's own default. Per-cache
  `compressionLevel` is unchanged.

### Changed

- **The GCS image is no longer a default.** Cache steps used to fall back to
  `ghcr.io/pfenerty/apko-cicd/gcloud:563.0.0`; they now resolve their image through the
  project's `injectedStepImage`, and synthesis fails naming the `gcloud` capability if that
  image doesn't provide it. `DEFAULT_GCS_CACHE_IMAGE` is still exported, so opting back in
  is one line:

  ```ts
  caches: [{ /* … */ backend: gcs({ bucket, image: DEFAULT_GCS_CACHE_IMAGE }) }],
  ```

- `DEFAULT_GCS_CACHE_IMAGE` pins `ghcr.io/pfenerty/apko-cicd/gcloud:581.0.0` (was `563.0.0`),
  and Renovate now updates the constant itself.
