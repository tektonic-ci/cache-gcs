import {
    COMPRESSED_CACHE_LANGUAGE,
    cacheScript,
    injectedImageRef,
    threadFlag,
} from "@pfenerty/tektonic";
import type {
    ArtifactStore,
    ArtifactStoreCtx,
    Script,
    TaskArtifact,
    TaskStepSpec,
} from "@pfenerty/tektonic";

/**
 * Default zstd compression level for artifact archives.
 *
 * Matches {@link DEFAULT_GCS_COMPRESSION_LEVEL} for caches: the same bucket, the same CPU
 * budget, and the same trade of a little compression time for a lot less transfer.
 */
export const DEFAULT_GCS_ARTIFACT_COMPRESSION_LEVEL = 3;

/**
 * Where a fetched artifact lands inside the consuming pod.
 *
 * Under `/tekton/home` because that is the one directory Tekton mounts on *every* step of a
 * task — steps are separate containers, so a file the injected fetch step writes anywhere
 * else is invisible to the user steps that consume it. The same volume the GCS cache backend
 * keeps its hash file on.
 */
export const GCS_ARTIFACT_LOCAL_DIR = "/tekton/home/artifacts" as const;

/**
 * The Tekton expression this store keys artifacts by, and the reason a store-backed artifact
 * needs a PipelineRun.
 *
 * An artifact is run-scoped: the producer and the consumer are different pods, so the key has
 * to be identical in both and different from every other run. `$(context.pipelineRun.uid)` is
 * the only built-in that is both. `$(context.taskRun.uid)` would differ between the two tasks
 * and is therefore never a valid fallback — a bare TaskRun resolves this to the empty string,
 * which is why the run key is an option rather than a constant.
 */
export const DEFAULT_GCS_ARTIFACT_RUN_KEY = "$(context.pipelineRun.uid)" as const;

/** Options for constructing a {@link GcsArtifactStore}. */
export interface GcsArtifactStoreOptions {
    /** GCS bucket name (e.g. `'my-project-ci-artifacts'`). */
    bucket: string;
    /**
     * Optional key prefix within the bucket (e.g. `'artifacts/'`). Useful for sharing a
     * bucket with the cache backend or across projects. Defaults to `''`.
     */
    prefix?: string;
    /**
     * Expression the object key is scoped by, so one run never reads another's artifacts.
     * Defaults to {@link DEFAULT_GCS_ARTIFACT_RUN_KEY}.
     */
    runKey?: string;
    /**
     * Image for the injected publish/fetch steps. Must provide `gcloud`, `nushell`, `tar`
     * and `zstd` — {@link DEFAULT_GCS_CACHE_IMAGE} is one that does. Defaults to the
     * project's `injectedStepImage`.
     *
     * Unlike {@link WorkspaceArtifactStore}, an action-sourced artifact's own
     * `publishImage` is **not** used: that is the image the action ran in, and it has no
     * reason to carry `gcloud`. Copying a file needs nothing; uploading one does.
     */
    image?: string;
    /** In-pod directory fetched artifacts are written to. Defaults to {@link GCS_ARTIFACT_LOCAL_DIR}. */
    localDir?: string;
    /** zstd compression level. Defaults to {@link DEFAULT_GCS_ARTIFACT_COMPRESSION_LEVEL}. */
    compressionLevel?: number;
    /** Multi-threaded compression. Defaults to `true`, as the GCS cache backend does. */
    multiThreadCompression?: boolean;
}

/**
 * A Google Cloud Storage {@link ArtifactStore}: the producer uploads a tarball, the consumer
 * downloads it.
 *
 * This is the implementation that lifts the constraint the in-core
 * `WorkspaceArtifactStore` inherits. Nothing is shared between the two pods but a bucket, so
 * a pipeline using it binds **no workspace at all** for artifacts and its tasks are free to
 * schedule on different nodes. Swapping it in changes no `produces`/`consumes` declaration
 * and no handle type — only where `build.artifacts.dist` points.
 *
 * ```ts
 * const store = gcsArtifacts({ bucket: 'my-ci-artifacts', prefix: 'runs/' });
 * const build = new Task({ name: 'build', steps: [compile], artifactStore: store,
 *                          produces: { dist: compile.outputs.bundle.toArtifact() } });
 * const test  = new Task({ name: 'test', needs: [build], consumes: [build.artifacts.dist],
 *                          steps: [{ name: 'run', image, script: sh`tar xf ${build.artifacts.dist}` }] });
 * ```
 *
 * Authentication is GKE Workload Identity, exactly as {@link GcsBackend} uses it: the pod's
 * Kubernetes Service Account must be annotated with `iam.gke.io/gcp-service-account` pointing
 * at a GCP SA holding `roles/storage.objectAdmin` on the bucket.
 *
 * **The producer's path must be on a volume every step of that task sees.** Steps are
 * separate containers, so the injected publish step cannot read a file a user step left in
 * its own container's filesystem. An action output (`compile.outputs.bundle.toArtifact()`)
 * satisfies this by construction — those live on the pod-scoped action volume. A plain path
 * string must name somewhere under a workspace the task mounts, `/tekton/home`, or a volume
 * the task declares. The workspace store hides this because it always has a workspace; this
 * one, whose entire purpose is not needing one, does not.
 *
 * This is not a {@link CacheBackend} and deliberately shares none of its semantics: no
 * content-addressed key, no restore-or-miss, no eviction. A missing artifact is a failure,
 * not a miss. It does share `cache/shared.ts`'s script and compression helpers, because the
 * tar/zstd/gcloud pipeline is genuinely the same one.
 */
