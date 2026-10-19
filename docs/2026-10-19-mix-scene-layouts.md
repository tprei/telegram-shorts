# Mix accounts and scene layouts — implementation plan

## Decision, evidence, and boundaries

Implement reusable v3 `fixed`/`scenes` layouts, pure-domain scene composition inside `buildTimeline`, account-owned publishing capacity, and frozen layout/scene export inputs. Implement the six exclusively owned slices in §12; do not substitute another architecture. Existing seams: `src/domain/layout.ts:68-83`, `src/domain/timeline.ts:171-283`, `src/application/studio-service.ts:459-497`, `src/domain/model.ts:220-282`.

This is a specification, not a claim that proposed code already exists. File:line citations anchor current code/evidence being replaced or preserved; the replacement TS/JSON and algorithms below are normative. Settled design: `local://mix-design.md:26-75`; pipeline map: `local://layout-map.md:1-233`. **Later edge-refinement instruction supersedes design step 5:** average gradient profiles over up to eight evenly spaced cluster members, search ±1.2%, accept a positive peak ≥2× window median; otherwise retain median edge. Do not implement first-frame/±2.5%. The reported Borelli 609-versus-624-pixel error is operator-provided evidence, not a check run for this plan; reproducing script: `work/research/edge-eval2.mts:3-36`.

Bounded contexts: Source analysis owns the Job aggregate and whole-source SceneTrack; Short editing owns source-time overrides/focus; Composition converts these to placements; Export owns immutable render inputs; Publishing owns live PublishingAccounts and account-wide capacity; Autopilot watches channels per creator but books account slots. Keep domain composition free of Node, infra, and account/provider decisions. Existing model/edit zod schemas remain in their current modules; no schema relocation is part of this change. Current aggregate boundaries: `src/domain/model.ts:112-215`; intended account/channel split: `local://mix-design.md:65-74`.

Constraints: TypeScript ESM, `.js` relative imports in src, `Record<K,true>` static membership tables, no code comments/suppressions/`as any`/swallowed errors/shims. Keep existing zod schemas in `src/domain/model.ts`, `src/domain/edit.ts`, and `src/infra/layout.ts`; extend only the affected schemas in place and reuse their existing rectangle schemas. Keep the existing JSON storage parsing and provider failover behavior. Specified failed-shot inheritance, weak-edge retention, and midpoint change-point selection are deliberate algorithm rules. Boni/Jones fixed output and Boni publishing capabilities remain unchanged. Existing schema/storage/provider seams: `src/domain/edit.ts:1-71`, `src/domain/model.ts:1-3,284-392`, `src/infra/layout.ts:6-92`, `src/infra/db.ts:178-244`, `src/infra/instagram-publisher-factory.ts:45-131`.

## 1. Exact domain contracts

### 1.1 `src/domain/layout.ts`

Keep NormRect, NormPoint, PxRect, LayoutFont, ContentPanel, HostPanel, LayoutPanel, HookBandStyle, CaptionStyle, LayoutCanvas unchanged; replace LayoutProfile only. Retain captions.centerY for fixed; scenes uses its explicit host/content fractions and stack seam. Baseline: `src/domain/layout.ts:1-83`.

```ts
export type Composition = "stack" | "host" | "content";
export type PanelFill = "cover" | "contain";
export interface LayoutBase {
  version: 3;
  layoutId: string;
  canvas: LayoutCanvas;
  background: string;
  font: LayoutFont;
  hookBand: HookBandStyle | null;
  captions: CaptionStyle;
}
export interface FixedLayoutProfile extends LayoutBase {
  strategy: "fixed";
  panels: LayoutPanel[];
}
export interface ScenesLayoutProfile extends LayoutBase {
  strategy: "scenes";
  hookBand: HookBandStyle;
  scene: { captionCenterY: { host: number; content: number } };
}
export type LayoutProfile = FixedLayoutProfile | ScenesLayoutProfile;
```

### 1.2 `src/domain/model.ts`

Replace creator/manifest types and add scene/account types below. Delete CreatorPublishMode, CreatorPlatformPublishConfig, CreatorPublishConfig. Keep type imports of NormRect/LayoutProfile. Baseline: `src/domain/model.ts:75-89,108-130,171-190,220-282`.

```ts
export type SceneContentKind = "document" | "footage" | "person";
export type SceneAnalysisStatus = "none" | "queued" | "running" | "done" | "failed";
export interface SceneHost { camera: NormRect; head: NormRect }
export interface SceneContent {
  box: NormRect;
  kind: SceneContentKind;
  vertical: boolean;
  subject: NormRect;
}
export interface SceneSegment {
  startSeconds: number;
  endSeconds: number;
  host: SceneHost | null;
  content: SceneContent | null;
  overlays: NormRect[];
}
export interface SceneTrack {
  version: 1;
  analyzedAt: string;
  frame: { width: number; height: number };
  segments: SceneSegment[];
}
export interface PostingSchedule { timeZone: string; slots: string[] }
export interface PublishingAccount {
  id: string;
  displayName: string;
  schedule: PostingSchedule;
  platforms: ShortVideoPlatform[];
  mallaryProfileId: string | null;
  buffer: boolean;
}
export interface CreatorSceneConfig { hostDescription: string; hints: string | null }
export interface CreatorRenderConfig {
  layoutPath: string;
  layoutId: string;
  defaultSpeed: number;
  scene: CreatorSceneConfig | null;
}
export interface CreatorAutopilotConfig {
  channelUrl: string;
  shortsPerVideo: number;
  platforms: ShortVideoPlatform[];
  reviewWindowHours: number;
  bookingHorizonHours: number;
  maxShortAgeHours: number;
  minVideoSeconds: number;
}
export interface CreatorProfile {
  id: string;
  displayName: string;
  enabled: boolean;
  description?: string;
  accountId: string | null;
  render: CreatorRenderConfig;
  autopilot?: CreatorAutopilotConfig;
}
export interface CreatorProfileManifest {
  version: 3;
  defaultCreatorId?: string;
  accounts: PublishingAccount[];
  creators: CreatorProfile[];
}
export type QueueTaskKind = "process_source" | "analyze_host" | "analyze_scenes" | "plan_shorts" | "analyze_crops" | "export_short" | "publish_short_video" | "check_publication";
```

Insert exactly these fields after JobRecord.hostFramingAnalyzedAt (analysis status is independent of transcript/planning state):

```ts
  sceneTrack: SceneTrack | null;
  sceneAnalysis: SceneAnalysisStatus;
  sceneAnalysisError: string | null;
```

Insert exactly these fields after ExportRecord.hostFraming:

```ts
  layoutProfileSnapshot: LayoutProfile;
  sceneTrack: SceneTrack | null;
```

Add `analyze_scenes: Record<string, never>` to QueueTaskPayloads; ingest list becomes `["process_source","analyze_host","plan_shorts","analyze_scenes","analyze_crops"]`; output list unchanged. No second analysis lane. Baseline: `src/domain/model.ts:75-89`, `src/index.ts:96-109`.

Keep the existing zod import, response schema declarations, schema exports, and `z.infer` response types in model.ts unchanged. No new response-type interfaces or schema module are needed for this feature. Existing consumers retain their imports from domain/model; only scene/account/task/export types above change. Current declarations and consumers: `src/domain/model.ts:284-392`, `src/infra/openrouter.ts:5,227,257,294,324,357,381,414,577-580`, `src/infra/vision.ts:7,205,304`.

### 1.3 `src/domain/edit.ts`

Keep WordRange/CropKeyframe and existing operation signatures. Add type-only imports of Composition/LayoutProfile/SceneTrack. Replace ShortEdit verbatim; initialize the new layout in createInitialEdit and preserve it in normalizeEdit results. Extend ShortEditSchema in place as §2.1 specifies; its existing exports/import consumers remain unchanged. Baseline: `src/domain/edit.ts:1-71,106-172,180-269`.

```ts
export interface ShortLayoutEdit {
  split: number | null;
  overrides: { sourceSeconds: number; composition: Composition }[];
}
export interface ShortEdit {
  ranges: WordRange[];
  removedWords: number[];
  tightenPauses: { enabled: boolean; maxGapSeconds: number };
  speed: number;
  hook: { enabled: boolean; text: string };
  captions: { enabled: boolean };
  crops: CropKeyframe[];
  zoom: { enabled: boolean; strength: number };
  endCard: { enabled: boolean };
  layout: ShortLayoutEdit;
}
export function normalizeSceneEdit(edit: ShortEdit, layout: LayoutProfile, track: SceneTrack | null): ShortEdit;
```

`createInitialEdit` adds `layout: {split:null,overrides:[]}`. `normalizeEdit(edit, wordCount)` additionally rejects nonfinite/out-of-range split (allowed continuous [0.40,0.65]), rejects nonfinite/negative override time, stable-sorts/dedupes exact override times with last input winning. `normalizeSceneEdit` is the contextual second normalization stage: fixed rejects non-auto layout edits; scenes/null-track accepts only empty crops/overrides; otherwise resolve half-open containing segment, reject times outside track, reject crops without content, canonicalize override times to segment start, last override per segment wins. Host requires usable host (head occlusion ≤20%), content requires content, stack requires both. Vertical/full-frame-host rules select Auto but do not prohibit explicit stack if both operands exist. Do not silently coerce invalid compositions. Source rules: `local://mix-design.md:44-45,59-61`.

Scene crop focus is **content-box-local normalized**, mapped by `box.x+focus.x*box.w` etc; fixed crop focus remains full-frame normalized, as current storage actually uses. Do not reinterpret historical fixed crops. Evidence: `src/infra/vision.ts:110-125,207-211`, `src/domain/geometry.ts:60-69`.

## 2. Edge schemas, loader, and DTOs

### 2.1 Extend `src/domain/edit.ts` schemas in place

Keep the existing z import, NormRectSchema, WordRangeSchema, and CropKeyframeSchema unchanged. Add CompositionSchema/ShortLayoutEditSchema below and replace ShortEditSchema with the complete declaration below. api-types.ts keeps importing ShortEditSchema/WordRangeSchema from `../domain/edit.js`; no separate schema file or storage schema layer is added. Existing schemas/consumers: `src/domain/edit.ts:1-71`, `src/studio/api-types.ts:2,209-213,231-235`.

```ts
export const CompositionSchema = z.enum(["stack", "host", "content"]);
export const ShortLayoutEditSchema = z.strictObject({
  split: z.number().finite().min(0.4).max(0.65).nullable(),
  overrides: z.array(z.strictObject({ sourceSeconds: z.number().finite().nonnegative(), composition: CompositionSchema })),
});
export const ShortEditSchema = z.strictObject({
  ranges: z.array(WordRangeSchema).min(1),
  removedWords: z.array(z.number().int().min(0)),
  tightenPauses: z.strictObject({
    enabled: z.boolean(),
    maxGapSeconds: z.number().min(EDIT_LIMITS.minPauseGapSeconds).max(EDIT_LIMITS.maxPauseGapSeconds),
  }),
  speed: z.number().min(EDIT_LIMITS.minSpeed).max(EDIT_LIMITS.maxSpeed),
  hook: z.strictObject({ enabled: z.boolean(), text: z.string().max(EDIT_LIMITS.maxHookChars) }),
  captions: z.strictObject({ enabled: z.boolean() }),
  crops: z.array(CropKeyframeSchema),
  zoom: z.strictObject({ enabled: z.boolean(), strength: z.number().min(EDIT_LIMITS.minZoom).max(EDIT_LIMITS.maxZoom) }),
  endCard: z.strictObject({ enabled: z.boolean() }),
  layout: ShortLayoutEditSchema,
});
```

### 2.2 `src/infra/layout.ts`

Keep the existing local RectSchema and all of its uses; keep HexColorSchema/NormPointSchema/ContentPanelSchema/HostPanelSchema/PanelSchema validators unchanged. Extract the existing font/hook/caption validators into FontSchema/HookBandSchema/CaptionStyleSchema constants, preserving every field/bound. Replace the local outer schema exactly below; it remains a file-loader schema, not a DB read validator. loadLayoutProfile keeps its signature and accepts v3 only, no compatibility loader. Current validators: `src/infra/layout.ts:6-92`.

```ts
const BaseLayoutShape = {
  version: z.literal(3), layoutId: z.string().min(1),
  canvas: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive() }),
  background: HexColorSchema, font: FontSchema, captions: CaptionStyleSchema,
};
const FixedLayoutSchema = z.strictObject({
  ...BaseLayoutShape, strategy: z.literal("fixed"), hookBand: HookBandSchema.nullable(), panels: z.array(PanelSchema).min(1),
}).refine(l => l.panels.filter(p => p.role === "content").length <= 1 && l.panels.filter(p => p.role === "host").length <= 1, { message: "At most one panel of each role" });
const ScenesLayoutSchema = z.strictObject({
  ...BaseLayoutShape, strategy: z.literal("scenes"), hookBand: HookBandSchema,
  scene: z.strictObject({ captionCenterY: z.strictObject({ host: z.number().min(0).max(1), content: z.number().min(0).max(1) }) }),
}).refine(l => l.canvas.width === 1080 && l.canvas.height === 1920 && l.hookBand.rect.x === 0 && l.hookBand.rect.y === 0 && l.hookBand.rect.w === 1 && l.hookBand.rect.h < 1, { message: "Scenes requires a 1080x1920 canvas with a full-width top header" });
const LayoutProfileSchema = z.discriminatedUnion("strategy", [FixedLayoutSchema, ScenesLayoutSchema]);
```

### 2.3 `src/infra/creator-profile-loader.ts`

Retain PostingScheduleSchema and CreatorAutopilotConfigSchema bounds/IANA/public-YouTube checks from `src/infra/creator-profile-loader.ts:15-67`; replace empty validation catch with explicit expected Error handling/rethrow unexpected values. Delete PublishTargetSchema/publishConfigForPlatform. Import EDIT_LIMITS from domain; replace manifest schemas:

```ts
const PublishingAccountSchema = z.strictObject({
  id: z.string().min(1), displayName: z.string().min(1), schedule: PostingScheduleSchema,
  platforms: z.array(z.enum(["instagram", "tiktok", "youtube_shorts"])).min(1).max(3)
    .refine(p => new Set(p).size === p.length, { message: "Duplicate account platform" }),
  mallaryProfileId: z.string().min(1).nullable(), buffer: z.boolean(),
});
const CreatorProfileSchema = z.strictObject({
  id: z.string().min(1), displayName: z.string().min(1), enabled: z.boolean(), description: z.string().min(1).optional(),
  accountId: z.string().min(1).nullable(),
  render: z.strictObject({
    layoutPath: z.string().min(1), layoutId: z.string().min(1), defaultSpeed: z.number().min(EDIT_LIMITS.minSpeed).max(EDIT_LIMITS.maxSpeed),
    scene: z.strictObject({ hostDescription: z.string().min(1), hints: z.string().min(1).nullable() }).nullable(),
  }),
  autopilot: CreatorAutopilotConfigSchema.optional(),
});
const CreatorProfileManifestSchema = z.strictObject({
  version: z.literal(3), defaultCreatorId: z.string().min(1).optional(),
  accounts: z.array(PublishingAccountSchema), creators: z.array(CreatorProfileSchema).min(1),
});
```

validateManifest rejects duplicate account/creator IDs, duplicate non-null Mallary IDs, >1 Buffer account, missing account references, autopilot without account, autopilot platforms outside account platforms, missing/disabled manifest default. Load **all** creator layouts including disabled ones: layoutId must match and `(strategy === "scenes") === (render.scene !== null)`. Remove layout.creatorId check. Null Mallary ID is valid render configuration. Preserve creator selection requested > studio default > manifest default > first enabled. Baseline: `src/infra/creator-profile-loader.ts:140-189`; design: `local://mix-design.md:65-73`.

Add these repository members; each operation resolves profile and account from a single freshly parsed manifest, never permissions from an old job snapshot. Existing repository: `src/infra/creator-profile-loader.ts:95-134`.

```ts
export interface ResolvedPublishingProfile { profile: CreatorProfile | null; account: PublishingAccount | null }
getPublishingAccountById(id: string): Promise<PublishingAccount | null>;
resolvePublishingProfile(creatorId: string): Promise<ResolvedPublishingProfile>;
```

### 2.4 Stored records retain current JSON parsing

Keep job/summary/short/export read/create/update parsing and serialization as it is today; add no stored-record zod schemas, projected-field parser, or read-time validation. The one v8 migration transforms the affected rows, and `tests/db-mix-migration.test.ts` proves the historical-to-current shapes. Whole-job track coverage, adjacency, dimensions, and usable observations are postconditions of analyzeScenes (§5.1), not storage read checks. Export tracks may have gaps because only overlapping whole-source segments are frozen. Existing JSON approach and media/freeze inputs: `src/infra/db.ts:178-244`, `src/domain/model.ts:61-69`, `local://mix-design.md:40`.

