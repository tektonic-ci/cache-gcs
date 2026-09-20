/**
 * Google Cloud Storage cache backend for tektonic.
 *
 * Ships outside `@pfenerty/tektonic` on purpose: it imports nothing but that package's
 * published surface, so the `CacheBackend` seam is exercised by a real out-of-tree
 * implementation rather than assumed to work. See `docs/cache-backends.md`.
 *
 * ```ts
 * import { gcs } from '@pfenerty/tektonic-cache-gcs';
 *
 * caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'],
 *            compress: true, backend: gcs({ bucket: 'my-ci-cache', prefix: 'tekton/' }) }]
 * ```
 */
export {
    GcsBackend,
    gcs,
    DEFAULT_GCS_CACHE_IMAGE,
    DEFAULT_GCS_COMPRESSION_LEVEL,
} from "./gcs-backend";
export type { GcsBackendOptions } from "./gcs-backend";