export class GcsArtifactStore implements ArtifactStore {
    readonly type = "gcs" as const;
    readonly needsWorkspace = false as const;
    readonly bucket: string;
    readonly prefix: string;
    readonly runKey: string;
    readonly localDir: string;
    readonly image: string;
    private readonly compressionLevel: number;
    private readonly multiThreadCompression: boolean;

    constructor(opts: GcsArtifactStoreOptions) {
        this.bucket = opts.bucket;
        this.prefix = opts.prefix ?? "";
        this.runKey = opts.runKey ?? DEFAULT_GCS_ARTIFACT_RUN_KEY;
        this.localDir = opts.localDir ?? GCS_ARTIFACT_LOCAL_DIR;
        this.image = opts.image ?? injectedImageRef("gcloud", "nushell", "tar", "zstd");
        this.compressionLevel = opts.compressionLevel ?? DEFAULT_GCS_ARTIFACT_COMPRESSION_LEVEL;
        this.multiThreadCompression = opts.multiThreadCompression ?? true;
    }

    /** Where the consumer reads the artifact, once the fetch step has extracted it. */
    path(artifact: TaskArtifact): string {
        return `${this.dir(artifact)}/${artifact.fileName}`;
    }

    /**
     * Object URL for the artifact, keyed by run, producing task and artifact name — one
     * writer per key, as the workspace store gets from a per-producer subtree.
     */
    uri(artifact: TaskArtifact): string {
        return (
            `gs://${this.bucket}/${this.prefix}${this.runKey}/` +
            `${artifact.producerName}/${artifact.name}.tar.zst`
        );
    }

    publishStep(artifact: TaskArtifact, ctx: ArtifactStoreCtx): TaskStepSpec {
        return {
            name: `publish-${artifact.name}-artifact`,
            image: this.image,
            script: this.publishScript(artifact, ctx),
            env: [{ name: "CLOUDSDK_CONFIG", value: "/tekton/home/.config/gcloud" }],
        };
    }

    fetchStep(artifact: TaskArtifact, ctx: ArtifactStoreCtx): TaskStepSpec {
        return {
            name: `fetch-${artifact.producerName}-${artifact.name}-artifact`,
            image: this.image,
            script: this.fetchScript(artifact, ctx),
            env: [{ name: "CLOUDSDK_CONFIG", value: "/tekton/home/.config/gcloud" }],
        };
    }

    /** In-pod directory one artifact is fetched into, keyed the same way the object is. */
    private dir(artifact: TaskArtifact): string {
        return `${this.localDir}/${artifact.producerName}/${artifact.name}`;
    }

    private publishScript(artifact: TaskArtifact, ctx: ArtifactStoreCtx): Script {
        const label = `publish-${artifact.name}-artifact`;
        const flag = threadFlag({ multiThreadCompression: this.multiThreadCompression }, true);
        return cacheScript(
            `let src = "${artifact.sourcePath}"
if not ($src | path exists) {
  log $"${label}: task '${ctx.taskName}' declares artifact '${artifact.name}' but wrote nothing at ($src)"
  exit 1
}

let object = "${this.uri(artifact)}"
# Archive the basename from its parent, so extraction reproduces '${artifact.fileName}'
# under the consumer's directory and 'path' is the same string on both sides.
let parent = (if ($src | path dirname | is-empty) { "." } else { $src | path dirname })
let entry = ($src | path basename)
let uncompressed = (try { du $src | get apparent.0 | into int } catch { 0 })
log $"${label}: packing ($src) (($uncompressed / 1_000_000) | math round --precision 1)MB"

let t0 = (date now)
^tar cf - -C $parent $entry | ^zstd -${String(this.compressionLevel)} ${flag} -c | ^gcloud --verbosity=error storage cp - $object
let elapsed = (((date now) - $t0) | into int) / 1_000_000_000
log $"${label}: uploaded ($object) in ($elapsed)s"`,
            COMPRESSED_CACHE_LANGUAGE,
        );
    }

    private fetchScript(artifact: TaskArtifact, ctx: ArtifactStoreCtx): Script {
        const label = `fetch-${artifact.producerName}-${artifact.name}-artifact`;
        const dir = this.dir(artifact);
        const flag = threadFlag({ multiThreadCompression: this.multiThreadCompression }, true);
        return cacheScript(
            `let dest = "${dir}"
let object = "${this.uri(artifact)}"
# One writer per key, so clearing the destination keeps a retry of this task from
# extracting over a half-written tree from its previous attempt.
rm -rf $dest
mkdir $dest
log $"${label}: downloading ($object)"

let t0 = (date now)
try {
  ^gcloud --verbosity=error storage cp $object - | ^zstd -d ${flag} -c | ^tar xf - -C $dest -o --no-same-permissions
} catch { |e|
  log $"${label}: task '${ctx.taskName}' consumes artifact '${artifact.name}' from task '${artifact.producerName}', but ($object) could not be fetched \\(($e.msg)\\)"
  exit 1
}

let path = "${this.path(artifact)}"
if not ($path | path exists) {
  log $"${label}: ($object) was fetched but contained nothing at ($path)"
  exit 1
}
let elapsed = (((date now) - $t0) | into int) / 1_000_000_000
log $"${label}: fetched to ($path) in ($elapsed)s"`,
            COMPRESSED_CACHE_LANGUAGE,
        );
    }
}

/**
 * Factory function for creating a {@link GcsArtifactStore}.
 *
 * @example
 * ```ts
 * new Task({ name: 'build', steps: [compile],
 *            artifactStore: gcsArtifacts({ bucket: 'my-ci-artifacts' }),
 *            produces: { dist: compile.outputs.bundle.toArtifact() } });
 * ```
 */
export function gcsArtifacts(opts: GcsArtifactStoreOptions): GcsArtifactStore {
    return new GcsArtifactStore(opts);
}