### 2.5 Exact `src/studio/api-types.ts` DTO delta

Keep ShortEditSchema/WordRangeSchema imported from `../domain/edit.js`; add new domain names type-only. Add these interfaces, replace CreatorDto; existing shapes: `src/studio/api-types.ts:18-22,25-43,133-171,300-318`.

```ts
export interface PublishingAccountDto {
  id: string;
  displayName: string;
  schedule: PostingSchedule;
  platforms: ShortVideoPlatform[];
  connected: boolean;
}
export interface CreatorDto { id: string; displayName: string; isDefault: boolean; accountId: string | null }
export interface SceneAnalysisDto { status: SceneAnalysisStatus; error: string | null }
```

Add `sceneAnalysis: SceneAnalysisDto` to JobSummaryDto (therefore JobDetailDto), `accountId: string` to ScheduledPostDto. Replace ShortDetailDto.job verbatim below; remove job.schedule, no alias. Account DTO intentionally excludes Mallary ID. takenSlots is account-wide, server-deduped one start per short, including already posted starts needed for capacity.

```ts
  job: {
    id: string;
    title: string | null;
    sourceUrl: string;
    thumbnailUrl: string | null;
    media: JobMediaDto;
    layout: LayoutProfile;
    hostFraming: HostFraming | null;
    sceneTrack: SceneTrack | null;
    sceneAnalysis: SceneAnalysisDto;
    fontUrl: string;
    account: PublishingAccountDto | null;
    takenSlots: string[];
  };
```

Add these fields to AutopilotStatusDto and replace its existing schedule field. Source: `src/studio/api-types.ts:300-318`.

```ts
  accountId: string | null;
  accountConnected: boolean;
  reason: string | null;
  schedule: PostingSchedule | null;
```

Add/change exact StudioApi methods below; await the formerly synchronous methods in server routes. Other signatures unchanged. Baseline: `src/studio/api-types.ts:256-281`, `src/studio/server.ts:125-129,153-155`.

```ts
  analyzeScenes(jobId: string): JobDetailDto;
  createManualShort(jobId: string, request: CreateManualShortRequest): Promise<ShortDetailDto>;
  listScheduledPosts(): Promise<ScheduledPostDto[]>;
```

## 3. Pure scene domain: `src/domain/scene.ts`

Only imports from `./model.js`, `./layout.js`, and pure geometry. Move median math here and import/re-export nothing from infra; vision imports median helpers from here, retaining its public medianValue/medianHeadBox functions as ordinary direct implementations using shared medianEdges where current tests consume them (these are not deprecated aliases). Existing head/median logic: `src/domain/geometry.ts:72-137`, `src/infra/vision.ts:252-267`. Public signatures and constants:

```ts
export const SCENE_MIN_SHOT_SECONDS = 0.5;
export const SCENE_SAMPLE_LEAD_SECONDS = 0.6;
export const SCENE_SAMPLE_INTERVAL_SECONDS = 12;
export const CAMERA_CLUSTER_IOU = 0.7;
export const CAMERA_FULL_FRAME_EDGE_TOLERANCE = 0.02;
export const CAMERA_EDGE_RADIUS_SHARE = 0.012;
export const CAMERA_EDGE_PEAK_RATIO = 2;
export const CAMERA_EDGE_MAX_FRAMES = 8;
export const HOST_OCCLUSION_MAX_SHARE = 0.2;
export const SCENE_EPSILON = 1e-6;
export interface SceneShot { startSeconds: number; endSeconds: number }
export interface SceneObservation { sourceSeconds: number; host: SceneHost | null; content: SceneContent | null; overlays: NormRect[] }
export interface CameraCluster { id: number; camera: NormRect; memberIndices: number[] }
export interface ClusteredObservation extends SceneObservation { cameraClusterId: number | null }
export interface ClusteredSceneSegment extends SceneSegment { cameraClusterId: number | null }
export interface GreyFrame { width: number; height: number; data: Uint8Array }
export type CameraEdge = "left" | "right" | "top" | "bottom";
export function rectContains(bounds: NormRect, inner: NormRect): boolean;
export function rectIntersectionArea(a: NormRect, b: NormRect): number;
export function rectIoU(a: NormRect, b: NormRect): number;
export function medianEdges(rects: readonly NormRect[]): NormRect;
export function isFullFrameCamera(camera: NormRect): boolean;
export function buildSceneShots(cuts: readonly number[], durationSeconds: number, fps: number): SceneShot[];
export function sceneSampleTimes(shot: SceneShot): number[];
export function clusterCameras(observations: readonly SceneObservation[]): { observations: ClusteredObservation[]; clusters: CameraCluster[] };
export function evenlySpacedMemberIndices(memberIndices: readonly number[], maxFrames: number): number[];
export function meanEdgeGradient(frames: readonly GreyFrame[], camera: NormRect, edge: CameraEdge, positionPx: number): number;
export function refineCameraEdges(camera: NormRect, frames: readonly GreyFrame[]): NormRect;
export function snapCameraClusters(observations: readonly ClusteredObservation[], cameras: ReadonlyMap<number, NormRect>): ClusteredObservation[];
export function sceneSignature(observation: ClusteredObservation): string;
export function buildSceneSegments(shots: readonly SceneShot[], observations: readonly ClusteredObservation[], changes: readonly { shotIndex: number; sourceSeconds: number; rightObservationIndex: number }[]): ClusteredSceneSegment[];
export function smoothSceneHeads(segments: readonly ClusteredSceneSegment[]): SceneSegment[];
export function hostUsable(segment: SceneSegment): boolean;
export function allowedCompositions(segment: SceneSegment): Composition[];
export function defaultComposition(segment: SceneSegment): Composition;
export function sceneAt(track: SceneTrack, sourceSeconds: number): SceneSegment | null;
export function freezeSceneTrack(track: SceneTrack, spans: readonly { sourceStart: number; sourceEnd: number }[]): SceneTrack;
```

Implement these steps in order:

1. Intersection is positive overlap width×height; IoU=intersection/union; containment tolerance=1e-6. Per-edge median independently sorts left/top/right/bottom, averages middle two if even, rejects empty input. Full-frame camera has each edge within 0.02 of its frame edge, canonicalized to full frame, cluster ID −1; absent host ID null. Baseline: `src/infra/vision.ts:252-267`, `src/domain/geometry.ts:12-28`.
2. Validate positive duration/fps; round cut times to nearest source frame, discard outside (0,duration), sort/dedupe, prepend 0/append exact duration. Merge shots <0.5 seconds into previous; first short shot merges forward; one short whole video remains. Never drop coverage. Sample each shot at start+min(0.6,0.25*duration), then +12,+24,… strictly before end. Design: `local://mix-design.md:34-35`.
3. Visit successful observations chronologically, tie original index. Non-full cameras join first cluster whose current per-edge median has IoU≥0.7, else new cluster; recompute median on insertion. After all insertions snap every member to final median. Full-frame cameras use −1, never pixel-refined. No content/head clustering. Design: `local://mix-design.md:38`.
4. Pick k=min(8,n) members using indices round(i*(n−1)/(k−1)), i=0..k−1; k=1 first only. Infra supplies equal-size raw greyscale frames. For vertical edge p average abs(Y[y,p]−Y[y,p−1]) over y in rounded camera span; horizontal analog over x. Average span means across frames, not winning coordinates. Search integer p around round(edge*dimension) ±round(0.012*dimension), valid p=1..dimension−1. Median is median of these averaged scores. Peak ties: nearest predicted edge then smaller p; accept positive peak≥2*median, otherwise original median edge. Exact border edges 0/1 stay unchanged. Search each edge using original median span, not previously refined spans; reject an individual edge move that invalidates positive camera area or excludes a member head. No Buffer copy in domain. Revised evidence: `work/research/edge-eval2.mts:3-36`.
5. Snap refined cameras back to all members. Signature is host present / cluster ID / content present / vertical, explicit deterministic tokens, not box coordinates; kind/subject motion alone does not split. Infra supplies one refined change time per disagreeing adjacent successful sample pair (§5). Build intervals at shot+change boundaries. A change carries rightObservationIndex, the index of the later disagreeing sample in the chronologically clustered observation array. The interval before the first change starts with the first successful observation; each changed interval starts with its designated right-hand observation even when its sample time is later than the refined boundary. Within an interval, use the latest observation from that same signature run at/before interval midpoint, or its designated starting observation when none precedes the midpoint. Never let the old observation leak past a localized change. A zero-success shot inherits the final observation of the nearest preceding shot with a successful observation; if none exists, use the first observation of the next successful shot. Apply that rule to every shot in a leading run of failures. Inherited observations do not count as successful samples. A both-absent host/content response is a failed sample, not a fatal shot or job; the accepted sample ratio guarantees at least one successful observation is available. Design: `local://mix-design.md:36-37,44-45`.
6. Consecutive output segments sharing non-null cluster ID form a head-smoothing run, including −1 full-frame; absent host breaks run. Use median head edges for run, intersect with camera, leave content/overlays/timing unchanged, strip cluster IDs before persistence. sceneAt uses half-open intervals; exact whole-track end returns last only for read-only playhead inspection, not override normalization. freezeSceneTrack deep-copies positive-overlap segments, retains original boundaries/analyzedAt/frame. Design: `local://mix-design.md:39-40,59-61`.
7. hostUsable requires host and content/head overlap≤20% head area. Auto order: no content→host; no/unusable host or vertical content→content; full-frame host and non-document→host; otherwise stack. Neither operand→error. allowedCompositions returns ordered stack/host/content, omitting unavailable operands; explicit stack allowed for vertical when both exist. Design: `local://mix-design.md:44-45,59`.

## 4. Pure composition, timeline, and render parity

### 4.1 New `src/domain/composition.ts`

Import hostSourceCrop/normToPx/toEvenPxRect from geometry and domain types only. In geometry replace HostPanelFill with imported PanelFill and output literal blur→contain only; existing head-aware geometry stays unchanged. Baseline: `src/domain/geometry.ts:72-137`; design: `local://mix-design.md:47-55`.

```ts
export const STACK_SPLITS: readonly number[] = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65];
export const CONTENT_GRID_STEPS = 24;
export const CONTENT_SCALE_STEPS = 13;
export const CONTAIN_EXPANSION_STEPS = 5;
export const EXCLUSION_OVERLAP_RESOLUTION = 0.01;
export const CONTENT_MAX_ZOOM = 2.5;
export const WIDE_SUBJECT_ASPECT_MULTIPLIER = 1.6;
export const FLASH_OUTPUT_SECONDS = 0.5;
export const SPLIT_COST_EPSILON = 1e-9;
export interface CompositionSource { width: number; height: number }
export interface ContentWindow {
  source: PxRect;
  fill: PanelFill;
  displayedWidthPx: number;
  displayedFocusWidthPx: number;
  subjectCutShare: number;
}
export interface CompositionSpan { segment: SceneSegment; composition: Composition; focus: NormRect | null; outputSeconds: number; zoom: number }
export interface CompositionPlacement { panelId: string; role: "content" | "host"; source: PxRect; canvas: PxRect; fill: PanelFill }
export function contentFocus(segment: SceneSegment, localFocus: NormRect | null): NormRect;
export function contentWindow(input: { segment: SceneSegment; focus: NormRect | null; source: CompositionSource; canvas: PxRect }): ContentWindow;
export function hostWindow(input: { segment: SceneSegment; source: CompositionSource; canvas: PxRect; zoom: number }): { source: PxRect; fill: PanelFill };
export function compositionPanels(input: { segment: SceneSegment; composition: Composition; focus: NormRect | null; source: CompositionSource; layout: ScenesLayoutProfile; split: number; zoom: number }): CompositionPlacement[];
export function chooseStackSplit(input: { spans: readonly CompositionSpan[]; layout: ScenesLayoutProfile; source: CompositionSource }): number;
export function captionY(layout: LayoutProfile, composition: Composition | null, split: number | null): number;
export function containForeground(source: PxRect, canvas: PxRect): PxRect;
```

Content window algorithm (source **pixels**, never normalized aspect ratios; exclusions are soft costs and never cause an exception):

1. Focus = local keyframe mapped through content.box, else subject; bounds=content.box. Exclusions=positive intersections of overlays with bounds, plus host.camera **only for a non-full-frame camera wholly inside bounds**. Measure overlap share as area(candidate ∩ union(exclusions))/area(candidate), counting overlapping exclusion boxes once. Form disjoint exclusion rectangles once per contentWindow call by sorting exclusion x-edges and merging covered y-intervals inside each resulting x-strip; each grid candidate then sums intersection areas without allocating candidate arrays. Compare overlap at 0.01 resolution using `Math.round(overlapShare / EXCLUSION_OVERLAP_RESOLUTION)`. This prefers avoiding embedded PiP/chat but permits unavoidable overlap. Original exclusion inputs: `local://mix-design.md:18-23,47`; source focus mapping: `src/infra/vision.ts:110-125`.
2. Aspect A=panel.w/panel.h; Wmax=min(bounds.w,bounds.h*A), Wmin=max(focus.w,focus.h*A,Wmax/2.5). If Wmin≤Wmax enumerate 13 inclusive linearly spaced widths largest→smallest; h=w/A. Legal x range=[max(bounds.x,focus.right−w),min(bounds.right−w,focus.x)], y analog. Enumerate 24 inclusive positions per legal axis (one for zero span). Reject only empty geometric ranges, never a candidate because it overlaps an exclusion. Rank lexicographically: rounded exclusion-overlap share ascending, area descending, squared focus-center distance ascending, y ascending, x ascending. Compare **all scales**, retaining one best candidate in scalar loops; a smaller crop may avoid more overlay than the first fitting scale. Design search inputs: `local://mix-design.md:47`; later scope decision makes exclusions soft.
3. A focus unable to fit at the panel aspect, including document focus, or footage/person subject aspect>1.6*A, uses contain. Contain starts with the focus box and expands its short axis toward A within content bounds: when focus.w/focus.h>A, hold width and expand height toward min(bounds.h,focus.w/A); otherwise hold height and expand width toward min(bounds.w,focus.h*A). Evaluate five expansion fractions 0,0.25,0.5,0.75,1; center each on focus and clamp its position inside bounds while retaining the focus. Use the same overlap-bucket/area/center/y/x ranking as cover. Fraction0 always exists for a valid focus, so overlays can never make contain impossible. The 2.5 cover-search zoom bound does not replace the specified focus-based contain rectangle. Never enumerate safe rectangles or reject unavoidable chat overlap. Documents retain the complete focus horizontally. Aspect/contain inputs: `local://mix-design.md:47`.
4. Quantize the selected source edges outward to even pixels, clipped to source-frame bounds, and recompute displayed-width/subject-cut metrics on the actual crop. Pixel-boundary or overlay overlap stays a soft cost, not an error; buildTimeline must never throw because of exclusions. subjectCutShare=clamp(1−intersection(subject,crop)/area(subject),0,1). displayedWidthPx is sharp foreground width (panel width for cover); displayedFocusWidthPx=focus.w*scale. Fixed retains its existing toEvenPxRect path unchanged. Baseline even-pixel convention: `src/domain/geometry.ts:16-23`.
5. hostWindow constructs transient HostPanel with camera bounds, anchor {x:0.5,y:0.42}, passes smoothed full-frame head/zoom/panel aspect into existing hostSourceCrop; reject unusable/absent host. Stage begins at even-pixel header bottom (220 Mix), ends at canvas bottom; allocation remains when hook text off. Stack content.h=2*round(stage.h*split/2), host gets remainder, no seam gaps. Full host/content fills stage. Stable IDs content/host; fixed IDs unchanged. Baseline: `src/domain/geometry.ts:86-137`, `src/domain/timeline.ts:285-310`; design: `local://mix-design.md:46-48`.

Split cost: evaluate each candidate on retained stack spans, including focus subdivisions/zoom, weighted by output duration after cuts/speed/frame quantization; non-stack weight zero. F=focus width in source pixels, D=displayed focus width, B=displayed foreground width, Hs=source.height. L=(D/F)*(Hs/1080)/0.5625. Document cost=2*max(0,1−L)^2 + (contain?0.3*(1−B/1080):0); footage/person cost=(contain?0.5*(1−B/1080):0)+2*subjectCutShare. Add host cost=2*max(0,(0.38−hostShare)/0.38)^2+0.5*max(0,upscale−2.2)^2, hostShare=hostCanvas.h/stage.h, upscale=hostCanvas.h/(hostCrop.h*1080/Hs). Minimize weighted mean; ties within 1e-9 nearest 0.5 then smaller split; no stacks→0.5. Manual continuous [0.40,0.65] split bypasses search. Clarification: displayedWidth in the legibility term means displayed **focus**, not whitespace around it; contained-width penalty uses B. Formula source: `local://mix-design.md:49-53`; prototype to replace: `work/research/compose-eval.mts:71-84`.

