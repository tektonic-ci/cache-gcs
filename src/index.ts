/**
 * Google Cloud Storage providers for tektonic: a `CacheBackend` and an `ArtifactStore`.
 *
 * Ships outside `@tektonic-ci/core` on purpose: it imports nothing but that package's
 * published surface, so both seams are exercised by a real out-of-tree implementation
 * rather than assumed to work. See `docs/cache-backends.md` and `docs/artifacts.md`.
 *
 * The two are separate strategies and share only a bucket and an auth story — a cache is
 * content-addressed and reused across runs, an artifact is run-scoped with one writer.
 *
 * ```ts
 * import { gcs, gcsArtifacts } from '@tektonic-ci/cache-gcs';
 *
 * caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'],
 *            compress: true, backend: gcs({ bucket: 'my-ci-cache', prefix: 'tekton/' }) }]
 * artifactStore: gcsArtifacts({ bucket: 'my-ci-artifacts' })
 * ```
 *
 * The package name predates the artifact store. It is not on the npm registry yet
 * (tektonic-46j.12), so whether it is published as `tektonic-cache-gcs` or renamed to
 * something that covers both is still free to decide — tektonic-46j.18 tracks that call,
 * which has to be made before the first publish and never again.
 */
export {
    GcsBackend,
    gcs,
    DEFAULT_GCS_CACHE_IMAGE,
    DEFAULT_GCS_COMPRESSION_LEVEL,
} from "./gcs-backend";
export type { GcsBackendOptions } from "./gcs-backend";
export {
    GcsArtifactStore,
    gcsArtifacts,
    DEFAULT_GCS_ARTIFACT_COMPRESSION_LEVEL,
    DEFAULT_GCS_ARTIFACT_RUN_KEY,
    GCS_ARTIFACT_LOCAL_DIR,
} from "./gcs-artifact-store";
export type { GcsArtifactStoreOptions } from "./gcs-artifact-store";
