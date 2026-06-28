import type { TaskCacheSpec, TaskStepSpec } from "../core/task";
import type { BackendCtx, CacheBackend } from "../core/cache-backend";
import type { Script } from "../script";
import { threadFlag, hashExpr, cacheScript, COMPRESSED_CACHE_LANGUAGE } from "./shared";
import { DEFAULT_GCS_COMPRESSION_LEVEL } from "../constants";

/** Options for constructing a {@link GcsBackend}. */
export interface GcsBackendOptions {
    /** GCS bucket name (e.g. `'my-project-ci-cache'`). */
    bucket: string;
    /**
     * Optional key prefix within the bucket (e.g. `'tekton-cache/'`).
     * Useful for sharing a bucket across multiple projects.
     * Defaults to `''`.
     */
    prefix?: string;
}

/**
 * Google Cloud Storage cache backend.
 *
 * Stores cache archives in a GCS bucket. Authentication uses GKE Workload Identity —
 * the pod's Kubernetes Service Account must be annotated with
 * `iam.gke.io/gcp-service-account` pointing to a GCP SA that has
 * `roles/storage.objectAdmin` on the bucket.
 *
 * Use the {@link gcs} factory function to construct:
 * ```ts
 * caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'],
 *            backend: gcs({ bucket: 'my-ci-cache', prefix: 'tekton/' }) }]
 * ```
 */
export class GcsBackend implements CacheBackend {
    readonly type = "gcs" as const;
    readonly needsPvcWorkspace = false as const;
    readonly bucket: string;
    readonly prefix: string;

    constructor(opts: GcsBackendOptions) {
        this.bucket = opts.bucket;
        this.prefix = opts.prefix ?? "";
    }

    restoreStep(spec: TaskCacheSpec, taskName: string, ctx: BackendCtx): TaskStepSpec {
        return {
            name: `restore-${spec.name}-cache`,
            image: spec.image ?? ctx.defaultGcsCacheImage,
            script: this._makeRestoreScript(spec, taskName),
            env: [{ name: "CLOUDSDK_CONFIG", value: "/tekton/home/.config/gcloud" }],
            ...(spec.workingDir ? { workingDir: spec.workingDir } : {}),
            ...(spec.computeResources ? { computeResources: spec.computeResources } : {}),
        };
    }

    saveStep(spec: TaskCacheSpec, taskName: string, ctx: BackendCtx): TaskStepSpec {
        return {
            name: `save-${spec.name}-cache`,
            image: spec.image ?? ctx.defaultGcsCacheImage,
            script: this._makeSaveScript(spec, taskName),
            onError: "continue" as const,
            env: [{ name: "CLOUDSDK_CONFIG", value: "/tekton/home/.config/gcloud" }],
            ...(spec.workingDir ? { workingDir: spec.workingDir } : {}),
            ...(spec.computeResources ? { computeResources: spec.computeResources } : {}),
        };
    }

    private _hashFilePath(c: TaskCacheSpec, taskName?: string): string {
        if (c.saveStrategy === "finally") {
            return `/tekton/home/.cache-${c.name}-hash${taskName ? `-${taskName}` : ""}`;
        }
        return `/tekton/home/.cache-${c.name}-hash`;
    }

    private _makeRestoreScript(c: TaskCacheSpec, taskName?: string): Script {
        const hashFile = this._hashFilePath(c, taskName);
        const expr = hashExpr(c);
        const flag = threadFlag(c, true); // GCS defaults to multi-threaded
        const label = `restore-${c.name}-cache`;
        const skipIfExists = c.skipRestoreIfPathsExist ?? false;
        const pathList = c.paths.map((p) => `"${p}"`).join(", ");
        const skipGuard = skipIfExists
            ? `if ([${pathList}] | any { |p| $p | path exists }) {
  log $"${label}: paths already exist, skipping restore ($hash)"
  exit 0
}
`
            : "";

        return cacheScript(
            `${expr}
$hash | save -f ${hashFile}
${skipGuard}
let object = $"${this.prefix}($hash).tar.zst"
let gcs_url = $"gs://${this.bucket}/($object)"
log $"${label}: checking ($gcs_url)"

let exists = ((^gcloud storage ls $gcs_url | complete).exit_code == 0)
if $exists {
  let size = (
    ^gcloud storage ls -l $gcs_url
    | lines | first | str trim | split words | first | into int
  )
  log $"${label}: hit ($hash) size=(($size / 1_000_000) | math round --precision 1)MB"
  let cache_paths = [${pathList}]
  for p in $cache_paths {
    if ($p | path exists) { ^chmod -R u+w $p; rm -rf $p }
  }
  log "${label}: downloading ..."
  let t0 = (date now)
  ^gcloud --verbosity=error storage cp $gcs_url - | ^zstd -d ${flag} -c | ^tar xf - -o --no-same-permissions
  let elapsed = (((date now) - $t0) | into int) / 1_000_000_000
  let speed = (if $elapsed > 0 { ($size / 1_000_000) / $elapsed | math round --precision 1 } else { 0 })
  log $"${label}: restored in ($elapsed)s ($speed) MB/s"
} else {
  log $"${label}: miss ($hash) — object not found in bucket"
}`,
            COMPRESSED_CACHE_LANGUAGE,
        );
    }