captionY: fixed captions.centerY; scenes stack actual rounded seam/1920; host/content explicit full-canvas fractions. Assign per cue from clip at cue start, hold through cue even if layout changes mid-cue. Existing global positions: `src/infra/ass.ts:42-51`, `web/src/preview/draw.ts:104-129`; design: `local://mix-design.md:54`.

### 4.2 Exact timeline changes

Change TimelinePanelPlacement.fill to PanelFill; add `composition: Composition | null`, `sceneStartSeconds: number | null`, `captionCenterY: number` to TimelineClip; add `centerY: number` to CaptionCue; add `stackSplit: number | null` to Timeline. Null metadata identifies fixed, all Y values full-canvas fractions. Declarations: `src/domain/timeline.ts:8-37,77-87`. Replace buildTimeline input exactly:

```ts
export function buildTimeline(input: {
  edit: ShortEdit;
  words: TranscriptWord[];
  layout: LayoutProfile;
  title: string;
  source: { width: number; height: number; durationSeconds: number };
  hostFraming: HostFraming | null;
  sceneTrack: SceneTrack | null;
}): Timeline;
```

1. Preserve computeSourceClips/kept-word/pause pads. Fixed retains crop margin/quantization/zoom/panel/hook/caption/end-card behavior, with explicit new metadata. Scenes requires matching track coverage or throws `Scene analysis is required before composing this short.` No optional sceneTrack or switch to fixed. Baseline: `src/domain/timeline.ts:117-283`.
2. Split every scene boundary inside each base clip, **without** 0.3-second margin; then split at crop times inside that segment. Latest keyframe≤clip start in that same segment wins; no cross-segment inheritance or fixed-style crop anticipation. No crop→own subject. Canonical override for segment start wins, else Auto. Artificial joins remain joinsPrevious=true and do not toggle zoom. Existing split/anticipation: `src/domain/timeline.ts:182-237`; intended scope: `local://mix-design.md:59-61`.
3. Scenes frame boundaries use cumulative retained source seconds: targetFrames=round(cumulative/edit.speed*fps), clip frames=delta from previous target; drop zero-frame subclips. Keep exact source boundaries, never extend across scene cuts for frame rounding. Output timestamps=frames/fps. Source/output mapping uses each clip local duration ratio (inverse on outputToSource); algebraically unchanged for fixed. Renderer enforces explicit output frame count (§6). Preview seeks at boundaries as before. Baseline mappers/render: `src/domain/timeline.ts:202-218,429-461`, `src/infra/render.ts:135-174`.
4. Flash classification uses total **retained output duration per scene segment**, not each crop/word fragment. <0.5s inherits preceding displayed segment composition, source/canvas/fill geometry and captionY literally. First retained flash uses own legal geometry; consecutive flashes propagate last displayed geometry. Inherited operand may be absent in flash observation; do not revalidate inherited placement. Flash overrides remain stored but do not affect output; UI explains this. Classify by timing before split search; search non-inherited stack spans, then apply inheritance. Design: `local://mix-design.md:55`.
5. Choose split once; place each non-flash clip using its own scene/scoped focus/zoom and the shared split. Build existing cue text/grouping; set cue.centerY from half-open output clip active at cue.outputStart, no mid-cue motion. Hook/end card unchanged. Add required sceneTrack at both production calls and all test calls: `src/application/pipeline.ts:338-346`, `web/src/containers/ShortEditorPage.tsx:167-180`, `tests/timeline.test.ts:182-427,451-515`, `tests/render.test.ts:162,413-422`. Fixed callers pass null. Browser reruns the same domain engine via alias, never duplicates composition (`web/tsconfig.json:14-20`).


## 5. Scene infra: new `src/infra/scenes.ts`

Declare sharp runtime dependency with `pnpm add --save-exact sharp@0.34.5` (S3 owns package.json/pnpm-lock.yaml). Research imports do not declare application dependencies; current package lacks sharp (`package.json:18-26`); greyscale API evidence: `work/research/edge-eval2.mts:1-5`.

Imports: mkdir/readFile from node:fs/promises, join from node:path, sharp, zod, runProcess from `./process.js`, requestStructuredJson from `./openrouter.js`, logError/nowIso from `./util.js`, scene functions from `../domain/scene.js`, domain types type-only. No browser dependencies. Existing infra convention: `src/infra/vision.ts:1-23,195-206,307-313`.

```ts
export const SCENE_DETECT_FPS = 5;
export const SCENE_DETECT_WIDTH = 256;
export const SCENE_DETECT_THRESHOLD = 10;
export const SCENE_CUT_REFINE_SECONDS = 0.4;
export const SCENE_FRAME_WIDTH = 1280;
export const SCENE_VISION_CONCURRENCY = 6;
export const SCENE_VISION_TEMPERATURE = 0.1;
export const SCENE_SCAN_TIMEOUT_MS = 30 * 60_000;
export const SCENE_REFINE_TIMEOUT_MS = 120_000;
export const SCENE_EXTRACT_TIMEOUT_MS = 60_000;
export const SCENE_VISION_TIMEOUT_MS = 90_000;
export interface ScdetScore { sourceSeconds: number; score: number }
export function parseScdetScores(text: string, offsetSeconds: number): ScdetScore[];
export async function detectShotCuts(input: { videoPath: string; durationSeconds: number; fps: number }): Promise<number[]>;
export async function refineShotCut(input: { videoPath: string; candidateSeconds: number; durationSeconds: number; fps: number }): Promise<number>;
export async function locateInShotChange(input: { videoPath: string; fromSeconds: number; toSeconds: number; camera: NormRect; source: { width: number; height: number }; fps: number }): Promise<number>;
export async function analyzeScenes(input: { config: AppConfig; media: SourceMedia; scene: CreatorSceneConfig; workDir: string }): Promise<SceneTrack>;
```

### 5.1 Passes, sampling, errors, and change points

1. Full pass argv: `ffmpeg -nostdin -hide_banner -v info -i <video> -an -vf "fps=5,scale=256:-2,scdet=threshold=10,metadata=mode=print:key=lavfi.scd.score" -f null -`; 30min timeout. Parse metadata frame pts_time and its lavfi.scd.score together; collect scores≥10, never unrelated log numbers. No shell interpolation. Native timestamp offsets are explicit. Detection design: `local://mix-design.md:34`; process interface: `src/infra/process.ts:15-64`.
2. Refine each cut in [max(0,t−0.4),min(duration,t+0.4)], accurate decode at native fps, no fps filter; scale=256:-2, same metadata scores. Max score≥10 wins, tie nearest coarse cut then earlier frame; add window offset, round nearest source frame. No peak→retain rounded coarse cut. Sort/dedupe, then buildSceneShots. Limit extraction/refinement to two ffmpeg processes, not six simultaneous decoders. Design: `local://mix-design.md:34`.
3. Extract full-frame 1280-wide JPEG q3 per pure sample time, accurate seek, one output frame, 60s timeout, `<jobDir>/scenes/<sampleIndex>_<milliseconds>.jpg`. Vision calls concurrency six, chronological output regardless of completion. Each attempted sample counts, including extraction/validation failures. Log sample time/cause. Successes must be ≥ceil(total/2), else throw `Scene analysis succeeded on X of Y samples; at least 50% are required.` with last cause. Any no-success shot inherits the previous successful shot, or the next successful shot when there is no previous one, including black/logo intros. Among sample failure/empty-content outcomes, only a success ratio below 50% fails the task; do not add a leading-shot or empty-shot failure condition. No partial track persistence. Existing extraction/error pattern: `src/infra/vision.ts:215-233,287-325`; required threshold: `local://mix-design.md:35-36`.
4. Cluster successful observations and snap cameras. For each non-full cluster select ≤8 evenly spaced members; decode `sharp(path).greyscale().raw().toBuffer({resolveWithObject:true})`, require channels=1/equal dimensions, pass data/width/height to pure gradient math. Decode one cluster at a time; supply no copied pixel buffers. Average gradient **profiles** over selected members, ±1.2% radius, ≥2×median acceptance, exact border retention; snap refined rectangles to all members. Revised evidence: `work/research/edge-eval2.mts:3-36`.
5. Compare adjacent successful samples within each shot using snapped signatures. On disagreement, crop union of both host camera rectangles (single camera if only one; full frame if neither), native-rate scdet between their times, width≤256, threshold 10, timeout120s. Highest peak strictly between samples wins; tie nearest midpoint then earliest. No peak→midpoint. Quantize source-frame time, keep strictly inside parent shot; never create empty interval. One split per disagreeing sample pair carrying rightObservationIndex for domain assignment, no recursion/additional model calls. This locates inset disappearances/moves that global cuts miss. Design: `local://mix-design.md:37`; existing regional ffmpeg form: `src/infra/vision.ts:129-147`.
6. Build/smooth segments and enforce analyzeScenes postconditions before returning: frame dimensions match original media; first start=0; last end=media.durationSeconds; ordered positive-length segments are adjacent within1e-6 and nonoverlapping; each persisted segment has host or content after failed-shot inheritance; head/content subject boxes remain inside their respective camera/content boxes. Set version1/analyzedAt now/frame original source dimensions. Test these postconditions in tests/scenes.test.ts; do not revalidate tracks at storage reads. Analysis JPEG dimensions drive only pixel refinement; source dimensions drive composition. No confidence-based fallback or per-frame tracker. Shape: `local://mix-design.md:39-40`.

### 5.2 Exact Gemini prompt, zod, and JSON schema

Use this pt-BR system prompt and user text, adapted from `work/research/scene-eval.mts:24-61`, matching `src/infra/vision.ts:37-55` convention:

```ts
const SCENE_SYSTEM_PROMPT = [
  "Você analisa um quadro de um vídeo horizontal de comentários do YouTube para recompor um short vertical 9:16.",
  "Todas as caixas são box_2d: [ymin, xmin, ymax, xmax], inteiros de 0 a 1000 relativos à imagem inteira.",
  "Identifique o apresentador descrito pelo usuário, não um convidado, jornalista ou pessoa no material exibido.",
  "host_camera_box: limites exatos da câmera do apresentador, incluindo todo o inset ou painel lateral. Se a câmera ocupa o quadro inteiro, use [0,0,1000,1000]. Se ausente, host_visible=false e ambas as caixas do apresentador [0,0,0,0].",
  "host_head_box: do topo do cabelo à base do queixo, de orelha a orelha; exclua pescoço, ombros e microfone. Deve ficar dentro da câmera.",
  "content_box: limites do material principal além da câmera: artigo, postagem, gráfico, slide, tabela, foto, vídeo, reportagem ou janela de chamada de um convidado. Exclua margens vazias ou desfocadas, barras pretas, chat, QR codes, logotipos e faixas.",
  "content_kind: document para texto, artigos, postagens, slides, gráficos ou tabelas; person quando o material é principalmente uma pessoa falando; footage para os demais vídeos e fotos; none quando não há conteúdo.",
  "content_vertical: true quando o material é um vídeo ou foto em orientação retrato, sem contar o fundo desfocado.",
  "subject_box: dentro do conteúdo, a região que precisa aparecer: cabeça e ombros de quem fala, manchete, texto destacado ou evidência visual principal. Não confunda com a cabeça do apresentador.",
  "Se não houver conteúdo, use content_visible=false, content_kind=none, content_vertical=false e content_box/subject_box=[0,0,0,0].",
  "overlay_boxes: caixas exatas de chat, QR codes, logotipos, inscrições, faixas, rodapés e intérpretes de Libras. Não inclua a câmera do apresentador nesta lista.",
  "reason: justificativa curta em português. Retorne somente o objeto JSON solicitado.",
].join("\n");
const userText = `Apresentador deste canal: ${input.scene.hostDescription}\nOrientações adicionais: ${input.scene.hints === null ? "Nenhuma." : input.scene.hints}\nAnalise este quadro.`;
const BoxSchema = z.tuple([z.number().int().min(0).max(1000), z.number().int().min(0).max(1000), z.number().int().min(0).max(1000), z.number().int().min(0).max(1000)]);
const visibleBox = (b: [number, number, number, number]): boolean => b[0] < b[2] && b[1] < b[3];
const zeroBox = (b: [number, number, number, number]): boolean => b.every(v => v === 0);
export const SceneVisionResponseSchema = z.strictObject({
  host_visible: z.boolean(), host_camera_box: BoxSchema, host_head_box: BoxSchema,
  content_visible: z.boolean(), content_box: BoxSchema, content_kind: z.enum(["document", "footage", "person", "none"]),
  content_vertical: z.boolean(), subject_box: BoxSchema, overlay_boxes: z.array(BoxSchema), reason: z.string().min(1),
}).refine(r => r.host_visible ? visibleBox(r.host_camera_box) && visibleBox(r.host_head_box) : zeroBox(r.host_camera_box) && zeroBox(r.host_head_box), { message: "Invalid host boxes" })
  .refine(r => r.content_visible ? r.content_kind !== "none" && visibleBox(r.content_box) && visibleBox(r.subject_box) : r.content_kind === "none" && !r.content_vertical && zeroBox(r.content_box) && zeroBox(r.subject_box), { message: "Invalid content boxes" })
  .refine(r => r.overlay_boxes.every(visibleBox), { message: "Invalid overlay box" })
  .refine(r => r.host_visible || r.content_visible, { message: "No usable visual material" });
export type SceneVisionResponse = z.infer<typeof SceneVisionResponseSchema>;
const BOX_JSON = { type: "array", items: { type: "integer", minimum: 0, maximum: 1000 }, minItems: 4, maxItems: 4 };
export const SCENE_VISION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false,
  properties: {
    host_visible: { type: "boolean" }, host_camera_box: BOX_JSON, host_head_box: BOX_JSON,
    content_visible: { type: "boolean" }, content_box: BOX_JSON,
    content_kind: { type: "string", enum: ["document", "footage", "person", "none"] },
    content_vertical: { type: "boolean" }, subject_box: BOX_JSON,
    overlay_boxes: { type: "array", items: BOX_JSON }, reason: { type: "string" },
  },
  required: ["host_visible", "host_camera_box", "host_head_box", "content_visible", "content_box", "content_kind", "content_vertical", "subject_box", "overlay_boxes", "reason"],
};
```

The final No usable visual material refinement rejects only that sample: catch it with other sample extraction/model/parse failures, log its cause, count it in the failed-sample denominator, and continue. It must not directly fail the task or job. Convert successful boxes /1000, require head inside camera and subject inside content within1e-6, reject inconsistent model boxes rather than silently clamp. One image/call, configured OPENROUTER_VISION_MODEL, temperature0.1, title/schema name scene_layout. Add `signal?: AbortSignal` to requestStructuredJson and private requestCompletionContent/postCompletion input types; forward through JSON repair/network sleeps. Scenes supplies AbortSignal.timeout(90_000) per sample; abort rethrows without retry/repair; default absent signal retains current20min timeout. No Promise.race leaving requests alive. Existing repair/retry/timeout: `src/infra/openrouter.ts:445-555`; runProcess already kills timed-out children, no process.ts edit required (`src/infra/process.ts:22-64`).

## 6. Renderer, preview, ASS

Replace runtime fill literal blur with contain in geometry, timeline, render, preview, and tests, no alias. Generalize sharp foreground to both axes using shared pure containForeground: If source.w/source.h <= canvas.w/canvas.h, set height=canvas.h exactly and width=max(2,2*floor((canvas.h*source.w/source.h)/2)); otherwise set width=canvas.w exactly and height=max(2,2*floor((canvas.w*source.h/source.w)/2)). Center x/y using round((available−size)/2); exact limiting dimension prevents a floating-point two-pixel regression. Existing fixed host blur only has the narrower-than-panel regime, so these formulas retain that output exactly. Baseline: `src/domain/geometry.ts:123-137`, `src/infra/render.ts:365-394`, `web/src/preview/draw.ts:22-74`.

In render.ts panelScaleChains keep blurred cover background scale/crop/gblur30/darken0.6; foreground uses **computed width AND height**, overlay centers x AND y. Browser draw calls containForeground with identical even geometry, keeps existing clipped blurred/dark background, draws sharp foreground at that rect. Do not crop horizontal documents by fitting foreground to panel height. ASS posY becomes round(cue.centerY*height); browser drawCaptions uses cue.centerY*height; text styling/word event spans unchanged. Current positions: `src/infra/ass.ts:42-51`, `web/src/preview/draw.ts:104-145`.

Scope timing changes **only to scenes clips**, detected by `clip.composition !== null`. In buildChunkFilterGraph the scenes branch sets outputDuration=clip.outputEnd−clip.outputStart, adds `tpad=stop_mode=clone:stop_duration=<one frame>,trim=end_frame=<frames>,setpts=PTS-STARTPTS` after fps and before panel splitting, uses the same outputDuration for the base, and computes audio samples as round(outputEnd*48000)−round(outputStart*48000) before existing apad/atrim. The fixed branch (`clip.composition === null`) keeps the current video chain with **no tpad/trim addition**, outputDuration=(sourceEnd−sourceStart)/speed, and audioSamples=round(outputDuration*48000) independently per clip. Preserve its fades/chunking and resulting frame/audio sample counts exactly; do not apply cumulative sample rounding to fixed. Existing graph/audio/chunk behavior: `src/infra/render.ts:135-174,395-430`; fixed A/V regression: `tests/render.test.ts:386-479`.

## 7. Pipeline and application

### 7.1 Sequential ingest task orchestration

Add runTask branch parsing EmptyPayloadSchema for analyze_scenes and private `analyzeScenesTask(task: QueueTask): Promise<void>`. Run it through the existing ingest lane runNext/completeTask/handleTaskFailure path, one task at a time. Keep `claimNextTask(kinds: readonly QueueTaskKind[]): QueueTask | null` unchanged, with no jobId filter or job-specific task runner. Task/model/claim baseline: `src/application/pipeline.ts:52-99`, `src/infra/db.ts:330-351`, `src/index.ts:96-109`.

For scenes jobs processSource finishes download and transcription in its existing order, sets sceneAnalysis=queued, enqueues `plan_shorts` **then** `analyze_scenes`, and returns; never enqueue analyze_host for scenes. The same ingest worker finishes planning before it starts scene analysis. In the awaiting_speaker branch, enqueue only analyze_scenes before returning; the existing chooseSpeaker flow enqueues planning after the operator chooses, so speaker selection is not bypassed. Fixed retains its current host-analysis/planning order. Do not run scenes concurrently with transcription, add workers, or change processSource/planShorts to merge stale Job snapshots. Current branches: `src/application/pipeline.ts:102-138`, `src/application/studio-service.ts:204-221`.

analyzeScenesTask re-reads Job immediately before **each** write and changes only sceneTrack, sceneAnalysis, sceneAnalysisError, and updatedAt. It does not write transcript/planning/status fields captured before awaiting analysis. Other source/planning writes remain unchanged because tasks stay sequential. Existing isolated host-analysis write pattern: `src/application/pipeline.ts:140-171`.

Task start sets running/error null, retains old track for read-only preview during re-analysis. Success commits complete new track and done/error null, then schedules crop analyses for relevant shorts (below). Failure calls failTask, sets sceneAnalysis=failed and visible sceneAnalysisError, retains previous track for preview but blocks new exports; does not change job.status, transcript, shorts, or global failedTaskKind. Sample-level bounded network retry/repair remains the OpenRouter helper policy; abort does not retry. **No automatic whole-video task retry loop**: retry is the explicit endpoint; startup recovers queued/running/missing work, not terminal failures. This mirrors host task isolation while making scene failure visible and non-optional; baseline isolation: `src/application/pipeline.ts:140-171,697-770`.

### 7.2 Document-only crop analysis

Planner pace and manual short speed now use `job.creatorProfileSnapshot.render.defaultSpeed` (not live creator or layout speed). Planner/short creation consider scenes crop analysis eligible only if a retained source interval intersects document content; pending scenes defer eligibility until task completion. Fixed retains contentPanel checks. Scene completion visits existing shorts once: enqueue document-eligible shorts with no queued/running task; set no-document shorts cropAnalysis=none; do not enqueue footage/person-only crops. Current locations: `src/application/pipeline.ts:184,225-269`, `src/application/studio-service.ts:259-296,441-456`.

Add this pure function in domain/scene. Pipeline supplies retained clips to avoid a scene↔timeline import cycle; no alternate signature. Existing spans are source-clip based (`src/application/pipeline.ts:849-870`).

```ts
export function documentCropSpans(input: {
  clips: readonly { sourceStart: number; sourceEnd: number }[];
  words: readonly TranscriptWord[];
  segments: readonly SceneSegment[];
}): { segment: SceneSegment; startSeconds: number; endSeconds: number; text: string }[];
```

Algorithm: positive intersections of kept clips and document segments only, words overlapping that intersection form narration text, sort chronologically; never sample across segment bounds. Pipeline groups by segment, supplies transient ContentPanel sourceRect=segment.content.box to current analyzeContentCrops, preserving fixed implementation. Convert returned **global** focus into local content coordinates by inverse box mapping before replaceAutoCrops; manual crops win as today. Clamp sample frame lead to interior `[span.start,span.end−min(0.1,span.duration/2)]` to support short intersections; no negative sample time. Share the existing total16-sample budget across the **whole short**, not 16 per segment: add required `maxSamples: number` to analyzeContentCrops input, fixed passes16, scenes first distributes16 round-robin over segments and skips zero-budget groups. Add timeoutMs120000 to scene detection and60000 to frame extraction in vision.ts. Existing sample caps/lead/replace revision protection: `src/infra/vision.ts:13-23,66-102,149-213`, `src/application/pipeline.ts:271-322`.

Manual crops/analyze endpoint with no document segments returns StudioError invalid; pending/failed scene analysis returns conflict with scene error rather than pretending no content. Read latest short after vision and preserve existing optimistic revision/manual precedence. On scene rerun success, validate existing source-time overrides against new track, canonicalize to containing segment, retain local manual crop values; if a retained manual crop/override has no valid target, fail the scene task with an explicit edit-conflict error and keep previous track (operator clears the offending edit then reruns). Do not silently delete manual work. Baseline normalization/optimistic updates: `src/application/studio-service.ts:302-318`, `src/application/pipeline.ts:293-322`.

### 7.3 Backfill, endpoint, export freezing

Add store `enqueueMissingSceneAnalyses(): void`: jobs with media + scenes layout, no complete track and state none/queued/running, no queued/running analyze_scenes→enqueue and set queued. Never auto-repeat failed terminal tasks. On startup call after requeueRunningTasks and alongside host backfill; host backfill checks strategy=fixed before panels. Recovered running scenes may retain previous track and still need their existing queued task, do not duplicate it. Current recovery/backfill: `src/infra/db.ts:295-309,373-389`, `src/index.ts:66-68`.

Add `POST /api/jobs/:jobId/scenes/analyze` with EmptyPayloadSchema body; StudioService.analyzeScenes requires ready Job/media/scenes layout; pending duplicate returns current JobDetail; otherwise retains track, sets queued/error null, enqueues once, returns JobDetail. Fixed returns invalid. Host re-run rejects scenes before panel access. Add API client `analyzeScenes(jobId: string): Promise<JobDetailDto>` and query mutation, invalidate job/jobs/short details. Route baseline: `src/studio/server.ts:125-129`; host service: `src/application/studio-service.ts:234-247`; query convention: `web/src/api/queries.ts:126-143`.

New scene export creation requires sceneAnalysis=done and non-null track; pending/failed returns409 with specific state/error; also wait for queued/running crop analysis. Freeze edit/title/hostFraming as today, **layoutProfileSnapshot** from job and **sceneTrack** filtered by positive overlap with computeSourceClips. Fixed freezes null sceneTrack. Worker renders using export.layoutProfileSnapshot/export.sceneTrack, never current Job scene/layout; an already frozen export may finish while re-analysis runs. Cover uses export snapshot canvas too, including late Instagram cover generation. No reread-to-refresh frozen inputs. Existing export/cover paths: `src/application/studio-service.ts:459-497`, `src/application/pipeline.ts:324-394,450-461`.

Extend exportMatchesShort to compare current edit/title/transcript/host fields plus frozen layout JSON and freezeSceneTrack(current track,current kept clips) JSON (including analyzedAt); use job media to compute clips. Reanalysis invalidates currentness even if geometry coincidentally matches, but booked publications retain their export. Autopilot waits on scenes state/track and documents crops, surfaces scene error instead of attempting exports; fixed keeps hostAnalyzedAt waiting. Remove caller-supplied hasHostPanel flag from autopilotShortPlan; derive fixed/scenes readiness from Job layout. Existing matching/readiness/callers: `src/domain/autopilot.ts:39-44,78-111,133-166`, `src/application/autopilot.ts:356-369`, `tests/autopilot-domain.test.ts:170-185`.

## 8. Accounts, publishing, and capacity cutover

### 8.1 Provider contract and no account leakage

Add required `account: PublishingAccount` to ShortVideoPublishInput (all callers/tests must pass it). Mallary constructor becomes `constructor(apiToken: string, uploadClient: MallaryUploadClient)`; profileId is **not client state**. publish validates non-null input.account.mallaryProfileId **before upload**, passes it to payload builder each call. buildMallaryInstagramReelPayload and private buildMallaryShortVideoPayload require `profileId: string` and always emit profile_id for all three platforms. Check/cancel remain keyed by persisted provider/remoteJobId and need no account. Existing signatures/payloads: `src/infra/instagram-publisher.ts:6-15,103-111`, `src/infra/mallary.ts:207-224,286-314,349-410`.

Keep `FallbackShortVideoPublishProvider`, its exported name, constructor, provider ordering/parser defaults, scheduling filter, and `safeToFailover` catch/continue semantics unchanged. Before trying any provider, apply the shared account gate (assigned account, platform membership, non-null Mallary profile ID). Then filter its ordered provider list by account eligibility: Buffer only when account.buffer=true and configured for that platform; Mallary only when account.mallaryProfileId is non-null and token/configuration permit it. Retain the entire eligible list and the existing failover loop, forwarding the **same account** on every eligible attempt. A safeToFailover error may try the next eligible provider; an unsafe error stops exactly as today. BufferClient independently rejects account.buffer=false before public asset creation/API calls. Boni keeps all three platforms and its current publishing/failover behavior. Existing routing/order/factory: `src/infra/instagram-publisher-factory.ts:10-43,45-131`; Buffer entry: `src/infra/buffer.ts:61-75`.

Expose exact provider-capability method on ShortVideoPublishProvider and implement it in router/Mallary/Buffer/test providers (global supports alone is insufficient):

```ts
canPublish(input: { account: PublishingAccount; platform: ShortVideoPlatform; scheduled: boolean }): boolean;
```

Account requires Mallary connection for **all** publish/schedule requests, including Buffer-enabled account; this is the settled connection gate, not automatic use of global channels. Account null→`No publishing account is assigned to this creator.`; null Mallary→`Account not connected in Mallary`. Manual API throws StudioError invalid400 with this reason, no records/tasks/uploads; autopilot books nothing and displays exactly the same second reason. Recheck live profile/account at publish task execution. Missing/disabled creator and missing account remain explicit availability failures. Design: `local://mix-design.md:65-73`; current availability: `src/application/platforms.ts:55-89`.

Rewrite configuredShortVideoPlatforms/availabilityForProfile/canScheduleOn around live account eligibility/canPublish, so Mallary supports TikTok without Buffer channels and Mix cannot route into Boni Buffer. Remove platformAvailabilityFromSnapshot: createManualShort becomes async and uses same live availability path as getShort/saveEdit; listScheduledPosts becomes async and reads live account schedule, no snapshot schedule. Required account is fetched once per publish attempt and is passed into publisher call. Keep existing provider-specific cooldown semantics unchanged (not an account migration requirement). Current caller list is fully enumerated in §10; baseline: `src/application/platforms.ts:9-98`, `src/application/studio-service.ts:297,541-565,634-653,974-1011`, `src/application/pipeline.ts:407-430,466-479`.

Delete MALLARY_PROFILE_ID from env schema and .env.example, and remove factory constructor argument. Do not introduce profile discovery/default account. Current references: `src/infra/env.ts:22`, `.env.example:10`, `src/infra/instagram-publisher-factory.ts:18`.

### 8.2 Shared capacity, scheduling, and autopilot

Add pure shared capacity functions to domain/schedule; both StudioService and Autopilot use them. No per-creator slot calculation remains. Source scheduling policy: `src/domain/schedule.ts:65-124`; current creator scans: `src/application/studio-service.ts:702-743`, `src/application/autopilot.ts:315-343`.

```ts
export function accountTakenSlots(input: {
  accountId: string;
  jobs: readonly { id: string; accountId: string | null }[];
  publications: readonly PublicationRecord[];
  from: Date;
  excludeShortId: string | null;
}): Date[];
export function accountSlotProblem(input: { account: PublishingAccount; at: Date; taken: readonly Date[] }): "spacing" | "daily_cap" | null;
```

Resolve current creator→account mapping once from manifest for each operation; associate each publication with its Job.creatorProfileId then that mapping (not layout identity). Nonfailed/noncancelled attempts count; start=scheduledFor??submittedAt??availableAt??createdAt, one earliest start per short, exclude current short for idempotent mult-platform publish. Include all starts from **local start of target day minus120min**, not merely now−120min: otherwise the morning posts disappear from daily cap by evening. For autopilot booking horizon include local today start minus120min through horizon end; freePostingSlots performs spacing/cap in account zone. Cross-midnight neighbors count for spacing; cap is schedule.slots.length per local calendar day, not platform count. Existing instant/dedupe policy and zone helpers: `src/application/autopilot.ts:315-343`, `src/domain/schedule.ts:42-49,65-124`, `docs/2026-10-16-studio-and-production.md:746-774`.

StudioService.publish(scheduledAt) validates account before spacing, then checks same-account other-short starts for120min and local-day cap; use existing spacing error, add `This account already has its daily posting limit scheduled for that day.` conflict. After awaited availability resolution **re-read publication state and capacity synchronously immediately before writing all planned publication rows**, no await between final check and writes, so simultaneous requests cannot book same account slot in the single process. Immediate publishing preserves existing no-time-spacing behavior; its timestamp still occupies capacity for later bookings. listScheduledPosts emits accountId and live account timeZone, fails clearly for missing account (no fabricated zone). Current publish asynchronous gap/cap omission: `src/application/studio-service.ts:532-632,702-743`.

Autopilot keeps per-creator channel watching/config/state; bookReadyShorts resolves account, aborts booking with exact connection reason before any service.publish; uses account schedule and taken slots across **all creators of account**. Since creators tick sequentially, reread capacity before every booking (manual requests can run during awaits); service remains authority. status/list/setEnabled/checkNow fetch profile/account coherently; status exposes accountId/accountConnected/reason/nullable schedule. Default runtime state stays disabled for four new creators; setEnabled(true) while disconnected rejects invalid400 rather than enabling a permanently blocked worker. A stale persisted enabled state on disconnect is shown disabled effectively, does no channel downloads/preparation/booking, and displays reason. Existing disabled default and creator loop: `src/application/autopilot.ts:61-105,259-309,371-401,453-470`.

Autopilot plan receives account connection explicitly so each unbooked selected short shows waiting/reason `Account not connected in Mallary`, without overriding booked history; add required `accountConnected: boolean` to autopilotShortPlan input and planSelectedCandidate parameters. Remove hasHostPanel flag as §7 specifies. AutopilotPanel handles nullable schedule, shows top-level reason even when runtime off/no tracked shorts, disables enable control with reason when disconnected, and never invents slots. Current UI schedule dependency: `web/src/components/AutopilotPanel.tsx:42-44,112-125,162-164`; current used-short precedence: `src/domain/autopilot.ts:78-106`.


## 9. Complete configuration and one v8 migration

### 9.1 `profiles/creator-profiles.json` — full contents

All six creators remain render-enabled; runtime autopilot is stored separately and defaults false, not the creator enabled field (`src/application/autopilot.ts:453-470`). The four Mix creators intentionally start at **defaultSpeed=1.25**; operator tunes per creator after the first transcripts. Boni stays1.5, Jones1.0, moved from their layouts (`profiles/filipe_boni_layout.json:7`, `profiles/jones_manoel_layout.json:7`). Channel IDs/accounts come from `local://mix-design.md:9-12,70-73`; the later scope decision retains youtube_shorts on cortes_do_boni so its current Instagram/TikTok/YouTube capability is preserved (`profiles/creator-profiles.json:14-18`). Mix remains Instagram/TikTok.