    private _makeSaveScript(c: TaskCacheSpec, taskName?: string): Script {
        const hashFile = this._hashFilePath(c, taskName);
        const compressionLevel = c.compressionLevel ?? DEFAULT_GCS_COMPRESSION_LEVEL;
        const maxEntries = c.maxEntries ?? 3;
        const forceSave = c.forceSave ?? false;
        const flag = threadFlag(c, true); // GCS defaults to multi-threaded
        const label = `save-${c.name}-cache`;
        const pathList = c.paths.map((p) => `"${p}"`).join(", ");
        const tmpDir = c.workingDir ?? "/tmp";

        const skipExisting = forceSave
            ? ""
            : `let already_exists = ((^gcloud storage ls $gcs_url | complete).exit_code == 0)
if $already_exists { log $"${label}: ($hash) exists, skipping"; exit 0 }
`;

        return cacheScript(
            `let hash = (try { open --raw ${hashFile} | str trim } catch { "" })
if ($hash | is-empty) { log "${label}: no hash, skipping"; exit 0 }

let object = $"${this.prefix}($hash).tar.zst"
let gcs_url = $"gs://${this.bucket}/($object)"
${skipExisting}
let paths = [${pathList}] | where { |p| ($p | path exists) }
if ($paths | is-empty) { log "${label}: no paths to cache"; exit 0 }

for p in $paths { ^chmod -R u+w $p }

let max = ${maxEntries}
if $max > 0 {
  let entries = (try {
    ^gcloud storage ls -l $"gs://${this.bucket}/${this.prefix}*.tar.zst"
    | lines
    | where { |l| $l | str ends-with ".tar.zst" }
    | each { |l|
        let parts = ($l | str trim | split row -r '\\s+')
        { url: ($parts | last), created: ($parts | get 1) }
      }
    | sort-by created | reverse | skip $max
  } catch { [] })
  for e in $entries {
    let result = (^gcloud storage rm $e.url | complete)
    if $result.exit_code == 0 {
      log $"${label}: evicted ($e.url)"
    } else {
      log $"${label}: warn: failed to evict ($e.url): ($result.stderr)"
    }
  }
}

let uncompressed = ($paths | each { |p| try { du $p | get apparent.0 | into int } catch { 0 } } | math sum)
log $"${label}: compressing (($uncompressed / 1_000_000) | math round --precision 1)MB ..."
let tmp = $"${tmpDir}/cache-($hash).tar.zst"
let t0 = (date now)
^tar cf - ...$paths | ^zstd -${compressionLevel} ${flag}${forceSave ? " -f" : ""} -o $tmp
let compress_elapsed = (((date now) - $t0) | into int) / 1_000_000_000
let compressed = (ls $tmp | get size.0 | into int)
let ratio = (if $compressed > 0 { $uncompressed / $compressed | math round --precision 1 } else { 0 })
log $"${label}: compressed to (($compressed / 1_000_000) | math round --precision 1)MB ratio=($ratio)x in ($compress_elapsed)s"

log "${label}: uploading ..."
let t1 = (date now)
^gcloud storage cp $tmp $gcs_url
rm $tmp
let upload_elapsed = (((date now) - $t1) | into int) / 1_000_000_000
let speed = (if $upload_elapsed > 0 { ($compressed / 1_000_000) / $upload_elapsed | math round --precision 1 } else { 0 })
log $"${label}: uploaded ($gcs_url) in ($upload_elapsed)s ($speed) MB/s"`,
            COMPRESSED_CACHE_LANGUAGE,
        );
    }
}

/**
 * Factory function for creating a {@link GcsBackend}.
 *
 * @example
 * ```ts
 * caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'],
 *            backend: gcs({ bucket: 'my-ci-cache', prefix: 'tekton/' }) }]
 * ```
 */
export function gcs(opts: GcsBackendOptions): GcsBackend {
    return new GcsBackend(opts);
}