Contact sheets were inspected: Borelli has short dark hair/beard, dark shirt and microphone, small room webcam sometimes absent; Kobori has gray hair/glasses/headphones/white shirt with central microphone; Gaiofato has curly dark hair/round glasses/mustache and beard, black shirt, shelves behind; Machado has short graying hair/pointed goatee, gray shirt, close-up left camera. Images have no text line numbering: visual evidence is `work/research/creators/sheet-RKrZH3O1eZ8.jpg` (02:24,07:12), `sheet-w0iltvNx2YQ.jpg` (00:28,09:48), `sheet-2_WwD4Getmo.jpg` (00:00,08:00,20:40), `sheet-_EaHFwnAoVU.jpg` (01:08,14:44); line-numbered corroborating descriptions are `work/research/scene-eval.mts:10-15`. Descriptions below identify the camera host, not political figures/guests in content.

```json
{
  "version": 3,
  "defaultCreatorId": "filipe_boni",
  "accounts": [
    {
      "id": "cortes_do_boni",
      "displayName": "Cortes do Boni",
      "schedule": { "timeZone": "America/Sao_Paulo", "slots": ["12:00", "19:00", "21:00"] },
      "platforms": ["instagram", "tiktok", "youtube_shorts"],
      "mallaryProfileId": "S83DPA58Wwx",
      "buffer": true
    },
    {
      "id": "mix",
      "displayName": "Mix",
      "schedule": { "timeZone": "America/Sao_Paulo", "slots": ["12:00", "19:00", "21:00"] },
      "platforms": ["instagram", "tiktok"],
      "mallaryProfileId": null,
      "buffer": false
    }
  ],
  "creators": [
    {
      "id": "filipe_boni", "displayName": "Filipe Boni", "enabled": true,
      "description": "Perfil de produção do Cortes do Boni.",
      "accountId": "cortes_do_boni",
      "render": { "layoutPath": "profiles/filipe_boni_layout.json", "layoutId": "screen-top-host-bottom-v2", "defaultSpeed": 1.5, "scene": null },
      "autopilot": {
        "channelUrl": "https://www.youtube.com/@filipe_boni/videos", "shortsPerVideo": 2,
        "platforms": ["instagram", "tiktok"], "reviewWindowHours": 3, "bookingHorizonHours": 24,
        "maxShortAgeHours": 48, "minVideoSeconds": 480
      }
    },
    {
      "id": "jones_manoel", "displayName": "Jones Manoel", "enabled": true,
      "description": "Perfil de experimentação, sem conta de publicação.", "accountId": null,
      "render": { "layoutPath": "profiles/jones_manoel_layout.json", "layoutId": "center-speaker-vertical-v2", "defaultSpeed": 1.0, "scene": null }
    },
    {
      "id": "samuel_borelli", "displayName": "Samuel Borelli", "enabled": true, "accountId": "mix",
      "render": {
        "layoutPath": "profiles/mix_layout.json", "layoutId": "mix-scenes-v3", "defaultSpeed": 1.25,
        "scene": {
          "hostDescription": "Samuel Borelli: homem de cabelo curto escuro e barba escura, camiseta escura, falando ao microfone em uma webcam no quarto. A câmera costuma ser um pequeno inset à direita e pode desaparecer.",
          "hints": "O apresentador é o homem da webcam, não as pessoas das reportagens ou vídeos. A webcam pode estar no canto superior ou inferior direito. Separe intérpretes de Libras, logotipos e rodapés como overlays; exclua o fundo desfocado de vídeos verticais."
        }
      },
      "autopilot": {
        "channelUrl": "https://www.youtube.com/channel/UC3gQ9lIiPQj7frT5CE5QyRA/videos", "shortsPerVideo": 2,
        "platforms": ["instagram", "tiktok"], "reviewWindowHours": 3, "bookingHorizonHours": 24,
        "maxShortAgeHours": 48, "minVideoSeconds": 480
      }
    },
    {
      "id": "jose_kobori", "displayName": "José Kobori", "enabled": true, "accountId": "mix",
      "render": {
        "layoutPath": "profiles/mix_layout.json", "layoutId": "mix-scenes-v3", "defaultSpeed": 1.25,
        "scene": {
          "hostDescription": "José Kobori: homem mais velho de cabelo grisalho, óculos retangulares, fones de ouvido e camisa branca, sentado diante de um microfone de podcast, com estantes e mapa ao fundo.",
          "hints": "Geralmente a câmera ocupa o quadro inteiro. QR code no alto à esquerda é overlay. Uma pergunta escrita pode cobrir o rosto; marque o texto como conteúdo. Em alguns trechos o apresentador fica à esquerda e um vídeo à direita."
        }
      },
      "autopilot": {
        "channelUrl": "https://www.youtube.com/channel/UCOKSOW5uJHdW7Edz37mvAFw/videos", "shortsPerVideo": 2,
        "platforms": ["instagram", "tiktok"], "reviewWindowHours": 3, "bookingHorizonHours": 24,
        "maxShortAgeHours": 48, "minVideoSeconds": 480
      }
    },
    {
      "id": "gustavo_gaiofato", "displayName": "Gustavo Gaiofato", "enabled": true, "accountId": "mix",
      "render": {
        "layoutPath": "profiles/mix_layout.json", "layoutId": "mix-scenes-v3", "defaultSpeed": 1.25,
        "scene": {
          "hostDescription": "Gustavo Gaiofato: homem de cabelo escuro curto e encaracolado, óculos redondos, bigode espesso e barba, camiseta preta, webcam em um cômodo com estantes. Pode ocupar o quadro ou aparecer em um inset no alto à direita.",
          "hints": "O chat ao vivo e o QR code à direita são overlays, não conteúdo. Pessoas em chamadas de vídeo são conteúdo, não o apresentador. Exclua margens cinzentas das chamadas e a webcam sobreposta à imagem principal."
        }
      },
      "autopilot": {
        "channelUrl": "https://www.youtube.com/channel/UCqbz_4hrf2D58UFBOleuFnQ/videos", "shortsPerVideo": 2,
        "platforms": ["instagram", "tiktok"], "reviewWindowHours": 3, "bookingHorizonHours": 24,
        "maxShortAgeHours": 48, "minVideoSeconds": 480
      }
    },
    {
      "id": "gustavo_machado", "displayName": "Gustavo Machado", "enabled": true, "accountId": "mix",
      "render": {
        "layoutPath": "profiles/mix_layout.json", "layoutId": "mix-scenes-v3", "defaultSpeed": 1.25,
        "scene": {
          "hostDescription": "Gustavo Machado: homem de cabelo curto grisalho e cavanhaque pontudo escuro e grisalho, camiseta cinza, filmado de perto pela webcam; normalmente ocupa o painel esquerdo.",
          "hints": "O painel direito contém slides, tabelas, gráficos ou divulgação de livro; classifique como document. Preserve linhas completas e números relevantes das tabelas. Separe a câmera esquerda dos limites exatos dos slides à direita."
        }
      },
      "autopilot": {
        "channelUrl": "https://www.youtube.com/channel/UCRLEkZpNRoZQBG8kUTBD8vQ/videos", "shortsPerVideo": 2,
        "platforms": ["instagram", "tiktok"], "reviewWindowHours": 3, "bookingHorizonHours": 24,
        "maxShortAgeHours": 48, "minVideoSeconds": 480
      }
    }
  ]
}
```

### 9.2 `profiles/mix_layout.json` — full contents

Header220px, stage1700px, host/content captions at0.72/0.78 are concrete initial style decisions; Auto stack captions use seam. No layout creator/speed/panels fields. Design establishes geometry/compositions, not these two styling fractions (`local://mix-design.md:44-54`); values below close that choice.

```json
{
  "version": 3,
  "strategy": "scenes",
  "layoutId": "mix-scenes-v3",
  "canvas": { "width": 1080, "height": 1920, "fps": 30 },
  "background": "#101010",
  "font": { "family": "Montserrat ExtraBold", "file": "assets/fonts/Montserrat-ExtraBold.ttf", "assSizeScale": 1.562 },
  "hookBand": { "rect": { "x": 0, "y": 0, "w": 1, "h": 0.11458333333333333 }, "background": "#C8102E", "textColor": "#FFFFFF", "sizePx": 58, "maxCharsPerLine": 24, "maxLines": 2, "uppercase": true },
  "captions": { "sizePx": 62, "textColor": "#FFFFFF", "highlightColor": "#FFD400", "outlineColor": "#000000", "outlinePx": 6, "shadowPx": 2, "uppercase": true, "maxWordsPerCue": 4, "maxCharsPerLine": 16, "maxLines": 2, "centerY": 0.5521 },
  "scene": { "captionCenterY": { "host": 0.72, "content": 0.78 } }
}
```

### 9.3 Migrated fixed files — full contents

Keep layoutId strings despite v2 suffix: they identify the unchanged visual style, not JSON schema version. Only version/strategy/creatorId/defaultSpeed shape changes; all coordinates/styles preserved. Source contents: `profiles/filipe_boni_layout.json:1-16`, `profiles/jones_manoel_layout.json:1-15`.

`profiles/filipe_boni_layout.json`:

```json
{
  "version": 3,
  "strategy": "fixed",
  "layoutId": "screen-top-host-bottom-v2",
  "canvas": { "width": 1080, "height": 1920, "fps": 30 },
  "background": "#101010",
  "font": { "family": "Montserrat ExtraBold", "file": "assets/fonts/Montserrat-ExtraBold.ttf", "assSizeScale": 1.562 },
  "panels": [
    { "id": "screen", "role": "content", "sourceRect": { "x": 0, "y": 0, "w": 0.632, "h": 1 }, "canvasRect": { "x": 0, "y": 0.1146, "w": 1, "h": 0.4375 } },
    { "id": "host", "role": "host", "sourceRect": { "x": 0.637, "y": 0, "w": 0.363, "h": 1 }, "canvasRect": { "x": 0, "y": 0.5521, "w": 1, "h": 0.4479 }, "anchor": { "x": 0.5, "y": 0.42 } }
  ],
  "hookBand": { "rect": { "x": 0, "y": 0, "w": 1, "h": 0.1146 }, "background": "#C8102E", "textColor": "#FFFFFF", "sizePx": 58, "maxCharsPerLine": 24, "maxLines": 2, "uppercase": true },
  "captions": { "sizePx": 62, "textColor": "#FFFFFF", "highlightColor": "#FFD400", "outlineColor": "#000000", "outlinePx": 6, "shadowPx": 2, "uppercase": true, "maxWordsPerCue": 4, "maxCharsPerLine": 16, "maxLines": 2, "centerY": 0.5521 }
}
```

`profiles/jones_manoel_layout.json`:

```json
{
  "version": 3,
  "strategy": "fixed",
  "layoutId": "center-speaker-vertical-v2",
  "canvas": { "width": 1080, "height": 1920, "fps": 30 },
  "background": "#101010",
  "font": { "family": "Montserrat ExtraBold", "file": "assets/fonts/Montserrat-ExtraBold.ttf", "assSizeScale": 1.562 },
  "panels": [
    { "id": "speaker", "role": "host", "sourceRect": { "x": 0.342, "y": 0, "w": 0.316, "h": 1 }, "canvasRect": { "x": 0, "y": 0, "w": 1, "h": 1 }, "anchor": { "x": 0.5, "y": 0.4 } }
  ],
  "hookBand": { "rect": { "x": 0.05, "y": 0.07, "w": 0.9, "h": 0.11 }, "background": "#000000B3", "textColor": "#FFFFFF", "sizePx": 56, "maxCharsPerLine": 24, "maxLines": 2, "uppercase": true },
  "captions": { "sizePx": 64, "textColor": "#FFFFFF", "highlightColor": "#FFD400", "outlineColor": "#000000", "outlinePx": 6, "shadowPx": 2, "uppercase": true, "maxWordsPerCue": 4, "maxCharsPerLine": 16, "maxLines": 2, "centerY": 0.72 }
}
```

### 9.4 v8: exact SQL/JSON transforms

S1 owns `src/infra/db.ts` and new `src/infra/migrate-v8.ts`; export `migrateToV8(db: DatabaseSync): void`, invoked in the existing BEGIN IMMEDIATE transaction after all earlier migrations when original userVersion≥2 and≤7. SCHEMA_VERSION becomes8; fresh version0 creates current schema without converting empty rows. user_version=8 reopens without mutation; >8/unsupported old versions keep current loud rejection. Source chain: `src/infra/db.ts:6,119-159`. No v9 or lazy compatibility transformation.

Before updates, reject missing export parents (`SELECT e.id FROM exports e LEFT JOIN jobs j ON j.id=e.job_id WHERE j.id IS NULL`), malformed JSON, non-v2 job layout snapshots, missing/non-numeric defaultSpeed, or unknown legacy publish-enabled creator (creator other than filipe_boni with any publish.<platform>.mode=global). There is no unambiguous account for an unknown legacy publishing identity; fail with `Cannot map legacy publishing creator <id> to an account.` rather than route to Boni. Known v7 manifest has only Boni/Jones (`profiles/creator-profiles.json:5-54`). Render-only unknown legacy creators may keep accountId null. Validate legacy source shapes explicitly in migration, never ask live manifest/files for historical speed/geometry.

Run SQL below verbatim (single quotes here are SQL, not code comments). JS embeds these as template strings. Migration preserves timestamps/revisions, host framing, edit crops, publication IDs/statuses/remote IDs, and artifacts. JSON null uses SQL NULL or json(quoted null), never string null.

```sql
UPDATE jobs
SET payload_json = json_remove(
  json_set(payload_json,
    '$.creatorProfileSnapshot.accountId',
      CASE WHEN json_extract(payload_json, '$.creatorProfileSnapshot.id') = 'filipe_boni'
        THEN 'cortes_do_boni' ELSE NULL END,
    '$.creatorProfileSnapshot.render.defaultSpeed', json_extract(payload_json, '$.layoutProfileSnapshot.defaultSpeed'),
    '$.creatorProfileSnapshot.render.scene', json('null'),
    '$.layoutProfileSnapshot.version', 3,
    '$.layoutProfileSnapshot.strategy', 'fixed',
    '$.sceneTrack', json('null'),
    '$.sceneAnalysis', 'none',
    '$.sceneAnalysisError', json('null')
  ),
  '$.creatorProfileSnapshot.schedule', '$.creatorProfileSnapshot.publish',
  '$.layoutProfileSnapshot.creatorId', '$.layoutProfileSnapshot.defaultSpeed'
);

UPDATE shorts
SET payload_json = json_set(payload_json,
  '$.edit.layout', json('{"split":null,"overrides":[]}')
);

UPDATE exports
SET payload_json = json_set(payload_json,
  '$.edit.layout', json('{"split":null,"overrides":[]}'),
  '$.layoutProfileSnapshot', json((
    SELECT json_extract(j.payload_json, '$.layoutProfileSnapshot')
    FROM jobs j WHERE j.id = exports.job_id
  )),
  '$.sceneTrack', json('null')
);
```

The SQL above is the exact transform; SQL-quoted text is intentional. After the updates the existing outer transaction executes `PRAGMA user_version = 8; COMMIT`; any preflight or SQL failure rolls back every update/version. Do not add post-transform record schemas or read-time validators: tests/db-mix-migration.test.ts asserts the complete resulting job/short/export shapes and preserved fields, while normal store methods retain their current JSON parsing (§2.4). Do not change JSON stored inside historical actions (event evidence, not active model records). No account snapshot is added to jobs: render config is historical, account capability/schedule is live. Existing JSON tables/event boundary: `src/infra/db.ts:18-63,178-244`; action usage: `src/application/studio-service.ts:124-128,621-630`.

Migration tests must create **actual v7 payloads**, not set version7 on newly constructed v3 payloads. Current migration tests that downgrade newly seeded records must explicitly rewrite their layout/creator/edit/export shape to the historical schema before reopening (`tests/studio-service.test.ts:569-612`). Required v8 evidence cases are listed in §11; compare old/new buildTimeline placements/cues after normalizing only intentional fill literal metadata, verify artifact paths and booked publication references unchanged.


## 10. Editor interaction contract and exhaustive caller ledger

### 10.1 Layout section (visuals explicitly delegated)

ui-designer chooses visuals only; ui-implementer implements this contract, without another composition heuristic. Add `web/src/components/SceneLayoutSection.tsx` exporting the following props/type, import domain Composition/SceneSegment type-only, and add `sceneLayout: SceneLayoutSectionProps | null` to EditorInspectorProps. ShortEditorView already extends/forwards those props (`web/src/views/ShortEditorView.tsx:14-38,254-258`). Existing framing tab/props/state: `web/src/components/EditorInspector.tsx:24-64,115-130,320-384`.

```ts
export interface SceneLayoutSectionProps {
  analysis: SceneAnalysisDto;
  segment: SceneSegment | null;
  segmentIndex: number | null;
  segmentCount: number;
  sourceSeconds: number;
  selected: "auto" | Composition;
  effectiveComposition: Composition | null;
  allowed: readonly Composition[];
  split: number | null;
  effectiveSplit: number | null;
  flashInherited: boolean;
  rerunPending: boolean;
  onCompositionChange: (composition: "auto" | Composition) => void;
  onSplitChange: (split: number | null) => void;
  onSeekSegment: (index: number) => void;
  onAnalyzeScenes: () => void;
}
```

- Show Layout only for scenes. Resolve active segment by outputToSource(playhead) then sceneAt; at output end inspect last retained segment, not an unselected tail. Show source interval/index and Auto plus Split/Host/Content. Impossible modes are disabled with operand reason; Auto is always selectable when track exists. Display effective composition and flash inheritance separately from selected override, never misrepresent a suppressed flash override. Default/allowed logic comes from domain (`local://mix-design.md:59-62`, `web/src/containers/ShortEditorPage.tsx:331-343`).
- Auto removes override for **active segment**; explicit mode upserts by segment.startSeconds, preserving all others. Split slider min0.40,max0.65,step0.01, Auto writes null; single shared value applies whole short, not current segment. Changes use existing changeEdit/undo/redo/autosave, no bespoke endpoint. Persist before export; server normalization remains authoritative. Existing editing flow: `web/src/containers/ShortEditorPage.tsx:125-130,315-343,450-477`, `web/src/editor/useEditorState.ts:1-5`.
- Segment navigation skips source-only segments removed from this short, seeks first retained output intersection; never seeks unselected material. Pending scene analysis shows status, disables composition/export/new keyframes but may display retained old-track preview; absent track does not call buildTimeline. In ShortEditorPage, before mounting ShortEditorSurface, return an in-file SceneAnalysisGate({detail}: {detail: ShortDetailDto}) when strategy=scenes and sceneTrack=null. That separate component owns rerun mutation/status/error controls; do not fabricate an empty Timeline or conditionally invoke preview hooks inside ShortEditorSurface. Failed status displays actionable error and Re-analyze scenes. Re-run flushes pending edit saves before request; mutation refreshes track/shorts after completion, not just request return. Poll job/short while queued/running even when job.status ready. Existing polling misses this independent status (`web/src/api/queries.ts:75-98,110-122`).
- Crop editor scenes: active/selected crop contentRegion=segment.content.box. Convert local stored focus to global rect for full-source image display, and convert global gesture result back to content-local at save; constrain drag/resize to contentRegion. Add keyframe seeds active segment local focus or inverse-mapped subject, never previous segment crop/FULL_FRAME. Disable add without content; existing orphan crop remains selectable for deletion. Fixed current coordinate behavior stays unchanged. Sources: `web/src/components/CropEditor.tsx:6-13,43-101,115-126`, `web/src/components/EditorInspector.tsx:123-125`, `web/src/containers/ShortEditorPage.tsx:331-343`.
- Publishing UI uses job.account?.schedule and takenSlots; no account means scheduling controls unavailable, never a fabricated São Paulo schedule. PublishPanel adds `accountId: string | null`, `schedule: PostingSchedule | null`, `takenSlots: readonly string[]`; suggestions use takenSlots, **not** all upcomingPosts (which also double-count platforms). Historical posts use account timezone when present and the operator timezone for display only when account absent; no publish capability is inferred. Existing bug source: `web/src/components/PublishPanel.tsx:7-22,227-243`, `web/src/components/EditorInspector.tsx:571-575`. AutopilotPanel nullable schedule/reason behavior is §8.2.

### 10.2 All changed production callers/imports/re-exports

Each row names the current owning seam and the required change; no `publishModeFor` symbol exists in the mapped source: the actual equivalent is publishConfigForPlatform. All its consumers are enumerated. No source barrel re-export exists for these modules; remove old named exports rather than add compatibility re-exports. Search evidence: `src/infra/creator-profile-loader.ts:136-138`, `src/application/platforms.ts:3,63`, `tests/creator-profile-loader.test.ts:8,60-61,194-195`.

| Current file:line | Exact required migration |
|---|---|
| `src/domain/model.ts:75-89,112-130,173-190,220-282,284-392` | New scene/account/task/export types; remove creator publish types; keep existing response schemas, exports, zod imports, and inferred response types unchanged. |
| `src/domain/layout.ts:68-83` | v3 fixed/scenes union, composition/fill types; remove creatorId/defaultSpeed. |
| `src/domain/edit.ts:40-71,106-172,180-269` | Extend ShortEditSchema in place using existing NormRect/WordRange/CropKeyframe schemas; initialize/preserve layout in normalizeEdit and all helpers; add contextual normalizer. |
| `src/domain/geometry.ts:69-74,125` | Remove HostPanelFill; import PanelFill, output contain without changing fixed crops. |
| `src/domain/timeline.ts:171-283,362-461` | Required sceneTrack input, scene splits/overrides/focus/split/flash/cue Y; local-time mapping. |
| `src/domain/autopilot.ts:39-44,78-111,133-166` | Export currentness includes frozen layout/scene subset; derive readiness from strategy; accountConnected input replaces hasHostPanel. |
| `src/domain/schedule.ts:65-124` | Shared accountTakenSlots/accountSlotProblem; freePostingSlots remains schedule-based but callers supply account-wide deduped starts. |
| `src/infra/layout.ts:32-92` | Local v3 file schema reuses existing RectSchema; only fixed branch accesses panels; no DB validator export. |
| `src/infra/creator-profile-loader.ts:70-93,111-138,169-189` | Manifest accounts/new creator fields; repository account resolution; remove publishConfigForPlatform and creator-owned layout validation. |
| `src/infra/db.ts:119-159,178-244,295-309,330-351` | One v8 row transformation and fixed-host/scenes backfill; retain existing JSON parsing and claimNextTask signature/SQL. |
| `src/infra/openrouter.ts:5,445-555` | Keep existing model schema/type imports; add AbortSignal propagation/retry abort handling only. |
| `src/infra/vision.ts:7,149-213,215-233,252-267,304,332-342` | Keep existing schema imports; explicit maxSamples; short-span frame clamp; bounded ffmpeg; shared median math. Fixed calls pass16. |
| `src/infra/render.ts:135-174,365-394` | Scenes-only explicit frame/sample timing; fixed video chain and per-clip audio rounding unchanged; two-axis contain using shared foreground geometry. |
| `src/infra/ass.ts:42-51` | Use per-cue centerY. |
| `src/infra/env.ts:22,32` and `.env.example:10` | Remove MALLARY_PROFILE_ID only; preserve current provider-order parsing/defaults. |
| `src/infra/instagram-publisher.ts:6-15,103-111` | Required account input and canPublish contract. |
| `src/infra/instagram-publisher-factory.ts:18,39-43,45-131` | Keep FallbackShortVideoPublishProvider and safeToFailover loop; remove Mallary constructor profile argument; apply account gate and filter eligible providers without changing ordering/scheduling/failover behavior. |
| `src/infra/mallary.ts:213-217,286-314,349-410` | Remove client profile state; required per-call profile_id before upload, all platforms. Check/cancel unchanged. |
| `src/infra/buffer.ts:61-75` | Buffer account gate and canPublish implementation; no other account may use env channels. |
| `src/application/platforms.ts:9-98` | Delete creator publish-mode/snapshot helpers; live account capability-based availability/scheduling; TikTok works with Mallary alone. |
| `src/application/pipeline.ts:52-171` | Task dispatch plus sequential plan_shorts→analyze_scenes enqueue; analyzeScenesTask re-reads and writes only scene fields; no source/planner merge or task-claim changes. |
| `src/application/pipeline.ts:184,225-322,338-346,392,407-430,466-479,697-770,820-870` | Creator speed; document-only crops/budget/local focus; frozen export/cover; account passed per publish; scene failure isolation; narrow panel helpers to fixed. |
| `src/application/studio-service.ts:68-73,93-120,234-247,259-297,308,383,441-497` | CreatorDto account; initial scene state; strategy-aware re-run/crops; speed; contextual normalize both saves/revisions; freeze/gate exports; async manual-short availability. |
| `src/application/studio-service.ts:532-632,634-653,702-743,974-1011` | Account resolve/spacing/cap/final synchronous reservation; live schedule/account DTO/takenSlots; delete creatorPublications helper. |
| `src/application/autopilot.ts:61-105,259-309,315-343,356-401,453-470` | Live account connection gate/reason, per-account capacity/schedule; retain per-creator watcher/runtime state and disabled default. |
| `src/index.ts:66-68` | Scene backfill after recovery; keep worker lane count. |
| `src/studio/api-types.ts:2,18-22,25-43,133-171,256-281,300-318` | Keep existing edit-schema imports; apply DTO/API contract deltas §2.5. |
| `src/studio/server.ts:125-129,153-155` | scenes/analyze route; await manual short/schedule list. |
| `web/src/api/client.ts:93-110,194-196` | New analyzeScenes client; existing manual/schedule Promise calls retain outward signatures. |
| `web/src/api/queries.ts:75-98,110-122,126-143,172-175` | Scene mutation invalidation; scene-aware polling; no ready-job polling blind spot. |
| `web/src/containers/ShortEditorPage.tsx:161-180,315-343,450-529` | Pass sceneTrack; guard missing track; Layout props/handlers/navigation; local/global crop mapping; flush before rerun; account/takenSlots publishing data. |
| `web/src/components/EditorInspector.tsx:24-64,123-125,320-384,571-575` | SceneLayoutSection; per-crop content region; disabled invalid operations; account schedule/takenSlots PublishPanel props. |
| `web/src/components/CropEditor.tsx:6-13,43-101` | Gesture bounds contentRegion, full-frame display remains coordinate space; container maps local focus. |
| `web/src/views/ShortEditorView.tsx:14-38,254-258` | New inspector props flow through existing spread; no new layout heuristic. |
| `web/src/components/PublishPanel.tsx:7-22,195-243` | Nullable account schedule, account ID, takenSlots; stop global upcoming-post suggestion/counting. |
| `web/src/components/AutopilotPanel.tsx:42-44,112-125,162-164` | Connection reason and nullable schedule, disabled connect-dependent enable action. |
| `web/src/preview/draw.ts:3-4,22-74,104-145` | contain both axes, cue Y. Use relative runtime domain imports `../../../src/domain/{timeline,composition,text}.js` so Node consumer tests can import this renderer without Vite; type-only aliases can stay. |
| `web/src/preview/PreviewEngine.ts:459-464` | Use clip-local output-time ratio for scenes; keep `/timeline.speed` for fixed, playbackRate/end-card speed untouched. |
| `profiles/creator-profiles.json:1-54`, `profiles/filipe_boni_layout.json:1-16`, `profiles/jones_manoel_layout.json:1-15` | Full v3 replacements §9 plus new profiles/mix_layout.json. |
| `package.json:18-26`, `pnpm-lock.yaml:7-31` | Declare/pin sharp runtime dependency and generated lock resolution. |

Provider-order parsing and its existing defaults stay unchanged; only the global Mallary profile env field is removed. Apply account filtering to the existing ordered list, not to a new routing policy. Current parser/order: `src/infra/instagram-publisher-factory.ts:117-131`, env field: `src/infra/env.ts:22,32`.

### 10.3 Existing test/fixture callers to migrate (not new wiring tests)

- `tests/creator-profile-loader.test.ts:8,35-68,71-130,193-215`: remove publishConfigForPlatform imports/assertions; manifest v3 account fixtures, render.defaultSpeed/scene, fixed narrowing before panels; preserve selection validation tests, replace layout creatorId mismatch with reuse/account/scene mismatch behavior.
- `tests/edit.test.ts:41-56,88-151,219-266`: add layout default to fixture; preserve range/crop semantics; add contextual scene cases, no optional field shim.
- `tests/timeline.test.ts:54-113,182-427,451-515,571-578`: v3 fixed fixture; add sceneTrack:null to every fixed buildTimeline invocation; narrow profile helper to fixed before panels; blur expectation→contain, preserved coordinates asserted.
- `tests/render.test.ts:12-37,78-112,150-162,263-267,354-369,400-422,489-511`: import ShortEdit from edit, TranscriptWord from model instead of timeline (no re-export); v3 layout, new edit/cue/clip/timeline fields; required sceneTrack; contain literal.
- `tests/autopilot-domain.test.ts:21-69,113-137,170-185,307-311`: real complete fixed layout instead of cast-only mock; account profile, new job/export fields, accountConnected input; remove hasHostPanel option and use actual fixed no-host layout for that case.
- `tests/autopilot.test.ts:12,36-79,112-143,182-188,253-300`: PostingSchedule type import from model, v3 accounts/layout, render speed, full scene/export fields, canPublish provider method; account-scoped scheduling fixtures. Existing invalid schedule re-export is not retained.
- `tests/studio-service.test.ts:27-50,71-78,125-158,179-258,319-329,569-612,819,1700-1956`: v3 account/creator/layout/provider fixtures, scene job/export defaults, expected speed from creator snapshot; await createManualShort/listScheduledPosts wherever used; rewrite legacy downgrade payloads to genuine historical schema; preserve host regressions under fixed narrowing.
- `tests/studio-server.test.ts:154-162,219-222,343-346,391-396,417-454,693-706`: add analyzeScenes method/new DTO fields, Promise-returning manual/schedule methods, v3 edit/layout fixtures; update outward payload expectations, do not add spy-call routing tests as evidence.
- `tests/buffer.test.ts:4,21-29,50,71,221-285`: keep FallbackShortVideoPublishProvider import/constructions and existing safe/unsafe failover expectations; account on every input, canPublish scripted providers; add account filtering/no-cross-account behavior.
- `tests/mallary.test.ts:151-175,195-207,216,244,273-283,297-307,345`: two-argument constructor, required per-call account/profileId in payload tests, shared client alternating accounts test. Existing check/cancel no account argument.
- `tests/vision.test.ts:1-14,149-240` and `tests/openrouter.test.ts:1-38,223-415`: keep schema imports and observable parsed-head/crop/planner behavior unchanged; add abort/budget/short-span cases, not assertions on prompt wording/import wiring.

Unchanged callers intentionally remain unchanged: domain semantic/policies use retained response/edit types and createInitialEdit signature; source download cap stays≤1080p; check/cancel uses persisted remote IDs; PreviewEngine transport except local timing formula remains. Relevant seams: `src/domain/semantic.ts:1-3`, `src/domain/policies.ts:1-3`, `src/infra/youtube.ts:79`, `src/infra/instagram-publisher-factory.ts:90-115`, `web/src/preview/PreviewEngine.ts:472-513,572-581`.


## 11. Named behavioral tests and acceptance evidence

Use the existing Node test runner; temporary generated media/DBs live under OS temp and are removed by tests. Mock external model responses/HTTP where necessary, not domain geometry or the service under test. Do not add prompt wording, import/export, or spy-call wiring tests. Existing consumer-level precedents: `tests/render.test.ts:386-479,489-561`, `tests/studio-service.test.ts:1747-1774`, `tests/vision.test.ts:149-240`. The following are the exact new/updated test names and the bugs they must catch.

| Test file / owner | Test name → consumer-visible guarantee |
|---|---|
| `tests/creator-profile-loader.test.ts` / S1 | `six creators share reusable v3 styles and resolve two accounts` → all six can be selected/rendered, Mix creators reuse one layout; Jones cannot publish. |
| same | `scene descriptions are required exactly for scene layouts` → no job reaches vision without host identity; fixed cannot accidentally invoke scenes. |
| same | `invalid account references and duplicate Buffer owners are rejected` → cannot publish through another account or ambiguous global channels. Include duplicate Mallary ID, duplicate IDs, invalid autopilot platform subset/default. |
| same | `account schedules preserve timezone and spacing validation` → invalid slots are rejected before bookings, existing selection precedence remains. |
| `tests/db-mix-migration.test.ts` / S1 | `v7 Boni and Jones jobs migrate with historical speeds and identical fixed framing` → old jobs render with stored speed/geometry, not current files. Use non-default historical speed and fixed panel edits. |
| same | `v8 initializes edit layout on every short and every export snapshot` → previously stored edits load/save without optional-field crashes; export keeps its own edit, not current short edit. |
| same | `v8 freezes parent layout and preserves ready artifacts and booked posts` → queued old exports render; existing booked export IDs, hostFraming, artifact/cover paths, revision/crop fields and remote IDs unchanged. |
| same | `v8 rollback leaves version and all payloads unchanged on an unmappable publisher or orphan export` → no partial destructive migration. |
| same | `reopening v8 does not rewrite scene tracks or manual layout edits` → new data survives restart byte-for-byte; include real non-null SceneTrack/overrides and queued export. |
| same | `older supported migrations still reach v8 and future versions fail clearly` → v2/v6 users are not stranded; validate final shape, not just version number. |
| same | `startup queues missing scenes once and never queues host detection for scenes` → restart restores missing work without duplicate billable analysis; failed terminal work is not silently retried. Assert final useful state/one model result, not solely queue wiring. |
| `tests/scene.test.ts` / S2 | `short shots merge without losing leading or trailing source coverage` → no source gaps, including first short shot, duplicate cuts and one-shot video. |
| same | `nearby camera observations snap together and heads stay stable across cuts` → no inset/face jitter; distinct camera locations remain separate. |
| same | `averaged narrow-radius gradients retain the real PiP edge beside a transient white chart` → synthetic multi-frame pixel fixture reproduces adjacent-chart false peak; actual camera edge wins, not first-frame distractor. |
| same | `flat and frame-border edges retain median geometry` → no random border drift/no out-of-frame crop; positive2× threshold and eight evenly spaced members tested through resulting rectangle. |
| same | `failed shots inherit the previous successful shot or the next one for a leading run` → black/logo intros retain full source coverage without fabricating geometry or falsely increasing sample success counts. |
| same | `signature transitions change scene geometry even without a global cut` → localized right-hand observation is used immediately after split. |
| `tests/composition.test.ts` / S2 | `Gaiofato-style PiP inside content is excluded when a lower-overlap window exists` → fixture with zero-overlap versus higher-overlap-bucket candidates chooses the zero-overlap content window without losing focus. |
| same | `chat QR logo and Libras overlap costs rank content windows` → every overlay contributes to overlap-first scoring in cover and contain without making a candidate invalid. |
| same | `a document covering more than one fifth of the head selects content` → Kobori question card does not create face panel of obscured head; exact20% boundary keeps host usable. |
| same | `vertical content selects content composition` → portrait video is not sliced into horizontal top panel even with a small PiP. |
| same | `full-frame host with non-document content stays host` → camera remains star instead of duplicate-video split. |
| same | `wide document focus is contained without cutting words horizontally` → complete table lines preserved; wide footage/person subject uses contain too. |
| same | `persistent Gaiofato chat overlap still produces a focus-preserving composition` → all candidates may overlap chat; both contentWindow and buildTimeline return a deterministic crop rather than throwing. |
| same | `one-percent overlap buckets rank before area and focus-center distance` → meaningful overlap reductions beat larger windows, while candidates in the same bucket use the specified area/center/y/x tie order. |
| same | `split cost is source-resolution invariant and duration weighted` → 720/1080p equivalent scene chooses same split; long document outweighs brief footage, short-wide-focus legibility metric correct. |
| same | `split ties select the center and no-stack shorts use one half` → deterministic layout rather than input-order jitter. |
| `tests/edit.test.ts` / S2 | `scene overrides target one segment and impossible modes are rejected` → Auto removes only active override, invalid operands/time rejected, canonical duplicate last wins, fixed rejects layout changes. |
| same | `scene focus is local to its content box and is rejected outside it` → editing a small inset document does not frame wrong part of source. |
| `tests/timeline.test.ts` / S2 | `scene cuts split clips without toggling zoom or bleeding keyframes` → exact boundaries, scoped focus/override, no previous-shot crop leak. |
| same | `one split is shared across all stack clips and manual split wins` → host panel seam never jumps between shots. |
| same | `flash inheritance uses total retained segment duration at playback speed` → a long segment fragmented by word cuts is not misclassified; speed can make a short segment flash; first/consecutive flashes deterministic. |
| same | `captions choose position at cue start and keep it through a scene change` → no mid-cue jump; output mapping hits correct clip exactly at boundary. |
| same | `fixed Boni and Jones retain existing placement timing and caption geometry` → literal fill rename/type migration does not change existing videos. |
| `tests/autopilot-domain.test.ts` / S2 | `scene analysis gates exporting and disconnected accounts wait without hiding booked history` → no unsafe render/publish, exact account reason, booked posts remain booked. |
| same | `rerunning scenes invalidates export currentness without changing the booked export` → changed scene input needs a fresh render, already booked artifact immutable. |
| `tests/schedule.test.ts` / S2 | `account capacity dedupes platforms and includes early same-day posts` → IG+TikTok count once, morning posts still consume evening daily cap. |
| same | `different accounts may share an instant but creators of one account cannot` → no global suppression and no account collision, including midnight/timezone edges. |
| `tests/scenes.test.ts` / S3 | `native cut refinement and in-shot PiP changes produce complete source segments` → generated color/PiP media exercises real ffmpeg parsing/refinement; frame boundaries, coverage, and right-side observation asserted. |
| same | `exactly half successful scene samples are accepted and fewer fail visibly` → model/extraction/empty-frame failures share one denominator; previous-or-next successful-shot inheritance preserves full coverage. |
| same | `black and logo intro samples do not fail scene analysis when half succeed` → empty-vision refinement errors remain sample-local; leading inherited segments have original dimensions, start0/end duration, positive durations, and adjacent boundaries. |
| same | `scene sample timeout aborts the request and preserves the failure cause` → no hung analysis or live orphan request after timeout. |
| `tests/vision.test.ts` / S3 | `scene document crops respect one short-wide budget and stay in their segment` → narration crops do not sample footage or overrun short intersections; total requests≤16. |
| `tests/openrouter.test.ts` / S3 | `aborted caller signal stops repair and network retry` → sample time budget is real, existing planner responses unchanged without signal. |
| `tests/render.test.ts` / S3 | `contained wide and tall panels fit sharp foreground in both axes` → real rendered pixel checks retain document left/right edges and portrait top/bottom; verify bg+fg centering. |
| same | `ASS uses each cue position across changing compositions` → rendered subtitles agree with preview seam/host/content positions. |
| same | `many scene cuts preserve frame count audio duration and frozen geometry` → scenes-only cumulative frame/sample rules prevent per-clip drift. |
| same | `fixed exports keep baseline frame and audio sample counts` → Boni/Jones and a fractional-duration fixed fixture retain the existing fps chain and sum of per-clip rounded audio samples; scenes tpad/trim/cumulative rounding cannot affect them. |
| `tests/preview-draw.test.ts` / S3 | `preview contain geometry and cue Y match exported placements` → direct draw module with minimal typed canvas recorder checks actual drawImage foreground rects and text Y, not internal helper wiring. Runtime imports become relative (§10.2), no test-only alias shim. |
| `tests/studio-service.test.ts` / S4 | `pending or failed scenes block new exports while frozen exports keep rendering` → manual API gate, visible failure, old export snapshot untouched after rerun. |
| same | `scene rerun keeps edits and reports incompatible manual targets` → no silent loss of manual crop/override; old track retained on conflict. |
| same | `scheduled requests share account spacing and daily cap across creators` → live manifests, per-account reservations after awaits, cross-account independence and duplicate-platform dedupe. |
| same | `simultaneous scheduled requests cannot reserve the same account slot` → final synchronous capacity check prevents double booking. |
| same | `unconnected Mix rejects publish and schedule without creating attempts` → exact reason and no upload/task/partial publication side effects. |
| `tests/pipeline-scenes.test.ts` / S4 | `planning completes before scene analysis and exports wait for its scene track` → run real ingest task progression: planned shorts exist while scene state is queued, export returns409 until scenes completes, and analysis preserves the planned transcript/shorts. No concurrent transcription or targeted claim is involved. |
| same | `scene failure leaves planned shorts usable and rerun enables document crops and exports` → full task failure/retry behavior and no-document scenes avoid billable crop analysis. |
| `tests/studio-server.test.ts` / S4 | `scene edits and rerun errors are visible through HTTP` → public400/409/200 bodies and complete DTOs; integrate real service fixture, no new call-recording route tests. |
| `tests/mallary.test.ts` / S5 | `one Mallary client alternates account profile IDs without cross-posting` → A/B/A outgoing post bodies contain correct account IDs, including TikTok/YouTube forms; no constructor state. |
| same | `disconnected Mallary account fails before media upload` → no unscoped default-profile post. |
| `tests/buffer.test.ts` / S5 | `Mix never uses Boni Buffer channels during provider failover` → ineligible Buffer providers are filtered out before attempts; failure cannot cross into another account. |
| same | `Boni retains safe failover and stops on unsafe failure on all three platforms` → same account/profile travels through the existing ordered eligible providers; safeToFailover=true permits the next eligible attempt, false does not. |
| same | `scheduled posts require an eligible Mallary provider for that account` → no implicit immediate Buffer post when scheduling unavailable. |
| `tests/autopilot.test.ts` / S5 | `two creators on Mix share slots and Boni books independently` → account schedule/cap/taken-slot scope, with live service authority. |
| same | `unconnected account keeps new autopilots off and reports connection reason` → no channel/download/export/booking work, reason visible before first tracked short. |
| same | `capacity is rechecked after manual bookings during autopilot awaits` → stale free-slot list cannot overbook. |

Main-owned interaction acceptance (not wording tests): play each creator short, switch Auto/Split/Host/Content at selected source segment, drag local document focus, undo/redo/save/reload, verify neighboring segments unchanged, scrub through flash/cue boundary, export and compare visible crop/seam/caption positions; inspect disconnected Mix disabled publishing and top-level autopilot reason. Existing preview/edit path: `web/src/containers/ShortEditorPage.tsx:125-180,315-343`; design UI contract: `local://mix-design.md:58-62`.

## 12. Six implementation slices, disjoint ownership and verification

All paths below are repository-relative and exhaustive ownership allocations, not overlapping suggestions. Delete **no files**; delete obsolete symbols/branches in their owning files (creator publish types/helper, v2 runtime schema branches, global Mallary profile argument/env; retain the Fallback router export and failover semantics). New modules are named explicitly. No compatibility shim to keep intermediate slices compiling. Contracts land first; main integrates dependent slices before checking, so intermediate type errors from intentional required-field cutover are not hidden. The checks below are **main-agent commands after all slices land**, not permission for implementers to run parallel checks. Required command source: `package.json:10-15` and assignment check contract.

- **S1 — Contracts, manifest/layout storage, v8/config** (critical-path first): ADD `src/infra/migrate-v8.ts`, `profiles/mix_layout.json`, `tests/db-mix-migration.test.ts`; EDIT `src/domain/model.ts`, `src/domain/layout.ts`, `src/studio/api-types.ts`, `src/infra/layout.ts`, `src/infra/creator-profile-loader.ts`, `src/infra/db.ts`, `profiles/creator-profiles.json`, `profiles/filipe_boni_layout.json`, `profiles/jones_manoel_layout.json`, `tests/creator-profile-loader.test.ts`. Own shared model/layout/account/DTO contracts, in-place file-loader schema changes, transactional row migration, and backfill helpers; retain current storage JSON parsing, task claim API, and existing model response schemas. Depends on none; others consume §1–2 contracts without choosing names. Main verification, covered by final once-only gate: `node_modules/.bin/tsc -p tsconfig.json --noEmit`, `node_modules/.bin/tsc -p web/tsconfig.json --noEmit`, test subset `node_modules/.bin/tsx --test tests/db-mix-migration.test.ts tests/creator-profile-loader.test.ts`; expected six creators/two accounts, v7→8 lossless/rollback tests pass.
- **S2 — Pure scene/edit/composition/readiness/capacity domain** (after S1): ADD `src/domain/scene.ts`, `src/domain/composition.ts`, `tests/scene.test.ts`, `tests/composition.test.ts`; EDIT `src/domain/edit.ts`, `src/domain/geometry.ts`, `src/domain/timeline.ts`, `src/domain/autopilot.ts`, `src/domain/schedule.ts`, `tests/edit.test.ts`, `tests/timeline.test.ts`, `tests/autopilot-domain.test.ts`, `tests/schedule.test.ts`. Extend ShortEditSchema in place and implement exact algorithms/signatures in §3–4/§8.2, including soft exclusion ranking and leading-shot inheritance; no IO/model/provider logic. Main verification, covered by final once-only gate: both exact tsc commands below and test subset `node_modules/.bin/tsx --test tests/scene.test.ts tests/composition.test.ts tests/edit.test.ts tests/timeline.test.ts tests/autopilot-domain.test.ts tests/schedule.test.ts`; expected fixed regressions unchanged and exclusion/split/flash/capacity cases pass.
- **S3 — Scene vision/pixels and render/preview parity** (after S1+S2): ADD `src/infra/scenes.ts`, `tests/scenes.test.ts`, `tests/preview-draw.test.ts`; EDIT `src/infra/vision.ts`, `src/infra/openrouter.ts`, `src/infra/render.ts`, `src/infra/ass.ts`, `web/src/preview/draw.ts`, `web/src/preview/PreviewEngine.ts`, `package.json`, `pnpm-lock.yaml`, `tests/vision.test.ts`, `tests/openrouter.test.ts`, `tests/render.test.ts`. Own sharp install, pt-BR prompt/schema/aborts, averaged edge profiles, ffmpeg cut/refinement, document budget support, two-axis contain, analysis-track postconditions, per-cue positions, and scenes-only timing changes with unchanged fixed frame/sample counts. Main verification, covered by final once-only gate: test subset `node_modules/.bin/tsx --test tests/scenes.test.ts tests/vision.test.ts tests/openrouter.test.ts tests/render.test.ts tests/preview-draw.test.ts` and `pnpm build:web`; expected real ffmpeg pixel/frame/audio assertions pass and browser bundle resolves no Node/infra through domain.
- **S5 — Account-aware providers/autopilot application** (after S1+S2; parallel with S3, before S4 integration): EDIT `src/application/platforms.ts`, `src/application/autopilot.ts`, `src/infra/instagram-publisher.ts`, `src/infra/instagram-publisher-factory.ts`, `src/infra/mallary.ts`, `src/infra/buffer.ts`, `src/infra/env.ts`, `.env.example`, `tests/mallary.test.ts`, `tests/buffer.test.ts`, `tests/autopilot.test.ts`. No new files. Own live eligibility/account connection, eligibility filtering that preserves existing safeToFailover behavior, per-call profile ID, per-account autopilot capacity/reason, unchanged provider-order parsing/defaults. Do not edit StudioService; use its declared account-aware contract. Main verification, covered by final once-only gate: test subset `node_modules/.bin/tsx --test tests/mallary.test.ts tests/buffer.test.ts tests/autopilot.test.ts`; expected A/B/A profile isolation, unchanged Boni safe/unsafe failover on Instagram/TikTok/YouTube, Mix no Buffer/no disconnected work, shared slots pass.
- **S4 — Pipeline/service/HTTP integration** (after S1+S2+S3+S5): ADD `tests/pipeline-scenes.test.ts`; EDIT `src/application/pipeline.ts`, `src/application/studio-service.ts`, `src/studio/server.ts`, `src/index.ts`, `tests/studio-service.test.ts`, `tests/studio-server.test.ts`. Own sequential plan_shorts→analyze_scenes orchestration and scene-only re-read-before-write updates, document-only crop orchestration, rerun/gates/frozen exports, live-account service/capacity/DTO mapping, async callers, bootstrap. S1 has already provided store helpers; request contract correction from S1 owner rather than edit db.ts. Main verification, covered by final once-only gate: test subset `node_modules/.bin/tsx --test tests/studio-service.test.ts tests/studio-server.test.ts tests/pipeline-scenes.test.ts`; expected planning precedes scenes, scene analysis preserves transcript/shorts and gates exports, and account reservation race test passes.
- **S6 — Editor interaction wiring** (after S1+S2+S4 contracts; visual design by ui-designer, no layout algorithm choices): ADD `web/src/components/SceneLayoutSection.tsx`; EDIT `web/src/api/client.ts`, `web/src/api/queries.ts`, `web/src/containers/ShortEditorPage.tsx`, `web/src/components/EditorInspector.tsx`, `web/src/components/CropEditor.tsx`, `web/src/views/ShortEditorView.tsx`, `web/src/components/PublishPanel.tsx`, `web/src/components/AutopilotPanel.tsx`. Own §10.1 contract, scene-aware polling/disabled states, local crop coordinate mapping, account/takenSlots UI; S3 owns preview files, do not edit them. Visuals can reuse existing primitives; no new CSS file required or prescribed. Main verification, covered by final once-only gate: `node_modules/.bin/tsc -p web/tsconfig.json --noEmit`, `pnpm build:web`, then main-owned interaction acceptance §11; expected valid controls, persistent per-segment edits, same preview/export geometry, clear disconnected state.

Final integration order: **S1 → S2 → (S3 ∥ S5) → S4 → S6**. Only main runs once after all code lands:

```sh
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/tsc -p web/tsconfig.json --noEmit
node_modules/.bin/tsx --test tests/*.test.ts
pnpm build:web
```

Expected: both typechecks exit0/no diagnostics, all tests pass (including real ffmpeg tests), Vite exits0 and emits web/dist with no Node-built-in/infra imports in domain. No credentials/live publish required for those checks. Main may then perform §11 interaction acceptance and one operator-approved real scene analysis/export; no automatic publish/schedule smoke on a live account. No tests/builds/formatters were run for this documentation-only assignment.

## 13. Resolved design conflicts, risks, non-goals, and needs user

- **Edge refinement supersession:** first-frame/±2.5% becomes ≤8 evenly spaced averaged profiles/±1.2%, unchanged2×median gate. This is the later explicit instruction, not an open choice (`work/research/edge-eval2.mts:3-36`, old `local://mix-design.md:38`).
- **Sequential ingest scope:** scenes runs on the existing single ingest worker after transcription and the queued plan_shorts task. Keep claimNextTask and processSource/planShorts write patterns unchanged; only analyzeScenesTask re-reads immediately before writing scene fields. This intentionally supersedes the earlier parallel-analysis design (`src/index.ts:96-109`, `src/application/pipeline.ts:102-138,140-171`).
- **Host export-gating description vs code:** existing manual export creation has no host-analysis gate; host readiness is in autopilot only. Add strict scene gates explicitly without changing fixed manual behavior; do not copy a nonexistent gate (`src/application/studio-service.ts:459-497`, `src/domain/autopilot.ts:95-98`).
- **Legibility formula ambiguity:** D/F is displayed-focus/source-focus scale; B is full foreground width used only for contain penalty. This avoids rewarding whitespace and preserves resolution invariance; equation/prototype differ in naming (`local://mix-design.md:49-53`, `work/research/compose-eval.mts:71-84`). No open tuning decision for implementers.
- **Failed/empty samples:** a failed shot inherits the previous successful shot or the next successful one when leading; the sample-related task failure condition is success<50%, not an empty/black/logo intro. Coverage/adjacency/dimensions are analyzeScenes postconditions tested there, with no new storage validators (`local://mix-design.md:35-40`, `src/infra/db.ts:178-244`).
- **Soft exclusions:** overlap is a 0.01-resolution ranking cost before area/center/y/x, never a reason to reject a window or throw. Contain expands the focus short axis toward panel aspect in five steps. This keeps Gaiofato usable when chat always overlaps content; no largest-safe-rectangle search or exclusion error remains (`local://mix-design.md:18-23,47`, `work/research/scene-eval.mts:55-61`).
- **Publishing capability preservation:** cortes_do_boni retains Instagram, TikTok, and YouTube Shorts; Mix has Instagram/TikTok. Preserve FallbackShortVideoPublishProvider ordering, scheduling filter, and safeToFailover semantics, applying the shared account gate first and eligibility filtering before attempts (`profiles/creator-profiles.json:14-18`, `src/infra/instagram-publisher-factory.ts:45-131`).
- **Fixed render timing preservation:** tpad/trim and cumulative audio rounding apply only to scenes clips. Fixed keeps its existing fps chain, per-clip duration/sample rounding, frame counts, and audio sample counts (`src/infra/render.ts:135-174`).
- **Schema/storage scope:** existing model/edit/layout schemas remain where they are; extend ShortEditSchema in place and keep JSON storage parsing unchanged. v8 transformation tests prove stored-shape changes, with no schema relocation or new read-time validation (`src/domain/model.ts:284-392`, `src/domain/edit.ts:40-71`, `src/infra/layout.ts:6-92`, `src/infra/db.ts:178-244`).
- **Scale/cost risk [INFERENCE]:** cuts +12s samples can mean hundreds of model calls; six network workers/two decoders, raw frames per cluster≤8, complete-result failure threshold,90s sample abort and bounded process time keep resource use explicit. Compare all grid scales using overlap-first ranking; memoize placement evaluations within one buildTimeline call by segment/focus/panel aspect/zoom/split, no global cache retaining tracks. Required sampling/parallelism: `local://mix-design.md:34-38`; pixel buffers: `work/research/edge-eval2.mts:3-27`.
- **Migration risk:** storage snapshot transformations are irreversible after commit; atomic SQL transforms/rollback and migration tests proving preserved artifacts/booked IDs are mandatory. Main/operator takes a filesystem DB backup before real deployment; do not implement an automatic fallback DB or reset migration version (`src/infra/db.ts:119-159`).
- **Per-source semantic limits:** no tracking between12s samples; in-shot changes are inferred from sample disagreement and crop scdet, not guaranteed every transient overlay event. No local face model, two-content-panel layouts, vertical PiP composition, multi-host tracking, per-frame pan/zoom, auth/multi-user, planner/editorial rewrite, or cloud scheduling quota enforcement. Boni/Jones exact fixed behavior stays. Non-goals source: `local://mix-design.md:76-77`, existing fixed path `src/domain/timeline.ts:237-258`.
- **Needs user — connection:** create/connect Mix IG+TikTok in Mallary, then set only accounts.mix.mallaryProfileId to the real ID. Until then rendering/analysis works, publishing fails clearly, autopilot remains off. Do not infer/copy Boni ID. Gate source: `local://mix-design.md:65-73`.
- **Needs user — subscription:** settled pricing report says Mallary Starter120 posts/month, whereas two accounts×two platforms×three/day≈360/month; operator needs Pro ($29/unlimited per supplied design) before that cadence. Pricing was not independently checked; no code impact (`local://mix-design.md:74`).
- **Needs user — tuning:** after first transcripts tune four creator speeds from initial1.25 if desired, and enable each runtime autopilot only after account connection/review. No further design choice blocks implementation (`local://mix-design.md:73`, profile speed bounds `src/domain/edit.ts:28-31`).

Effort [INFERENCE]: roughly10–16 senior-engineer days total across six slices, with domain geometry/ffmpeg/SQLite/async race expertise concentrated in S1–S4 and UI implementer/designer collaboration in S6; dependent contract changes and rendered pixel regressions are the critical path, not config typing. Estimates are planning judgments, not repository measurements.


## Appendix A. Signature closure for implementers

These declarations close application integration details; they are not alternative APIs. Add needed type-only imports with `.js` suffixes. Existing integration owners: `src/application/platforms.ts:9-98`, `src/application/studio-service.ts:702-743,974-1011`, `src/application/autopilot.ts:259-401`, `src/infra/instagram-publisher-factory.ts:45-131`.

```ts
export function configuredShortVideoPlatforms(config: AppConfig, publisher: ShortVideoPublishProvider | null, account: PublishingAccount): ShortVideoPlatform[];
export async function platformAvailability(job: JobRecord, publisher: ShortVideoPublishProvider | null, config: AppConfig, profiles: CreatorProfileRepository): Promise<PlatformAvailabilityDto[]>;
```

platformAvailability keeps its public signature: resolve live profile/account once, then per platform require creator enabled, assigned/connected account, platform in account.platforms, configured credentials/provider.canPublish(immediate); canSchedule is the independent eligible scheduled capability. Do not expose account internals in PlatformAvailabilityDto. Keep the existing FallbackShortVideoPublishProvider constructor and extend its ordered-provider helper only with account eligibility:

```ts
constructor(providers: ShortVideoPublishProvider[], providerOrderByPlatform: Record<ShortVideoPlatform, Array<"mallary" | "buffer">>);
private orderedProvidersForPlatform(platform: ShortVideoPlatform, account: PublishingAccount): ShortVideoPublishProvider[];
```

The ordered helper keeps the existing platform order and filters Buffer by account.buffer/configured channel and Mallary by non-null account profile ID/configuration. It returns **all** eligible providers, not only the first. The shared account gate (assigned/connected account and platform membership) is applied before any publish attempt; canPublish returns false when that gate fails. canPublish checks whether the filtered list has any provider supporting the requested immediate/scheduled operation without network IO. publishShortVideo keeps the existing scheduled-provider filter and failover catch/continue loop unchanged: safeToFailover=true tries the next eligible provider with the same account; false rethrows. Mallary/Buffer canPublish remain transport capability predicates; Buffer additionally requires buffer=true and scheduled=false. supports/checkPublication/cancelScheduled, the provider-order parser/defaults, existing idempotency behavior, and all three Boni platform capabilities stay unchanged (`src/infra/instagram-publisher-factory.ts:45-131`, `src/infra/instagram-publisher.ts:103-111`).

StudioService helper replacements (old creatorPublications is removed):

```ts
private accountPublications(accountId: string, manifest: CreatorProfileManifest): PublicationRecord[];
private takenSlots(account: PublishingAccount, manifest: CreatorProfileManifest, from: Date, excludeShortId: string | null): Date[];
private assertManualSpacing(account: PublishingAccount, taken: readonly Date[], scheduledAt: Date): void;
private shortDetail(job: JobRecord, short: ShortRecord, platforms: PlatformAvailabilityDto[], account: PublishingAccount | null, takenSlots: readonly Date[]): ShortDetailDto;
private async shortDetailWithAvailability(job: JobRecord, short: ShortRecord): Promise<ShortDetailDto>;
```

shortDetailWithAvailability resolves one manifest/profile/account generation, computes capabilities and taken starts since local today start minus120min, then calls the pure mapper; no separate platformAvailability call that rereads a different generation. Factor private profile/account availability mapping into platforms.ts as `availabilityForPublishingProfile(input: { profile: CreatorProfile | null; account: PublishingAccount | null; missingReason: string; publisher: ShortVideoPublishProvider | null; config: AppConfig }): PlatformAvailabilityDto[]` and export it for that single-manifest use. publish resolves the same generation and passes account into final provider input; task execution resolves again to honor disconnects. listScheduledPosts resolves manifest once for its whole response. Account capacity jobs array is built from live creator mapping, not historical layout/creator schedule (`src/application/studio-service.ts:532-653,702-743,974-1011`).

Autopilot methods that need account data receive it explicitly, with the manifest used for the current booking operation:

```ts
private async bookReadyShorts(profile: CreatorProfile, config: CreatorAutopilotConfig, account: PublishingAccount, manifest: CreatorProfileManifest): Promise<void>;
private takenSlots(account: PublishingAccount, manifest: CreatorProfileManifest, now: Date): Date[];
private status(profile: CreatorProfile, config: CreatorAutopilotConfig, account: PublishingAccount | null): AutopilotStatusDto;
private plan(video: AutopilotVideoRecord, job: JobRecord, config: CreatorAutopilotConfig, now: Date, accountConnected: boolean): AutopilotShortPlan[];
```

tick/list/checkNow/setEnabled resolve current account before calling these methods; null/disconnected gate takes precedence for new work and top-level status.reason, but not existing booked histories. Internal trackedEntries/shortDto callers forward the same connection boolean. Recheck current manifest after any booking await before the next account reservation, not an old snapshot captured for the whole tick (`src/application/autopilot.ts:61-105,259-309,345-415`).

New client/query contracts in existing files:

```ts
export function analyzeScenes(jobId: string): Promise<JobDetailDto>;
export function useAnalyzeScenesMutation(jobId: string): ReturnType<typeof useMutation<JobDetailDto, Error, void>>;
```

The mutation declaration is its public generic contract; implement directly as useMutation<JobDetailDto, Error, void> and infer return rather than adding a wrapper abstraction. Invalidate queryKeys.job(jobId), jobs, and all short queries of that job on success; ongoing queued/running polling observes completion. New component uses the props in §10.1; no UI-side split scoring (`web/src/api/queries.ts:126-143`, `web/src/containers/ShortEditorPage.tsx:161-180`).

## 14. Follow-up: platform safe areas and scene robustness (2026-10-19)

Evidence. The operator posted a Machado short to Instagram (screenshot, iPhone 19.5:9). The status bar, Dynamic Island and the "Reels / Friends" header covered the hook text in the top band. Instagram filled the taller screen by cutting about 51 px of the 1080 canvas off each side, which cut the right table column. Measured on the 1080×1920 canvas: the top 0–250 px is under platform chrome, the caption and username sit in roughly the bottom 1700–1860 px, and the action buttons occupy x > 900 for y > 1100. A staging run on the four sample videos (`work/research-scene-grid.mts`) showed three algorithm defects:
- Borelli's commentary over portrait article screenshots became content-only, which hid the host.
- A PiP that moved inside a shot was missed between the 12 s samples (Borelli, 598–619 s).
- A borderline-portrait clip flipped between `vertical` true and false across adjacent shots (Kobori, 587–605 s).

### 14.1 Safe area
- `LayoutBase.safeArea: { top: number; bottom: number; side: number }`: canvas fractions of the area platforms may cover. Values:
  - new Boni, Jones, and Mix layout files: `{ "top": 0.135, "bottom": 0.17, "side": 0.055 }`;
  - the v8 migration of stored snapshots: `{ top: 0, bottom: 0, side: 0 }`, so existing jobs and exports render exactly as before.
  - The loader requires every value in [0, 0.3).
- Hook text: `TimelineHook.textCenterY` (px) = `round((max(bandTop, safe.top·H) + bandBottom) / 2)`.
  - ASS and the preview center the hook lines on `textCenterY` instead of the band center.
  - The loader rejects a layout whose band ends less than `maxLines·1.12·sizePx` px below `safe.top·H`.
- Fixed content panels: when `safeArea.side > 0` and the panel touches both canvas edges, the content crop uses the aspect of the panel inset by `side·W` on each side, with fill `contain`. The sharp foreground lands exactly inside the inset rect, and the sides are blurred.
- Scenes:
  - Documents compute `contentWindow` against the inset panel rect and render with `contain` over the whole panel.
  - Footage and person content keep cover over the full panel.
- End card: `END_CARD_LINK_CENTER_Y` changes from 1700 to 1480.
- New layout geometry:
  - Boni: band `{0,0,1,0.215}`; screen `{y:0.215,h:0.37}`; host `{y:0.585,h:0.415}`; captions `centerY` 0.585.
  - Mix: band `{0,0,1,0.215}`.
  - Jones: band `{x:0.05,y:0.14,w:0.9,h:0.11}`.

### 14.2 Scene robustness
- A. `defaultComposition`: vertical content forces `content` only when `kind !== 'document'`. A portrait document with a usable host stacks.
- B. `vertical` is computed at the infra edge from the content box in source pixels (`w/h < 0.7`). Remove `content_vertical` from the prompt and the schema.
- C. Camera-region change detection. After clustering, run one ffmpeg scdet pass per non-full camera cluster over the whole video, cropped to the cluster rect (5 fps, ≤256 px wide, threshold 15, metadata to a file).
  - For every peak inside a shot that is more than 1 s from an existing sample and from the shot's bounds, add a sample 0.4 s after the peak and call vision on it.
  - The peak time is the change boundary for the following sample, using the same `changes` input to `buildSceneSegments`.
  - Bounds: scan at most 4 clusters (most members first); skip clusters whose crop is under 64 source px on either side; never upscale the crop (`scale='min(256,iw)':-2`); keep at most 32 candidate samples per video, strongest peaks first; the scan shares the 30-minute scan timeout.
- D. Disagreeing adjacent samples inside a shot with no scdet peak between them are model noise.
  - Gate: compare the two frames as 64×36 greyscale thumbnails. If the mean absolute difference, on a 0–1 scale, is ≥ 0.1, the pair is a real change. Its boundary is the midpoint of the pair, with no vision call. Other pairs go to the vote.
  - Vote: take a third sample at the midpoint M of the pair (L, R).
    - If M failed, remove R.
    - If the signature of M equals that of L, remove R.
    - If the signature of M equals that of R, remove L.
    - If all three differ, remove M and R and keep L.
  - After the removals, every adjacent pair in a shot whose signatures differ and that has no change between them gets a change at its midpoint.
  - Limitation: when L is removed, the re-formed boundary is the midpoint between the previous kept sample and the winner, which can fall before L.
- E. `hostUsable`: the head-occlusion check (>20% of head area covered by content) applies only when the host camera is full-frame; an inset camera is drawn on top of the content and is never occluded, so full-screen footage with a PiP stacks.
- F. `smoothSceneHeads`: a head-smoothing run continues only while the segment's raw head has IoU ≥ 0.5 with the previous segment's raw head, in addition to the shared cluster id, so alternating close-ups and wide shots keep their own heads.
