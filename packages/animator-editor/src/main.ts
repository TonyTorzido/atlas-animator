/*
 * Atlas Animator editor: original implementation.
 *
 * Editor MVP (Phase 7 start): the project's AnimatorCharacter on a Pixi stage, a bone list, a rotate
 * gizmo that respects each bone's declared range, a timeline with keys, copy/paste pose, loop and
 * length, save/export of the clip in the atlas-anim@1 clip format, and live gate feedback from the
 * runtime's own checks. All clip edits are pure functions in clipModel.ts.
 */
import { promptDialog } from "./dialog.js";
import { AnimationLibrary, AnimationState, AnimationStateData, loadAnimDocument, Skeleton, type AnimDocument, type AttachmentData, type Bone, type ClipData, type CurveSpec } from "@atlas-animator/core/core";
import { AnimatorCharacter, chainImages, DynamicAtlas, loadPackedAtlas, loadRgbaImage, separateImages, type PartImageProvider, type RgbaImage } from "@atlas-animator/core/pixi";
import { Application, ColorMatrixFilter, Container, Graphics, RenderTexture, Text } from "pixi.js";
import { ROOT_COLOR, ROOT_WARN_COLOR, ROOT_WARNING, clipKeysRoot, hitsRootGlyph, rootLabel } from "./rootMaster.js";
import { importChannelSpec, isChannelSpec } from "./channelImport.js";
import {
  boneKeyTimes,
  clipFps,
  clipJson,
  deleteKeys,
  emptyClip,
  frameCount,
  frameTime,
  hasAnyKey,
  hasKey,
  heldTime,
  KEY_EPSILON,
  parseClip,
  pastePose,
  snapClipTimes,
  previewClipFps,
  setClipFps,
  setDuration,
  setLoop,
  setRotateKey,
  setVectorKey,
  timeToFrame,
  writeClip,
  type PoseCopy
} from "./clipModel.js";
import { ALL_OUTFITS, CLIP_FIXTURES, DEFAULT_OUTFIT, DISCOVERED_IDS, defaultOutfitId, OUTFITS, SAVE_DIR, discoverRigs, liveOutfitId, registerDiscoveredRigs, type DiscoveredRig, type OutfitFixture } from "./fixtures.js";
import "./newRig.css";
import { addPartsToRig, openNewRigDialog, pickPartFiles } from "./newRigDialog.js";
import { mountStepsCard, type StepId } from "./newRigSteps.js";
import { clipGates, poseGates, type GateIssue } from "./gates.js";
import { applyFacing, mirrorGates, type Facing } from "./facing.js";
import { createReducePanel } from "./reducePanel.js";
import { createTweenPanel } from "./tweenPanel.js";
import { isGeneratedKey } from "./tween.js";
import { reduceKeys as reduceKeysPure } from "./keyReduce.js";
import { gripPoint, otherSide, sideName, solveHands, type Side } from "./armIk.js";
import { planAddEvent } from "./eventRigPlans.js";
import { contactFrame, deleteEvent, EVENT_NAMES, eventIssues, eventsAt, hitLink, lockHit, placeEventLabel, PROFILE_STYLES, profileStepCount, renameEvent, setEvent, stepContactFrame, withEventDefs, type EventName } from "./eventModel.js";
import { createGamePreview, type GamePreview } from "./preview.js";
import { createGameView, type GameView } from "./gameView.js";
import { createPhonePush } from "./phonePush.js";
import { createViewAids, ONION_DEFAULTS, type OnionOptions, type ViewAids } from "./viewAids.js";
import {
  allKeys,
  boneChannelRow,
  boneKeySelected,
  rowBone,
  type BoneProperty,
  copyKeys,
  deleteSelectedKeys,
  isSelected,
  keysAtTime,
  keysInRange,
  deformRowId,
  deformRowsOfSlot,
  deleteFrames,
  insertFrames,
  reverseKeys,
  liveSelection,
  moveKeys,
  pasteKeys,
  rowKeyTimes,
  scaleClipTiming,
  scaleKeys,
  selectKeys,
  type KeyClipboard,
  type KeySel,
  type RowId
} from "./dopesheetModel.js";
import { bezier, CURVE_LABELS, CURVE_PRESETS, curveKind, keyCurveAt, setCurves, type Bezier, type CurveKind, type CurveTarget } from "./curveModel.js";
import { HANDLE_PX, keyDotOffsets, overlayHidden } from "./overlayModel.js";
import { drawHandles, handleAt, handleFrame as gizmoFrame, scaleAt, scaleStart, shearValue, type HandleFrame } from "./gizmoHandles.js";
import { boneColor, brighten, crumbChain, TINY_BONE_PX, wedgePolygon, wedgeWidth } from "./boneDraw.js";
import { boneChannelTimes, boneKeyTypesAt, clampView, fitView, frameToX, KEY_COLOR, KEY_TYPE_LABEL, KEY_TYPES, keyColorHex, labelStep, panView, sliderToSpan, xToFrameFloat, zoomToSlider, zoomView, type KeyType, type TlView } from "./timelineView.js";
import { footLockRanges, lockFoot, lockRoot, maxDrift, unlockFoot } from "./footLockModel.js";
import { silhouetteStats, type SilhouetteStats } from "./silhouetteModel.js";
import { anchorsFor, solveCompensation } from "./compensate.js";
import { BREAKDOWN_MAX, BREAKDOWN_MIN, BREAKDOWN_PRESETS, breakdownBones, clampBreakdown, type BreakdownResult } from "./breakdownModel.js";
import { applyMirror, makeMirrorRig, mirrorIkOps, mirrorOffsets, planFlip, planLimb, planMirror, setIkMixKey, type BodySide, type Limb, type MirrorOffsets, type MirrorPlan, type MirrorRig } from "./mirrorModel.js";
import {
  bonesInBox,
  helperBones,
  hiddenHelpers,
  normalBox,
  pickBone as pickBoneAt,
  rankBones,
  cycleStack,
  rangeBetween,
  segmentDistance,
  selectBones,
  snapDegrees,
  withSelectedAncestor,
  type BoneSelection,
  type PickBone,
  type SelectMode
} from "./selectionModel.js";
import { GESTURES, HOTKEYS, SETUP_KEYS, SETUP_SHARED, hotkeyAction, type HotkeyAction, type HotkeyDef } from "./hotkeys.js";
import { hotkeyActions, registerActions } from "./actionRegistry.js";
import { openPalette, paletteOpen } from "./palette.js";
import { assistRotation, moveReadout, rotateReadout, typeKey, typedValue, type AssistResult, type Readout } from "./poseAssist.js";
import { closeContextMenu, openContextMenu, type MenuItem } from "./contextMenu.js";
import { BONE_VIEW_LABEL, BONE_VIEWS, boneViewFor, boneWeight, chainBones, nextBoneView, writeBoneView, type BoneView } from "./boneView.js";
import { clipDownloadMessage, discardedMessage, keyPoseTip, loopMessage, spineExportLines, spineExportStatus, unkeyedBones, unkeyedChip } from "./feedbackModel.js";
import { clampTlHeight, historyStatus, historyTip, keyHoverText, nudgeLabel, parseTlHeight, snapDelta, stepLabel, TL_STEP_PX } from "./timelineUx.js";
import { createChrome, type Chrome, type SaveState, type StatusInfo } from "./chrome.js";
import "./workspace.css";
import "./ship.css";
import { activeRenderPreset } from "./ship.js";
import { setNewRigOpener } from "./home.js";
import { createEmitter, decorateTimeline, getCanvasTool, getHost, onCanvasTools, setHost, whenHost, type CanvasPoint, type EditorHost, type MeshInfo } from "./host.js";
import { installRuleOverlay } from "./ruleOverlay.js";
import { installShapeKeysApi } from "./deformTool.js";
import { installGateOverlay } from "./gateOverlay.js";
import { installLiveGateHud } from "./liveGateHud.js";
import { installRefUnderlay } from "./refUnderlay.js";
import { installHitLock } from "./hitLock.js";
import { installPoseLibrary } from "./poseLibrary.js";
import "./refUnderlay.css";
import "./hitLock.css";
import "./poseLibrary.css";
import { installMotionPaths } from "./motionPath.js";
import { installPins } from "./pins.js";
import "./pathsPins.css";
import "./ruleOverlay.css";
import { createSwagWorkshop } from "./swagWorkshop.js";
import { installPhoneSize } from "./phoneSize.js";
import { wearingText } from "./swagWorkshopModel.js";
import { createWorkspaces, parseWorkspace, WORKSPACES, type WorkspaceId } from "./workspace.js";
import { clipAfterDelete, startClipName } from "./startClip.js";
import { createPhoneDock } from "./phoneDock.js";
import { animateBoneLists, keyPoseBones, type AnimateBone } from "./animateBones.js";
import { installTransport, paintPlay, setTransportEnabled } from "./transport.js";
import "./transport.css";
import { installTransformStrip, poseRows } from "./transformStrip.js";
import { announceTools, installToolPalette } from "./toolPalette.js";
import "./transformStrip.css";
import "./layout.css";
import { installViewHud } from "./viewHud.js";
import "./viewHud.css";
import "./toolPalette.css";
import "./setupRig.css";
import { viewModes } from "./viewModes.js";
import { installLayout, setTipHidden } from "./layout.js";
import { guideBlock, installWorkspaceGuide } from "./workspaceGuide.js";
import { boneSelectable, imagesSelectable, drawMoveGizmo, drawRotateRef, getSpace, installCanvasEdge, layerFlag, moveArmAt, onRotateRing, projectMove, viewInsets, ZOOM_MAX, ZOOM_MIN, type Arm, type Layer } from "./canvasTools.js";
import type { Channel } from "./transformModel.js";
import type { XformRead } from "./host.js";
import "./outliner.css";
import "./imagesDock.css";
import "./inspector.css";
import "./meshTool.css";
import "./components.css";
import "./ui.css";
import { hideOutlinerBone, installOutliner, outlinerActive, outlinerHiddenBones, outlinerIconScale, outlinerLocked, renderOutliner, setOutlinerFull } from "./outliner.js";
import { createHome } from "./home.js";
import { installTooltips, TABS, TIPS, tipText, type TabId } from "./tooltips.js";
import { applyEasing, EASING_PRESETS, type EasingId } from "./easingModel.js";
import { arcStats, arcTangent, arcTargetSpec, parseArcTarget, stepColor, type ArcPoint, type ArcStats } from "./arcModel.js";
import { assertWeaponSlot, keySmear, pickByArc, renderSmear, smearTimes, SMEAR_STEPS, SMEAR_STRETCH, STOCK_INK_WIDTH, type Affine, type RegionPlacement } from "./smearModel.js";
import { STOCK_INK, STAND_IN_PATH, standInAxePixels, withStandInWeapon } from "./standInWeapon.js";
import { attachmentAt, attachmentKeyAt, deleteAttachmentKey, deleteDrawOrderKey, drawOrderAt, drawOrderKeyAt, setAttachmentKey, setDrawOrderKey, setDrawOrderOffset } from "./slotModel.js";
import { applyPoseRecord, makePose, parsePose, POSE_NAME, poseSummary, scopeDefaults, type ApplyOptions, type PoseDeform, type PoseInclude, type PoseMixes, type PoseRecord } from "./poseModel.js";
import { ikLiveAt, keyHandIk } from "./handIkLive.js";
import { createTracksPreview, type TracksPreview } from "./tracksPanel.js";
import { createTransitionsPreview, type TransitionsPreview } from "./transitionsPanel.js";
import { createGraphPanel, type GraphPanel } from "./graphPanel.js";
import { GRAPH_CHANNELS, boneChannels, channelById, channelKeys, sampleChannel, type GraphChannelId } from "./graphModel.js";
import { applySegmentPreset, curveChannelsOf, curveRange, hasSeg, presetOf, sameSeg, SEG_PRESETS, segmentAt, segmentCurve, segmentPoints, segmentsOf, segmentsOfKeys, type SegPresetId, type SegRef } from "./curveRows.js";
import { createSegPicker, type SegPicker } from "./segPicker.js";
import { DRAW_PRESETS, drawOrderState, resolveDrawPreset, type DrawPresetId } from "./drawOrderPresets.js";
import { activeHides, activeList, baseSkin, copySkinAttachment, createSkin, deleteSkin, duplicateSkin, removeSkinAttachment, renameSkinInDocument, resolveActive, setSetupPlaceholder, setSkinAttachment, setSkinHide, slotPlaceholderSkins, tintedAttachment, uniqueSkinName, type Skins } from "./skinModel.js";
import { skinsToSpine } from "./skinSpine.js";
import { lossLines, spineExportLoss, spineImportLoss } from "./interchangeLoss.js";
import { createSetup } from "./setupMode.js";
import "./meshTool.js"; // registers the Setup Mesh tool
import "./weightsTool.js";
import "./correctiveTool.js"; // registers the Setup Corrective sculpt tool
import { AUTOSAVE_CLIP, AUTOSAVE_FORMAT, AUTOSAVE_INTERVAL_MS, describeFlags, isSetupSession, setupSessionId, type AutosavePayload } from "./autosaveModel.js";
import { createAutosaver } from "./autosave.js";
import { initHelpMenu } from "./helpMenu.js";
import { loadKeymap, openKeymapEditor } from "./keymapEditor.js";
import { createHistoryPanel, fetchListing, offersFrom, showRestoreBar, whenLabel, type OfferItem } from "./historyPanel.js";
import { atlasRegions, type AtlasRegion } from "./setupAttach.js";
import type { JsonObject } from "./setupModel.js";
import { MAX_CLIP_FPS } from "./clipChannels.js";
import { createKeyInspector, type KeyInspector } from "./keyInspector.js";
import { createAudioTrack, type AudioTrack } from "./audioTrack.js";
import { apiError, confirmDialog, conflictDialog, installErrorToasts, installUnloadGuard, showToast, versionsDialog } from "./persistUi.js";
import { CLIP_BASE_HEADER, CLIP_BASE_NEW, copyClipName, textHash } from "./clipConflict.js";

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Props = { id?: string; className?: string; textContent?: string; title?: string; style?: string; value?: string; type?: string; step?: string; label?: string; selected?: boolean; href?: string; download?: string; placeholder?: string; checked?: boolean; src?: string; alt?: string; size?: number; width?: number; height?: number; min?: string; max?: string };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === "style") node.setAttribute("style", String(v));
    else (node as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
};

/** The bone name of a body side (hand_l / hand_near ...), whichever convention the open rig uses. */
const sn = (base: string, side: Side): string => (skeleton ? sideName(skeleton, base, side) : `${base}_${side}`);

const statusEl = $("status");

// The frame around the panels: right-panel tabs and the bottom status bar (chrome.ts).
let chrome: Chrome | null = null;
/** Change events for the project-UI modules (host.ts). */
const hostBus = createEmitter();
/** Set by an autosave in flight (the autosave feature calls atlasEditor.setAutosaving). */
let autosaving = false;
const GIZMO_LABELS: Record<string, string> = { rotate: "Rotate", move: "Move", scale: "Scale", shear: "Shear", ik: "Hand IK" };

function setAutosaving(on: boolean): void {
  autosaving = on;
  refreshStatusBar();
}

function saveState(): SaveState {
  if (autosaving) return "autosaving";
  return dirty.has(clipName) || rig?.skinsDirty ? "unsaved" : "saved";
}

function statusInfo(): StatusInfo {
  const setupTool = document.body.classList.contains("setup") ? document.querySelector("#toolpalette .tp-btn.on .tp-label")?.textContent?.trim() : null;
  return {
    tool: setupTool !== null ? `Setup: ${setupTool || "Select"}` : (GIZMO_LABELS[gizmoMode] ?? gizmoMode),
    flags: [compensate ? "Compensate" : "", autoKey ? "Auto key" : "Auto key off", unkeyedChip(unkeyedNow().length), drafts.size ? `${drafts.size} parked pose${drafts.size === 1 ? "" : "s"}` : ""].filter(Boolean),
    active: selected,
    names: [...multi],
    clip: clipName || "no clip",
    frame: clipName ? timeToFrame(clip, displayTime()) : 0,
    frames: clipName ? frameCount(clip) : 0,
    time: clipName ? displayTime() : 0,
    fps: clipName ? clipFps(clip) : 0,
    duration: clipName ? clip.duration : 0,
    loop: clipName ? clip.loop : false,
    save: saveState()
  };
}

function refreshStatusBar(): void {
  chrome?.refresh();
}
function status(text: string, kind: "" | "bad" | "ok" = ""): void {
  statusEl.textContent = text;
  statusEl.className = kind;
  statusEl.title = text;
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

interface Rig {
  outfit: OutfitFixture;
  doc: AnimDocument;
  images: PartImageProvider;
  /** Images made in the editor (the stand-in weapon, smears), by texture path; `images` already includes them. */
  extra: Map<string, RgbaImage>;
  /** The skin worn on top of the base skin (null = the base alone) and the further skins mixed in between (skins panel). */
  skinChoice: string | null;
  skinMix: string[];
  /** Skin edits not yet written to the rig file (Save / Apply write them), and the setup placeholders changed with them. */
  skinsDirty?: boolean;
  setupEdits?: Record<string, string | null>;
  /** The rig document as the file holds it (Setup mode edits this and rebuilds `doc` from it). */
  raw: JsonObject;
  /** The atlas images the rig can attach (Setup mode). */
  regions: AtlasRegion[];
}

const rigCache = new Map<string, Promise<Rig>>();
let rig: Rig | null = null;
let skeleton: Skeleton | null = null;
let character: AnimatorCharacter | null = null;
let atlas: DynamicAtlas | null = null;
let stateData: AnimationStateData | null = null;

/** Editable clips by name (copies: the rig documents only ever hold the clip being shown). */
const library = new Map<string, ClipData>();
const clipOrigin = new Map<string, string>();
const dirty = new Set<string>();
/** Hash of the saved clip text each clip was last read from or written to (sent as X-Clip-Base so another tab's save is not overwritten silently). */
const clipBase = new Map<string, string>();
let savedFiles: string[] = [];
let clipName = "";
let workspaceNow: (() => WorkspaceId) | null = null;
let workspaceGo: ((id: WorkspaceId) => void) | null = null;
let guide: ReturnType<typeof installWorkspaceGuide> | null = null;
let clip: ClipData = emptyClip();

let time = 0;
let playing = false;
/** "Return to start": when a non-looping clip ends, the playhead goes back to where play began (default on, remembered). */
const RETURN_KEY = "atlas-animator-return-start";
let returnToStart = (() => {
  try {
    return localStorage.getItem(RETURN_KEY) !== "0";
  } catch {
    return true;
  }
})();
let playStartTime = 0;
let held = true;
let autoKey = true;
let showBones = true;
/** How the bone overlay shows (all / dimmed / selected chain / hidden); remembered per workspace. showBones is derived from it. */
let boneView: BoneView = "full";
/** The visible view to come back to when the bones are hidden and shown again. */
let lastBoneView: BoneView = "full";
/** Helper bones (IK targets, weapon markers) on the canvas: off by default; a live IK target still shows as its pink square. */
let showHelpers = false;
/** The bone under the cursor (hover highlight and name label). */
let hoverBone: string | null = null;
/** Unkeyed rotate offsets from the gizmo (bone -> degrees from setup), cleared when the playhead moves. */
let pending: Record<string, number> = {};
/** Unkeyed translate offsets from the move gizmo (bone -> local offset from setup), cleared like `pending`. */
let pendingMove: Record<string, { x: number; y: number }> = {};
/** Unkeyed scale multipliers (of setup) from the scale gizmo, cleared like `pending`. */
let pendingScale: Record<string, { x: number; y: number }> = {};
/** Unkeyed shear offsets in degrees from setup from the shear gizmo, cleared like `pending`. */
let pendingShear: Record<string, { x: number; y: number }> = {};
type GizmoMode = "rotate" | "move" | "scale" | "shear" | "ik";
/** Two-hand grip: the second hand is pinned to a point of the dragged hand's frame (along / across its bone, px). */
let grip = { on: false, along: 70, across: 0 };
let lastIkSide: Side = "l";
/** Hand IK mode: false = bake the solve to FK rotate keys; true = keep the arm's IK constraint live (mix keyed to 1) and key the hand target bone. */
let ikLive = false;
let lastIkNames: string[] = [];
let gizmoMode: GizmoMode = "rotate";
/** Bones with an edit that is not keyed (any channel). */
function unkeyedNow(): string[] {
  return unkeyedBones(pending, pendingMove, pendingScale, pendingShear);
}
let unkeyedSig = "";
/** Tells the status bar, Key pose button, strip and dopesheet when the set of unkeyed bones changed. */
function syncUnkeyed(): void {
  const sig = unkeyedNow().join("|");
  if (sig === unkeyedSig) return;
  unkeyedSig = sig;
  refreshStatusBar();
  drawTimeline();
  hostBus.emit("pose");
}
function clearPending(): void {
  pending = {};
  pendingMove = {};
  pendingScale = {};
  pendingShear = {};
}

/**
 * An unkeyed pose parked by a scrub, Play or a clip / rig switch (). Moving away from a frame no longer throws the edits away: they
 * are kept here per rig / clip / frame, come back when the playhead returns to that frame, count as unsaved work for the leave-page guard
 * and ride along in every autosave. Only Esc, Discard unkeyed or keying them ends a draft.
 */
interface PoseDraft {
  outfit: string;
  clip: string;
  frame: number;
  rotate: Record<string, number>;
  move: Record<string, { x: number; y: number }>;
  scale: Record<string, { x: number; y: number }>;
  shear: Record<string, { x: number; y: number }>;
}
const drafts = new Map<string, PoseDraft>();
const draftKey = (outfit: string, clipId: string, frame: number) => `${outfit}|${clipId}|${frame}`;
const draftBones = (d: PoseDraft) => unkeyedBones(d.rotate, d.move, d.scale, d.shear);

/** Parks the unkeyed edits at the current rig / clip / frame; returns the bones parked. */
function parkPending(): string[] {
  const names = unkeyedNow();
  if (!names.length) return [];
  if (!rig) {
    clearPending();
    return names;
  }
  const frame = timeToFrame(clip, time);
  const key = draftKey(rig.outfit.id, clipName, frame);
  const old = drafts.get(key);
  drafts.set(key, {
    outfit: rig.outfit.id,
    clip: clipName,
    frame,
    rotate: { ...old?.rotate, ...pending },
    move: { ...old?.move, ...pendingMove },
    scale: { ...old?.scale, ...pendingScale },
    shear: { ...old?.shear, ...pendingShear }
  });
  clearPending();
  return names;
}

/** Brings back the draft parked at the current rig / clip / frame (edits made here since win); returns its bones. */
function unparkDraft(): string[] {
  if (!rig) return [];
  const key = draftKey(rig.outfit.id, clipName, timeToFrame(clip, time));
  const d = drafts.get(key);
  if (!d) return [];
  drafts.delete(key);
  pending = { ...d.rotate, ...pending };
  pendingMove = { ...d.move, ...pendingMove };
  pendingScale = { ...d.scale, ...pendingScale };
  pendingShear = { ...d.shear, ...pendingShear };
  return draftBones(d);
}

/** The drafts of one clip of the open rig plus the live unkeyed edits as one more (the autosave copy). */
function draftsOf(clipId: string): PoseDraft[] {
  const out = [...drafts.values()].filter((d) => d.outfit === rig?.outfit.id && d.clip === clipId);
  if (rig && clipId === clipName && unkeyedNow().length)
    out.push({ outfit: rig.outfit.id, clip: clipName, frame: timeToFrame(clip, time), rotate: { ...pending }, move: { ...pendingMove }, scale: { ...pendingScale }, shear: { ...pendingShear } });
  return out;
}

/** "Unkeyed changes on head, chest parked at frame 4 ..." for a scrub / play / switch. */
function parkedMessage(names: string[], frame: number, where = ""): string {
  const who = names.length > 3 ? `${names.length} bones` : names.join(", ");
  return `Unkeyed changes on ${who} parked at frame ${frame}${where}: go back to that frame to key them (or Discard unkeyed there)`;
}

/**
 * Closes the layered Tracks (mix) preview so the stage shows the clip being edited again (). `why` names what closed it
 * ("Playing the clip", "Editing"), shown on the status line.
 */
function exitMixPreview(why = ""): void {
  const shown = mixPreview();
  if (!shown) return;
  shown.setActive(false);
  markPose();
  syncMixBanner();
  status(`${why ? `${why}: ` : ""}mix preview closed, the stage shows the clip you are editing`);
}

/** The persistent "Mix preview" banner over the stage, with Back to the clip, while the Tracks preview replaces the edited pose. */
function syncMixBanner(): void {
  const on = !!mixPreview();
  let banner = document.getElementById("mixbanner");
  if (!on) {
    if (banner) banner.hidden = true;
    return;
  }
  if (!banner) {
    banner = el("div", { className: "hud mixbanner" });
    banner.id = "mixbanner";
    banner.setAttribute("role", "status");
    const back = el("button", { textContent: "Back to the clip", title: "Exit the mix preview: the stage shows the clip you are editing again (the Tracks setup is kept)" });
    back.id = "mixbanner-exit";
    back.type = "button";
    back.addEventListener("click", () => exitMixPreview());
    banner.append(el("span", { className: "label", id: "mixbanner-text", textContent: "" }), back);
    banner.style.cssText = "position:absolute;left:50%;top:8px;transform:translateX(-50%);z-index:30;display:flex;gap:10px;align-items:center;padding:6px 10px;border:2px solid var(--warn, #e0a030)";
    viewEl.append(banner);
  }
  banner.hidden = false;
  const text = banner.querySelector<HTMLElement>("#mixbanner-text");
  if (text) text.textContent = transitionsPreview?.active() ? "Transitions preview: the stage shows the clip graph, not the clip you are editing" : "Mix preview: the stage shows the layered tracks, not the clip you are editing";
}

let selected: string | null = null;
/** Every selected bone (the active one `selected` is always in it): box select, Shift / Ctrl click. */
let multi = new Set<string>();
/** Compensate: while a bone is moved or rotated its direct children stay where they were on screen. */
let compensate = false;
/** IK targets and weapon markers (steer the rig, no art): picked last, hidden while their constraint is off. */
let helperSet = new Set<string>();
/** Selected dopesheet keys, the copied keys, and the play range (frames, inclusive) playback loops inside. */
let keySel: KeySel[] = [];
/** The Keys tab's key inspector (built once the panels exist). */
let keyInspector: KeyInspector | null = null;
let audioTrack: AudioTrack | null = null;
/** Preview-only playback speed multiplier (0.1 to 2): scales how fast the playhead moves, never the clip's authored fps. */
let playSpeed = 1;
let keyBoard: KeyClipboard | null = null;
let lastCopy: "pose" | "keys" = "pose";
let playRange: { a: number; b: number } | null = null;
/** The slot shown in the Slot panel (attachment swaps and draw order). */
let selectedSlot: string | null = null;
let poseClipboard: PoseCopy | null = null;
interface HistoryStep {
  name: string;
  clip: ClipData;
  /** What the step did, for the Undo / Redo tooltip and status ("Moved 6 keys by 12 frames"). */
  label?: string | undefined;
  /** A step that is not a clip edit (wearing a swag item): undo / redo run these instead of swapping the clip. */
  swap?: { undo: () => void; redo: () => void } | undefined;
  /** A skin edit (): also undoable from the Rig workspace while it is the newest step. */
  skin?: boolean | undefined;
}
const undoStack: HistoryStep[] = [];
const redoStack: HistoryStep[] = [];
/** The dopesheet key selection each clip state had when an edit left it, so undo / redo put the matching keys back (P0-4). */
const selOf = new WeakMap<ClipData, KeySel[]>();
/** Set by an edit that changes `keySel` before it commits, so the state it leaves remembers the selection it had. */
let editSelBefore: KeySel[] | null = null;
let limitHit: { bone: string; bound: "min" | "max"; value: number } | null = null;

const BACKGROUNDS = [
  { name: "Night", color: 0x1e2430 },
  { name: "Grey", color: 0x6b6f76 },
  { name: "Light", color: 0xe8e4da },
  { name: "Grass", color: 0x4f7a3a }
];
let background = BACKGROUNDS[0]!.color;

// ---------------------------------------------------------------------------------------------
// Pixi viewport
// ---------------------------------------------------------------------------------------------

const viewEl = $("view");
const app = new Application();
const world = new Container({ label: "world" });
const overlay = new Graphics();
const retired: { node: AnimatorCharacter; atlas: DynamicAtlas | null; ticks: number }[] = [];
/** A Setup commit remounts the same images: keep the atlas (its pages already hold them) instead of resampling everything. Cleared when an image is added. */
let reuseAtlas = false;
let preview: GamePreview | null = null;
let gameView: GameView | null = null;
let phone: ReturnType<typeof createPhonePush> | null = null;
let aids: ViewAids | null = null;
const objectIds = new WeakMap<object, number>();
let objectIdNext = 0;
/** A stable small number per object, for cache signatures that must change when a clip / character object is replaced. */
function objectId(o: object): number {
  let id = objectIds.get(o);
  if (id === undefined) objectIds.set(o, (id = ++objectIdNext));
  return id;
}
let tracksPreview: TracksPreview | null = null;
/** The clip transition graph preview (Batch 12c): takes the same stage slot as the layered Tracks preview; only one is on at a time. */
let transitionsPreview: TransitionsPreview | null = null;
/** The stage preview that is on (layered Tracks or the Transitions graph), or null. */
const mixPreview = (): Pick<TracksPreview, "active" | "setActive" | "tick" | "apply"> | null => (tracksPreview?.active() ? tracksPreview : transitionsPreview?.active() ? transitionsPreview : null);
let poseDirty = true;
let renderDirty = true;
let lastFrame = 0;
let renderFailed = false;
let flushQueued = false;
/** True once app.init has finished: before that app.renderer does not exist, and a render (fit, a resize, a workspace switch) must wait for it. */
let pixiReady = false;
/** Set by the playback check (atlasEditor.frameTimes): the milliseconds each editor frame took on the main thread. */
let frameTimes: number[] | null = null;

async function initPixi(): Promise<void> {
  // The editor drives its own frames (no Pixi ticker): rAF while visible, plus an immediate flush
  // after every edit so a hidden or throttled window still shows the current pose.
  await app.init({ resizeTo: viewEl, background, antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true, preference: "webgl", autoStart: false });
  app.ticker.stop();
  pixiReady = true;
  viewEl.prepend(app.canvas);
  app.stage.addChild(world);
  world.addChild(overlay);
  new ResizeObserver(() => {
    if (app.renderer) app.resize();
    requestRender();
  }).observe(viewEl);
  requestRender();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (!frameTimes) return frame(now);
    const t0 = performance.now();
    frame(now);
    frameTimes.push(performance.now() - t0);
  };
  requestAnimationFrame(loop);
  aids = createViewAids({
    app,
    world,
    overlay,
    poseAtFrame: (f) => applyPoseAt(Math.min(clip.duration, frameTime(clip, f)), false),
    restorePose: () => applyPoseAt(displayTime(), true),
    poseAsPin: () => applyPinPose(),
    frame: () => timeToFrame(clip, displayTime()),
    frames: () => frameCount(clip),
    loops: () => clip.loop,
    keyFrames: () => [...new Set(allKeys(clip).map((k) => timeToFrame(clip, k.time)))],
    onionScope: () => {
      const names = selectedBones();
      if (!names.length) return null;
      const set = new Set(names);
      return {
        key: [...set].sort().join(","),
        hide: () => {
          const meshes = character?.slotMeshes;
          if (!meshes || !skeleton) return;
          skeleton.drawOrder.forEach((slot, i) => {
            if (!set.has(slot.bone.data.name) && meshes[i]) meshes[i]!.visible = false;
          });
        }
      };
    },
    onionKey: () => `${objectId(clip)}|${skeleton?.activeSkins.join("+") ?? ""}|${character ? objectId(character) : 0}|${world.x.toFixed(1)},${world.y.toFixed(1)},${world.scale.x.toFixed(4)}|${facingRight}|${setup.active()}|${background}`,
    playing: () => playing,
    fps: () => clipFps(clip),
    time: () => displayTime()
  });
  loadOnionSettings();
  preview = createGamePreview({
    app,
    world,
    overlay,
    viewEl,
    background: () => background,
    time: () => displayTime(),
    fps: () => clipFps(clip),
    frames: () => frameCount(clip),
    playing: () => playing
  });
  gameView = createGameView({
    app,
    world,
    viewEl,
    character: () => character,
    skeleton: () => skeleton,
    doc: () => rig?.doc ?? null,
    rigId: () => rig?.outfit.id ?? "",
    clipName: () => clipName,
    clip: () => clip,
    clips: () => Object.fromEntries(library),
    editorTime: () => displayTime(),
    restorePose: () => applyPoseAt(displayTime(), true)
  });
  // Phone preview (phonePush.ts): the clip being edited live on the user's phone, over the local network, opt-in.
  phone = createPhonePush({
    before: $("helpbtn"),
    snapshot: () =>
      rig && clipName
        ? {
            clipName,
            clip,
            facing: facingRight ? "right" : "left",
            rigIdentity: [rig.outfit.id, rig.raw, activeSkinNames().join("+")],
            rig: () => ({ raw: rig!.raw, meta: { document: rig!.outfit.document, atlas: rig!.outfit.atlas, standIn: !!rig!.outfit.standInWeapon, skins: activeSkinNames() } })
          }
        : null
  });
}

function frame(now: number): void {
  const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  const shownPreview = mixPreview();
  if (shownPreview) {
    shownPreview.tick(dt);
    poseDirty = true;
  }
  const mixShown = !!shownPreview;
  if (mixShown !== (document.getElementById("mixbanner")?.hidden === false)) syncMixBanner();
  if (playing && clip.duration > 0) {
    time += dt * playSpeed;
    if (playRange) {
      const fps = clipFps(clip);
      const endT = Math.min(clip.duration, (playRange.b + 1) / fps);
      if (time >= endT) time = frameTime(clip, playRange.a) + ((time - endT) % Math.max(1 / fps, endT - frameTime(clip, playRange.a)));
    } else if (time > clip.duration) {
      if (clip.loop) time %= clip.duration;
      else {
        time = returnToStart ? playStartTime : clip.duration;
        setPlaying(false);
      }
    }
    poseDirty = true;
    updateReadout();
    drawTimeline();
    audioTrack?.tick();
  }
  // While a gesture runs the canvas is redrawn on every display frame too (not only inside the pointer event), so a frame the browser
  // dropped or presented late during a fast drag is corrected on the next one.
  if (drag && drag.kind !== "box") renderDirty = true;
  flush();
}

/** Poses and renders now if anything changed. */
function flush(): void {
  flushQueued = false;
  if (!pixiReady) return; // renderer not created yet: the dirty flags stay set and initPixi renders once it is
  if (poseDirty) {
    poseDirty = false;
    try {
      pose();
    } catch (error) {
      console.error("pose failed", error);
      status(`Pose failed: ${error instanceof Error ? error.message : String(error)}`, "bad");
    }
  }
  if (!renderDirty) return;
  renderDirty = false;
  // Playback: the onion ghosts come from the texture cache (at most one missing frame is rendered per display frame).
  if (playing) aids?.renderOnion();
  try {
    app.renderer.render(app.stage);
  } catch (error) {
    if (!renderFailed) console.error("render failed", error);
    renderFailed = true;
  }
  // A replaced character is destroyed only after a render without it (Phase 6 lesson).
  for (let i = retired.length - 1; i >= 0; i--) {
    const r = retired[i]!;
    if (--r.ticks <= 0) {
      r.node.destroy({ children: true });
      r.atlas?.destroy();
      retired.splice(i, 1);
    }
  }
  if (retired.length) requestRender();
}

function requestRender(): void {
  renderDirty = true;
  if (!flushQueued) {
    flushQueued = true;
    setTimeout(flush, 0);
  }
}

function displayTime(): number {
  // The game-size preview always shows held frames, so while it is open so does the main view.
  return held || preview?.isOpen() ? Math.min(clip.duration, heldTime(clip, time)) : time;
}

// ---------------------------------------------------------------------------------------------
// Registered tools (host.registerCanvasTool) and editor-only slot hiding
// ---------------------------------------------------------------------------------------------

/** The current Animate canvas tool (host.setCanvasTool), or null. */
let canvasToolId: string | null = null;
/** Slots whose art a tool hides while it draws its own preview over them. */
const hiddenSlots = new Set<string>();
let canvasToolPanel: HTMLElement | null = null;

/** Updates the character, then re-applies the editor-only slot hiding (the runtime sets each mesh's visibility when the pose changes). */
function updateCharacter(): void {
  if (!character) return;
  character.update();
  if (!hiddenSlots.size || !skeleton) return;
  const meshes = character.slotMeshes;
  skeleton.drawOrder.forEach((slot, i) => {
    if (hiddenSlots.has(slot.data.name) && meshes[i]) meshes[i]!.visible = false;
  });
}

function setSlotHidden(slot: string, hidden: boolean): void {
  if (hidden === hiddenSlots.has(slot)) return;
  if (hidden) hiddenSlots.add(slot);
  else hiddenSlots.delete(slot);
  markPose();
}

function activeCanvasTool() {
  return !setup.active() ? getCanvasTool(canvasToolId) : undefined;
}

function renderCanvasToolPanel(force = true): void {
  const tool = getCanvasTool(canvasToolId);
  if (!tool || setup.active()) {
    canvasToolPanel?.remove();
    canvasToolPanel = null;
    return;
  }
  if (canvasToolPanel && !force) return;
  if (!canvasToolPanel) {
    canvasToolPanel = el("div", {});
    canvasToolPanel.id = "ctool-panel";
    canvasToolPanel.className = "hud";
    canvasToolPanel.setAttribute("style", "top:56px;right:10px;flex-direction:column;align-items:stretch;gap:6px;max-width:300px;z-index:5;padding:8px 10px;");
    viewEl.append(canvasToolPanel);
  }
  canvasToolPanel.replaceChildren();
  tool.panel?.(canvasToolPanel, getHost()!);
}

function setCanvasTool(id: string | null): void {
  const next = id && getCanvasTool(id) ? id : null;
  if (next === canvasToolId) return;
  const host = getHost();
  if (host) getCanvasTool(canvasToolId)?.deactivate?.(host);
  canvasToolId = next;
  if (host) getCanvasTool(canvasToolId)?.activate?.(host);
  renderCanvasToolPanel();
  hostBus.emit("tool");
  drawOverlay();
}
// Entering / leaving Setup mode shows / hides the panel (the body class changes with the mode).
new MutationObserver(() => renderCanvasToolPanel(false)).observe(document.body, { attributes: true, attributeFilter: ["class"] });
onCanvasTools(() => {
  if (canvasToolId && !getCanvasTool(canvasToolId)) canvasToolId = null;
  renderCanvasToolPanel();
  drawOverlay();
});

/** Every mesh attachment in the open rig. */
function listMeshes(): MeshInfo[] {
  const out: MeshInfo[] = [];
  const skins = rig?.doc.skins ?? {};
  for (const [skin, data] of Object.entries(skins)) {
    for (const [slot, attachments] of Object.entries(data.attachments)) {
      for (const [attachment, a] of Object.entries(attachments)) {
        if (a.type === "mesh") out.push({ slot, skin, attachment, vertexCount: Math.floor(a.uvs.length / 2), weighted: Array.isArray(a.bones) && a.bones.length > 0 });
      }
    }
  }
  return out;
}

/** Poses the skeleton at clip time `t` (held), optionally with the unkeyed gizmo edits, and updates the character. */
function applyPoseAt(t: number, withEdits: boolean): void {
  if (!skeleton || !character) return;
  if (setup.active()) {
    // Setup mode shows the rig itself, not a clip, plus the bone edit being dragged (committed to the rig on mouse-up).
    skeleton.setToSetupPose();
    setup.applyLive(skeleton);
    updateCharacter();
    return;
  }
  // Swap A / B: the character shows pinned pose A in place of the live pose (look-only; any edit puts B back first).
  if (withEdits && abView && applyPinPose()) return;
  if (!clipName) {
    // No clip (a rig with none, or its only clip deleted): the setup pose plus the working pose (the unkeyed gizmo edits below), never a half-built skeleton.
    skeleton.setToSetupPose();
  } else {
    if (!stateData) return;
    const state = new AnimationState(stateData);
    // The clip's own loop flag: the runtime clamps bone ranges on a loop and lifts them on a one-shot.
    state.setAnimation(0, clipName, { loop: clip.loop });
    state.update(clip.loop ? Math.min(t, Math.max(0, clip.duration - 1e-4)) : t);
    state.apply(skeleton);
  }
  if (withEdits) applyEditSet({ pending, move: pendingMove, scale: pendingScale, shear: pendingShear });
  updateCharacter();
}

/** Unkeyed gizmo edits written onto the posed skeleton (the live ones, or the set a pinned pose A captured). */
interface EditSet {
  pending: Record<string, number>;
  move: Record<string, { x: number; y: number }>;
  scale: Record<string, { x: number; y: number }>;
  shear: Record<string, { x: number; y: number }>;
}
function applyEditSet(e: EditSet): void {
  if (!skeleton) return;
  for (const [name, value] of Object.entries(e.pending)) {
    const bone = skeleton.findBone(name);
    if (bone) bone.pose.rotation = bone.data.rotation + value;
  }
  for (const [name, m] of Object.entries(e.move)) {
    const bone = skeleton.findBone(name);
    if (bone) {
      bone.pose.x = bone.data.x + m.x;
      bone.pose.y = bone.data.y + m.y;
    }
  }
  for (const [name, m] of Object.entries(e.scale)) {
    const bone = skeleton.findBone(name);
    if (bone) {
      bone.pose.scaleX = bone.data.scaleX * m.x;
      bone.pose.scaleY = bone.data.scaleY * m.y;
    }
  }
  for (const [name, m] of Object.entries(e.shear)) {
    const bone = skeleton.findBone(name);
    if (bone) {
      bone.pose.shearX = bone.data.shearX + m.x;
      bone.pose.shearY = bone.data.shearY + m.y;
    }
  }
}

function pose(): void {
  if (!skeleton || !character) return;
  const mixShownNow = mixPreview();
  if (mixShownNow) {
    // Layered preview: the combined tracks (or the transition graph) replace the edited clip on the stage (the clip itself is untouched).
    mixShownNow.apply(skeleton);
    updateCharacter();
    drawOverlay();
    preview?.render();
    return;
  }
  applyPoseAt(displayTime(), true);
  aids?.updateUnderlay();
  aids?.renderOnion();
  renderPinGhost();
  drawOverlay();
  preview?.render();
  gameView?.refresh();
  if (!playing) {
    // Panels read the posed skeleton: refresh them now that the pose is current.
    renderDetail();
    if (!drag) scheduleGates();
  }
  hostBus.emit("pose");
}

// ---------------------------------------------------------------------------------------------
// Pose A / B compare: pin the current pose as A (a frozen copy of the clip, the frame and the unkeyed edits), show it as a ghost over the
// live pose B, or swap it in place of B. Works across frames and clips because A keeps its own copy of the clip it was pinned from.
// ---------------------------------------------------------------------------------------------

const PIN_CLIP = "__pose_a";
interface PinnedPose {
  outfit: string;
  clipName: string;
  frame: number;
  time: number;
  clip: ClipData;
  edits: EditSet;
  doc: AnimDocument;
  data: AnimationStateData;
  version: number;
}
let pin: PinnedPose | null = null;
/** Pinned pose A drawn as a violet ghost over the live pose. */
let pinGhost = false;
/** Swap A / B: the character shows A in place of the live pose B. */
let abView = false;
let pinVersion = 0;
let pinKey = "";
let abSig = "";

/** The runtime ties a state to the exact document object its skeleton was built from: compile the frozen clip into that document's library. */
function buildPinData(doc: AnimDocument, frozen: ClipData): AnimationStateData {
  const saved = doc.animations;
  doc.animations = { [PIN_CLIP]: frozen };
  try {
    return new AnimationStateData(new AnimationLibrary(doc));
  } finally {
    doc.animations = saved;
  }
}

/** Poses the skeleton as pinned pose A. False when nothing is pinned or A was pinned on another rig. */
function applyPinPose(): boolean {
  if (!pin || !skeleton || !character || !rig || rig.outfit.id !== pin.outfit) return false;
  try {
    if (pin.doc !== rig.doc) {
      pin.data = buildPinData(rig.doc, pin.clip);
      pin.doc = rig.doc;
    }
    skeleton.setToSetupPose();
    const state = new AnimationState(pin.data);
    state.setAnimation(0, PIN_CLIP, { loop: pin.clip.loop });
    state.update(pin.clip.loop ? Math.min(pin.time, Math.max(0, pin.clip.duration - 1e-4)) : pin.time);
    state.apply(skeleton);
  } catch {
    return false;
  }
  applyEditSet(pin.edits);
  updateCharacter();
  return true;
}

const pinLabel = (p: PinnedPose) => `${p.clipName || "no clip"} frame ${p.frame}`;

function pinPose(): void {
  if (!rig || !skeleton) return void status("Open a rig first", "bad");
  if (abView) setAbView(false);
  if (setup.active()) return void status("Pose A pins a posed frame: leave Setup mode first", "bad");
  const frozen = structuredClone(clipName ? clip : emptyClip(1, false));
  pin = {
    outfit: rig.outfit.id,
    clipName,
    frame: timeToFrame(clip, displayTime()),
    time: displayTime(),
    clip: frozen,
    edits: structuredClone({ pending, move: pendingMove, scale: pendingScale, shear: pendingShear }),
    doc: rig.doc,
    data: buildPinData(rig.doc, frozen),
    version: ++pinVersion
  };
  pinGhost = true;
  pinKey = "";
  updateAbUi();
  markPose();
  status(`Pinned pose A: ${pinLabel(pin)}. E shows or hides its ghost, \\ swaps A and B`, "ok");
}

function clearPin(): void {
  if (!pin) return;
  pin = null;
  pinGhost = false;
  abView = false;
  pinKey = "";
  aids?.setPinGhost(false);
  updateAbUi();
  markPose();
  status("Cleared pose A");
}

function togglePinGhost(): void {
  if (!pin) return void status("Pin a pose first (Q pins the current pose as A)");
  pinGhost = !pinGhost;
  pinKey = "";
  if (pinGhost && abView) abView = false;
  updateAbUi();
  markPose();
  status(pinGhost ? `Pose A ghost on (${pinLabel(pin)})` : "Pose A ghost off");
}

function setAbView(on: boolean): void {
  if (on && !pin) return void status("Pin a pose first (Q pins the current pose as A)");
  if (on && rig && pin && rig.outfit.id !== pin.outfit) return void status(`Pose A was pinned on the ${pin.outfit} rig: switch back to it to compare`, "bad");
  if (on && playing) setPlaying(false);
  if (abView === on) return;
  abView = on;
  updateAbUi();
  markPose();
  status(on ? `Showing pose A (${pin ? pinLabel(pin) : ""}): \\ returns to the live pose B` : "Back to the live pose B");
}

/** The A / B buttons, the info line and the canvas badge. */
function updateAbUi(): void {
  const mismatch = !!pin && !!rig && rig.outfit.id !== pin.outfit;
  const text = pin ? `A: ${pinLabel(pin)}${mismatch ? ` (pinned on ${pin.outfit}: switch back to compare)` : ""}` : "No pose pinned. Q pins the current pose as A";
  const badge = abView ? `Showing A: ${pin ? pinLabel(pin) : ""}  \u00b7  \\ for B` : pinGhost && pin ? `A ghost: ${pinLabel(pin)}` : "";
  const sig = `${text}|${badge}|${pinGhost}|${abView}|${!!pin}`;
  if (sig === abSig) return;
  abSig = sig;
  $("abinfo").textContent = text;
  $("abghost").classList.toggle("on", pinGhost && !!pin);
  $("abswap").classList.toggle("on", abView);
  for (const id of ["abghost", "abswap", "abclear"]) ($(id) as HTMLButtonElement).disabled = !pin;
  const b = $("abbadge");
  b.textContent = badge;
  b.classList.toggle("show", !!badge);
  b.classList.toggle("a", abView);
}

/** Keeps the A ghost current: re-rendered only when the pin or the view changed (A itself never moves while B is edited). */
function renderPinGhost(): void {
  updateAbUi();
  if (!aids) return;
  const show = pinGhost && !!pin && !abView && !!rig && rig.outfit.id === pin.outfit;
  aids.setPinGhost(show);
  if (!show) return;
  const key = [pin!.version, world.x.toFixed(1), world.y.toFixed(1), world.scale.x.toFixed(4), app.screen.width, app.screen.height, facingRight, rig?.skinChoice ?? "", rig?.skinMix.join(",") ?? ""].join("|");
  if (!playing && key === pinKey && aids.info().pin.visible) return;
  pinKey = key;
  aids.renderPin();
}

function hideLimitFlash(): void {
  limitHit = null;
  $("limitflash").style.display = "none";
}

function markPose(): void {
  poseDirty = true;
  requestRender();
}

function zoom(): number {
  return world.scale.x;
}

/** The view that frames the whole character, or null while the viewport has no size yet. */
function fitGoal(): { z: number; x: number; y: number } | null {
  if (!rig) return null;
  const c = rig.doc.canvas;
  // The art sits in the canvas rectangle; skeleton space has its origin at (originX, originY).
  // The free canvas: the view minus the toolbar row (top), the edge column (left) and the tip line + transform strip (bottom).
  const ins = viewInsets(viewEl);
  const w = viewEl.clientWidth - ins.l;
  const h = viewEl.clientHeight - ins.t - ins.b;
  if (w < 50 || h < 50) return null;
  const z = Math.min(8, Math.max(0.05, Math.min(w / (c.width * 0.75), h / (c.height * 0.8))));
  return { z, x: ins.l + w / 2 - (c.width / 2 - c.originX) * z, y: ins.t + h / 2 - (c.height / 2 - c.originY) * z };
}

/** The part of the character art Fit keeps clear of every overlay (page coordinates), for scripted overlap checks; null without a rig. */
function artBox(): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!rig) return null;
  const c = rig.doc.canvas;
  const z = zoom();
  const r = viewEl.getBoundingClientRect();
  const cx = r.left + world.x + (c.width / 2 - c.originX) * z;
  const cy = r.top + world.y + (c.height / 2 - c.originY) * z;
  return { x0: cx - c.width * z * 0.375, x1: cx + c.width * z * 0.375, y0: cy - c.height * z * 0.4, y1: cy + c.height * z * 0.4 };
}

function showView(z: number, x: number, y: number): void {
  world.scale.set(z);
  world.position.set(x, y);
  $("zoom").textContent = `${Math.round(z * 100)}%`;
  drawOverlay();
}

function fit(): void {
  viewGoal = null;
  const g = fitGoal();
  if (!g) {
    if (rig) requestAnimationFrame(fit);
    return;
  }
  showView(g.z, g.x, g.y);
}

// Smooth view: wheel zoom, +/-, Fit and Frame ease toward a goal view (zoom about the cursor stays anchored); direct calls
// (`fit()`, the API) and pans cancel it.
let viewGoal: { z: number; x: number; y: number } | null = null;
let viewTimer = 0;
let viewLast = 0;
const VIEW_RATE = 18;

function stepView(dt: number): void {
  const g = viewGoal;
  if (!g) return;
  const k = 1 - Math.exp(-VIEW_RATE * dt);
  const z = zoom();
  const nz = z * Math.pow(g.z / z, k);
  const nx = world.x + (g.x - world.x) * k;
  const ny = world.y + (g.y - world.y) * k;
  if (Math.abs(Math.log(g.z / nz)) < 0.002 && Math.hypot(g.x - nx, g.y - ny) < 0.4) {
    viewGoal = null;
    showView(g.z, g.x, g.y);
  } else showView(nz, nx, ny);
}

function goToView(goal: { z: number; x: number; y: number }): void {
  viewGoal = { z: Math.min(8, Math.max(0.05, goal.z)), x: goal.x, y: goal.y };
  if (viewTimer) return;
  viewLast = performance.now();
  const tick = () => {
    const now = performance.now();
    stepView(Math.min(0.05, (now - viewLast) / 1000));
    viewLast = now;
    viewTimer = viewGoal ? window.setTimeout(tick, 16) : 0;
  };
  viewTimer = window.setTimeout(tick, 16);
}

/** Zooms by `factor` about the screen point (cx, cy), easing there; repeated wheel ticks add up on the pending goal. */
function zoomAt(factor: number, cx: number, cy: number): void {
  const base = viewGoal ?? { z: zoom(), x: world.x, y: world.y };
  const nz = Math.min(8, Math.max(0.05, base.z * factor));
  const k = nz / base.z;
  goToView({ z: nz, x: cx - (cx - base.x) * k, y: cy - (cy - base.y) * k });
}

/** Frames world-space bounds in the viewport, easing there. */
function frameBounds(b: { x0: number; y0: number; x1: number; y1: number }): void {
  const w = viewEl.clientWidth;
  const h = viewEl.clientHeight;
  if (w < 50 || h < 50) return;
  const bw = Math.max(1, b.x1 - b.x0);
  const bh = Math.max(1, b.y1 - b.y0);
  const pad = Math.max(110, Math.max(bw, bh) * 0.3);
  const z = Math.min(4, Math.max(0.05, Math.min(w / (bw + pad * 2), h / (bh + pad * 2))));
  goToView({ z, x: w / 2 - ((b.x0 + b.x1) / 2) * z, y: h / 2 - ((b.y0 + b.y1) / 2) * z });
}

/** Eases back to the whole-character view. */
function fitSmooth(): void {
  const g = fitGoal();
  if (g) goToView(g);
}

function boneEnds(bone: Bone): { ox: number; oy: number; tx: number; ty: number } {
  const tip = bone.localToWorld(bone.data.length, 0, { x: 0, y: 0 });
  return { ox: bone.world.x, oy: bone.world.y, tx: tip.x, ty: tip.y };
}

/** Clockwise degrees of the bone's x axis in skeleton space (y down). */
function worldAngle(bone: Bone): number {
  return (Math.atan2(bone.world.c, bone.world.a) * 180) / Math.PI;
}

/** +1 when a local rotation turns the bone clockwise on screen, -1 under a mirrored parent. */
function rotationSign(bone: Bone): number {
  const p = bone.parent?.world;
  return p && p.a * p.d - p.b * p.c < 0 ? -1 : 1;
}

function currentOffset(bone: Bone): number {
  return pending[bone.data.name] ?? bone.pose.rotation - bone.data.rotation;
}

/** The bone's translate offset from setup (unkeyed edit first, else the posed value). */
function currentMove(bone: Bone): { x: number; y: number } {
  return pendingMove[bone.data.name] ?? { x: bone.pose.x - bone.data.x, y: bone.pose.y - bone.data.y };
}

/** The bone's scale multiplier of setup (unkeyed edit first, else the posed value). */
function currentScale(bone: Bone): { x: number; y: number } {
  return pendingScale[bone.data.name] ?? { x: bone.pose.scaleX / (bone.data.scaleX || 1), y: bone.pose.scaleY / (bone.data.scaleY || 1) };
}

/** The bone's shear offset from setup in degrees (unkeyed edit first, else the posed value). */
function currentShear(bone: Bone): { x: number; y: number } {
  return pendingShear[bone.data.name] ?? { x: bone.pose.shearX - bone.data.shearX, y: bone.pose.shearY - bone.data.shearY };
}

const RING = HANDLE_PX.ring; // screen px
/** Scale / shear handle distance from the bone origin (screen px) and the grab radius. */
const HANDLE = 64;
const HANDLE_GRAB = 18;

/** Unit world directions of the bone's local x and y axes, and the handle points on them. */
function handleFrame(bone: Bone): HandleFrame {
  return gizmoFrame(bone, getSpace(), HANDLE / zoom());
}

/** Bone-size slider (view toolbar): scales the wedges drawn on the canvas. */
let boneSize = 1;
/** Wedges drawn in the last overlay pass (scripted checks read it). */
let lastWedges = 0;
let crumbKey = "";

/** standard bones: a tapered wedge from a round joint at the pivot to the tip, coloured by body part, constant size on screen. */
/** The root master control: crosshair + ring in its own colour at the ground point, always on top, with a small label. */
let rootText: Text | null = null;
function drawRootMaster(px: number): void {
  const root = skeleton?.findBone("root");
  if (!root) {
    if (rootText) rootText.visible = false;
    return;
  }
  const sel = selected === "root" || multi.has("root");
  const lab = rootLabel(setup.active(), clipKeysRoot(clip), sel);
  const color = lab.warn ? ROOT_WARN_COLOR : ROOT_COLOR;
  const x = root.world.x;
  const y = root.world.y;
  const r = (sel ? 11 : 9) * px;
  const dark = 0x14171d;
  overlay.circle(x, y, r + 2 * px).stroke({ width: 4 * px, color: dark, alpha: 0.8 });
  overlay.circle(x, y, r).stroke({ width: (sel ? 2.5 : 1.8) * px, color });
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    overlay.moveTo(x + dx * (r - 4 * px), y + dy * (r - 4 * px)).lineTo(x + dx * (r + 8 * px), y + dy * (r + 8 * px)).stroke({ width: 4 * px, color: dark, alpha: 0.8 });
    overlay.moveTo(x + dx * (r - 4 * px), y + dy * (r - 4 * px)).lineTo(x + dx * (r + 8 * px), y + dy * (r + 8 * px)).stroke({ width: 1.8 * px, color });
  }
  overlay.circle(x, y, 2.2 * px).fill({ color });
  if (!rootText) {
    rootText = new Text({ text: "", style: { fontFamily: "system-ui, sans-serif", fontSize: 12, fontWeight: "700", fill: 0xffffff } });
    rootText.eventMode = "none";
    world.addChild(rootText);
  }
  if (rootText.text !== lab.text) rootText.text = lab.text;
  rootText.style.fill = color;
  rootText.visible = true;
  rootText.scale.set(px);
  rootText.position.set(x + (r + 12 * px), y + 4 * px);
  world.setChildIndex(rootText, world.children.length - 1);
}

function drawBones(px: number, hideHelpers = false): void {
  drawBonesInner(px, hideHelpers);
  drawRootMaster(px);
}

function drawBonesInner(px: number, hideHelpers = false): void {
  if (!skeleton) return;
  const inSetup = setup.active();
  const hidden = inSetup ? outlinerHiddenBones() : overlayHiddenNow();
  const time0 = frameTime(clip, timeToFrame(clip, time));
  const live = new Set(inSetup ? [] : liveIkTargets().map((t) => t.data.name));
  const ikBones = new Set<string>();
  for (const c of skeleton.ikConstraints) if (c.pose.mix > 1e-6) for (const b of c.bones) ikBones.add(b.data.name);
  type Item = { bone: Bone; name: string; rank: number };
  const items: Item[] = [];
  for (const bone of skeleton.bones) {
    const name = bone.data.name;
    if (name === "root" || hidden.has(name) || live.has(name) || (hideHelpers && (bone.data.helper === true || helperSet.has(name)))) continue;
    const sel = inSetup ? name === selected : multi.has(name);
    const kid = !sel && !!bone.parent && (inSetup ? bone.parent.data.name === selected : multi.has(bone.parent.data.name));
    items.push({ bone, name, rank: name === hoverBone ? 4 : name === selected ? 3 : sel ? 2 : kid ? 1 : 0 });
  }
  const selNames = inSetup ? (selected ? [selected] : []) : [...multi];
  const ev: BoneView = boneView === "chain" && !selNames.length ? "dim" : boneView;
  const chain = ev === "chain" ? chainBones((n) => skeleton!.findBone(n)?.parent?.data.name ?? null, items.map((i) => i.name), selNames) : null;
  const shown = items.filter((i) => !!boneWeight(ev, i.rank, chain ? chain.has(i.name) : true));
  items.length = 0;
  items.push(...shown);
  items.sort((a, b) => a.rank - b.rank);
  lastWedges = items.length;
  const dark = 0x14171d;
  for (const { bone, name, rank } of items) {
    const { ox, oy, tx, ty } = boneEnds(bone);
    const sel = inSetup ? name === selected : multi.has(name);
    const hover = rank === 4;
    const kid = rank === 1;
    const color = boneColor(name, helperSet.has(name), (bone.data as { color?: string }).color);
    const fill = sel || hover ? brighten(color, hover && !sel ? 0.35 : 0.3) : kid ? brighten(color, 0.1) : color;
    const weight = boneWeight(ev, rank, true) ?? { alpha: 0.55, line: 1 };
    const alpha = sel ? 1 : hover ? 0.95 : weight.alpha;
    const lw = sel || hover ? 1 : weight.line;
    const lenPx = Math.hypot(tx - ox, ty - oy) / px;
    if (lenPx < TINY_BONE_PX) {
      const r = 5.5 * boneSize * outlinerIconScale(name) * px;
      if (sel || hover) overlay.circle(ox, oy, r + 2.5 * px).stroke({ width: 2 * px, color: 0xffffff, alpha: 0.9 });
      overlay.circle(ox, oy, r).fill({ color: fill, alpha }).stroke({ width: 1.2 * px * lw, color: dark, alpha: 0.9 * Math.min(1, alpha + 0.3) });
      overlay.moveTo(ox - r * 1.6, oy).lineTo(ox + r * 1.6, oy).moveTo(ox, oy - r * 1.6).lineTo(ox, oy + r * 1.6).stroke({ width: 1.2 * px, color: dark, alpha: 0.8 });
    } else {
      const w = wedgeWidth(lenPx, boneSize * outlinerIconScale(name)) * px;
      const pts = wedgePolygon(ox, oy, tx, ty, w);
      if (sel) overlay.poly(pts).stroke({ width: 7 * px, color: 0xffffff, alpha: 0.92, join: "round" });
      else if (hover) overlay.poly(pts).stroke({ width: 4 * px, color: 0xffffff, alpha: 0.6, join: "round" });
      overlay.poly(pts).fill({ color: fill, alpha }).stroke({ width: 1.2 * px * lw, color: dark, alpha: sel ? 1 : 0.85 * Math.min(1, alpha + 0.3), join: "round" });
      const jr = Math.max(3.2 * px, w * 0.34);
      overlay.circle(ox, oy, jr).fill({ color: brighten(color, sel ? 0.55 : 0.3), alpha: Math.min(1, alpha + 0.25) }).stroke({ width: 1.2 * px * lw, color: dark, alpha: 0.9 * Math.min(1, alpha + 0.3) });
      if (ikBones.has(name) && (alpha >= 0.5 || sel)) {
        // IK badge: a small pink "IK" tag beside the middle of the bone.
        const mx = (ox + tx) / 2;
        const my = (oy + ty) / 2;
        const nx = -(ty - oy) / (lenPx * px);
        const ny = (tx - ox) / (lenPx * px);
        const s2 = 4.5 * px;
        const bx = mx + nx * (w / 2 + 7 * px);
        const by = my + ny * (w / 2 + 7 * px);
        overlay.roundRect(bx - s2 * 1.5, by - s2, s2 * 3, s2 * 2, s2 * 0.6).fill({ color: 0xf06fb4 }).stroke({ width: px, color: dark });
        overlay.moveTo(bx - s2 * 0.8, by - s2 * 0.5).lineTo(bx - s2 * 0.8, by + s2 * 0.5).stroke({ width: 1.1 * px, color: dark });
        overlay.moveTo(bx + s2 * 0.1, by - s2 * 0.5).lineTo(bx + s2 * 0.1, by + s2 * 0.5).moveTo(bx + s2 * 0.9, by - s2 * 0.5).lineTo(bx + s2 * 0.1, by).lineTo(bx + s2 * 0.9, by + s2 * 0.5).stroke({ width: 1.1 * px, color: dark });
      }
    }
    // Key indicator: one dot per channel type that has a key at this frame.
    const types = alpha >= 0.5 || sel ? boneKeyTypesAt(clip, name, time0) : [];
    const offs = keyDotOffsets(types.length);
    types.forEach((t, i) => {
      overlay.circle(ox + offs[i]!.dx * px, oy + offs[i]!.dy * px, HANDLE_PX.keyDot * px).fill({ color: keyColorHex(t) }).stroke({ width: 1.2 * px, color: dark });
    });
  }
  // IK target handles: a pink diamond on every live target, easy to grab.
  for (const t of inSetup ? [] : liveIkTargets()) {
    const hot = (drag?.kind === "move" && drag.bone === t.data.name) || hoverBone === t.data.name || multi.has(t.data.name);
    const h = HANDLE_PX.ikHalf * 1.35 * px;
    const { x, y } = t.world;
    overlay.poly([x, y - h, x + h, y, x, y + h, x - h, y]).fill({ color: hot ? 0xffc65a : 0xff7ac8, alpha: 0.95 }).stroke({ width: 2 * px, color: dark, join: "round" });
    const o = h + 4 * px;
    overlay.poly([x, y - o, x + o, y, x, y + o, x - o, y]).stroke({ width: 1.5 * px, color: hot ? 0xffffff : 0xff7ac8, alpha: 0.75, join: "round" });
  }
}

/** The breadcrumb of the selected bone's parent chain (each crumb selects that bone) and its live values. */
function updateCrumb(): void {
  const box = document.getElementById("bonecrumb");
  if (!box) return;
  const bone = selected && skeleton ? skeleton.findBone(selected) : undefined;
  if (!bone || !skeleton) {
    box.style.display = "none";
    crumbKey = "";
    return;
  }
  box.style.display = "flex";
  const chain = crumbChain((n) => skeleton?.findBone(n)?.parent?.data.name ?? null, bone.data.name);
  const key = chain.join(">");
  if (key !== crumbKey) {
    crumbKey = key;
    box.replaceChildren();
    const shown = chain.length > 3 ? chain.slice(-3) : chain;
    if (shown.length < chain.length) {
      // "..." is a menu of the hidden parents: it selects the nearest one, and its tip lists them all.
      const hidden = chain.slice(0, chain.length - shown.length);
      const more = el("button", { className: "crumb more", textContent: "…", title: `Earlier parents: ${hidden.join(" > ")}. Click to select ${hidden[hidden.length - 1]}` });
      more.addEventListener("click", () => select(hidden[hidden.length - 1]!));
      box.append(more);
    }
    shown.forEach((n, i) => {
      if (i || shown.length < chain.length) box.append(el("span", { className: "sep", textContent: "\u203a" }));
      const b = el("button", { className: i === shown.length - 1 ? "crumb on" : "crumb", textContent: n, title: `Select ${n}` });
      b.addEventListener("click", () => select(n));
      box.append(b);
    });
    const vs = el("span", { className: "vals" });
    vs.id = "bonevals";
    box.append(vs);
  }
  const mv = currentMove(bone);
  const vals = document.getElementById("bonevals");
  if (vals) vals.textContent = `rot ${currentOffset(bone).toFixed(1)}\u00b0   x ${mv.x.toFixed(1)}  y ${mv.y.toFixed(1)}`;
}

function drawOverlay(): void {
  syncUnkeyed();
  requestRender();
  updateCrumb();
  overlay.clear();
  if (!skeleton || !(zoom() > 0.01)) return;
  // The mirrored preview is look-only: the bone overlay is drawn for the authored facing, so it is hidden.
  if (facingRight) return;
  if (setup.active()) {
    if (showBones) setup.drawOverlay(overlay, 1 / zoom());
    return;
  }
  setup.drawPolygons(overlay, 1 / zoom());
  drawArc();
  tweenPanel.drawOverlay(overlay, 1 / zoom());
  activeCanvasTool()?.drawOverlay?.(overlay, 1 / zoom(), getHost()!);
  const px = 1 / zoom();
  if (drag?.kind === "box" && drag.moved) {
    const b = normalBox(drag);
    overlay.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0).fill({ color: 0x5fb3ff, alpha: 0.12 }).stroke({ width: 1.5 * px, color: 0x5fb3ff, alpha: 0.9 });
  }
  if (!showBones) return;
  drawBones(px);
  // Unkeyed edits: an orange dashed-look ring on each bone's pivot, so a moved bone says it will snap back.
  for (const n of unkeyedNow()) {
    const b = skeleton.findBone(n);
    if (!b) continue;
    overlay.circle(b.world.x, b.world.y, 11 * px).stroke({ width: 2.5 * px, color: 0xffc65c, alpha: 0.95 });
    overlay.circle(b.world.x, b.world.y, 15 * px).stroke({ width: 1 * px, color: 0xffc65c, alpha: 0.45 });
  }
  const bone = selected ? skeleton.findBone(selected) : undefined;
  if (!bone) return;
  if (gizmoMode === "ik") {
    for (const side of ["l", "r"] as const) {
      const h = skeleton.findBone(sn("hand", side));
      if (!h) continue;
      const hot = lastIkSide === side;
      overlay.circle(h.world.x, h.world.y, 20 * px).stroke({ width: 3.5 * px, color: hot ? 0xf0b84a : 0x6bd68f });
      overlay.circle(h.world.x, h.world.y, 4 * px).fill({ color: hot ? 0xf0b84a : 0x6bd68f });
    }
    if (grip.on) {
      const g = gripPoint(skeleton, lastIkSide, grip.along, grip.across);
      if (g) {
        overlay.moveTo(g[0] - 9 * px, g[1]).lineTo(g[0] + 9 * px, g[1]).stroke({ width: 2 * px, color: 0xff7a7a });
        overlay.moveTo(g[0], g[1] - 9 * px).lineTo(g[0], g[1] + 9 * px).stroke({ width: 2 * px, color: 0xff7a7a });
        const h = skeleton.findBone(sn("hand", lastIkSide))!;
        overlay.moveTo(h.world.x, h.world.y).lineTo(g[0], g[1]).stroke({ width: 1.5 * px, color: 0xff7a7a, alpha: 0.6 });
      }
    }
    return;
  }
  if (gizmoMode === "scale" || gizmoMode === "shear") {
    drawHandles(overlay, gizmoMode, handleFrame(bone), px, drag?.kind === "scale" || drag?.kind === "shear" ? drag.axis : null);
    return;
  }
  if (gizmoMode === "move") {
    const { ox, oy } = boneEnds(bone);
    drawMoveGizmo(overlay, bone, { x: ox, y: oy }, getSpace(), px, drag?.kind === "move" ? drag.arm : null);
    return;
  }
  const r = RING * px;
  const { ox, oy } = boneEnds(bone);
  overlay.circle(ox, oy, r).stroke({ width: 3 * px, color: 0xf0b84a, alpha: 0.55 });
  drawRotateRef(overlay, bone, { x: ox, y: oy }, getSpace(), r, px);
  const limits = bone.data.limits;
  const now = worldAngle(bone);
  const sign = rotationSign(bone);
  const off = currentOffset(bone);
  const at = (o: number) => ((now + sign * (o - off)) * Math.PI) / 180;
  if (limits) {
    const a0 = at(limits.min);
    const a1 = at(limits.max);
    const start = Math.min(a0, a1);
    const end = Math.max(a0, a1);
    overlay.moveTo(ox + Math.cos(start) * r, oy + Math.sin(start) * r).arc(ox, oy, r, start, end).stroke({ width: 5 * px, color: 0x5fb3ff, alpha: 0.55 });
    for (const [bound, a] of [["min", a0], ["max", a1]] as const) {
      const hit = limitHit?.bone === bone.data.name && limitHit.bound === bound;
      overlay.moveTo(ox + Math.cos(a) * r * 0.82, oy + Math.sin(a) * r * 0.82).lineTo(ox + Math.cos(a) * r * 1.18, oy + Math.sin(a) * r * 1.18).stroke({ width: (hit ? 4 : 2) * px, color: hit ? 0xff6b6b : 0x5fb3ff });
    }
    const z = at(0);
    overlay.circle(ox + Math.cos(z) * r, oy + Math.sin(z) * r, 3 * px).fill({ color: 0x8c96a8 });
  }
  if (drag?.kind === "rotate" && drag.bone === bone.data.name && drag.armed) {
    // Pose assist guides: where the drag began, the 15 degree steps while Shift snaps, the previous key and mirror angles while Ctrl is down.
    const s = at(drag.start);
    overlay.moveTo(ox + Math.cos(s) * r * 0.9, oy + Math.sin(s) * r * 0.9).lineTo(ox + Math.cos(s) * r * 1.12, oy + Math.sin(s) * r * 1.12).stroke({ width: 2 * px, color: 0x8c96a8, alpha: 0.7 });
    if (assistState?.bone === bone.data.name) {
      if (assistState.snap === "step") {
        for (let o = -180; o < 180; o += 15) {
          const t = at(o);
          const hit = Math.abs(o - assistState.value) < 1e-6;
          overlay.moveTo(ox + Math.cos(t) * r * (hit ? 0.88 : 0.95), oy + Math.sin(t) * r * (hit ? 0.88 : 0.95)).lineTo(ox + Math.cos(t) * r * (hit ? 1.14 : 1.05), oy + Math.sin(t) * r * (hit ? 1.14 : 1.05)).stroke({ width: (hit ? 3 : 1.5) * px, color: 0xf0b84a, alpha: hit ? 1 : 0.4 });
        }
      }
      for (const g of assistState.guides) {
        const t = at(g.value);
        const hit = assistState.snap === g.kind;
        const color = g.kind === "key" ? 0x6bd68f : 0x5fb3ff;
        overlay.moveTo(ox, oy).lineTo(ox + Math.cos(t) * r * 1.22, oy + Math.sin(t) * r * 1.22).stroke({ width: (hit ? 3 : 1.5) * px, color, alpha: hit ? 0.95 : 0.4 });
        overlay.circle(ox + Math.cos(t) * r * 1.22, oy + Math.sin(t) * r * 1.22, (hit ? 5 : 3) * px).fill({ color, alpha: hit ? 1 : 0.55 });
      }
    }
  }
  const a = (now * Math.PI) / 180;
  const hot = limitHit?.bone === bone.data.name ? 0xff6b6b : 0xf0b84a;
  overlay.moveTo(ox, oy).lineTo(ox + Math.cos(a) * r, oy + Math.sin(a) * r).stroke({ width: 3 * px, color: hot });
  overlay.circle(ox + Math.cos(a) * r, oy + Math.sin(a) * r, 7 * px).fill({ color: hot }).stroke({ width: 2 * px, color: 0x14171d });
}

// ---------------------------------------------------------------------------------------------
// Arc overlay: the path of a bone or point across the clip, one dot per frame
// ---------------------------------------------------------------------------------------------

let arcSpec: string | null = null;
let arcCache: { clip: ClipData; rig: Rig | null; spec: string; a: number; b: number; points: ArcPoint[]; stats: ArcStats } | null = null;

/** The world position of an arc target on the skeleton as currently posed, or null when it does not exist. */
function worldOfTarget(spec: string): { x: number; y: number } | null {
  const t = parseArcTarget(spec);
  if (!t || !skeleton) return null;
  if (t.kind === "point") {
    const slot = skeleton.findSlot(t.slot);
    if (!slot) return null;
    let att = slot.attachment?.type === "point" ? slot.attachment : undefined;
    if (!att) {
      for (const skin of Object.values(rig?.doc.skins ?? {})) {
        const found = Object.keys(skin.attachments[t.slot] ?? {}).map((n) => skeleton!.getAttachment(slot, n)).find((a) => a?.type === "point");
        if (found?.type === "point") att = found;
      }
    }
    if (!att) return null;
    const p = slot.bone.localToWorld(att.x, att.y, { x: 0, y: 0 });
    return { x: p.x, y: p.y };
  }
  const bone = skeleton.findBone(t.name);
  if (!bone) return null;
  if (t.kind === "bone") return { x: bone.world.x, y: bone.world.y };
  const e = boneEnds(bone);
  return { x: e.tx, y: e.ty };
}

/** The frames the arc covers: the play range, else the whole clip (a loop without its repeated end frame). */
function arcFrames(): { a: number; b: number } {
  const n = frameCount(clip);
  return playRange ? { a: playRange.a, b: playRange.b } : { a: 0, b: clip.loop ? Math.max(0, n - 1) : n };
}

function currentArc(): NonNullable<typeof arcCache> | null {
  if (!arcSpec || !skeleton) return null;
  const { a, b } = arcFrames();
  if (arcCache && arcCache.clip === clip && arcCache.rig === rig && arcCache.spec === arcSpec && arcCache.a === a && arcCache.b === b) return arcCache;
  const points: ArcPoint[] = [];
  for (let f = a; f <= b; f++) {
    applyPoseAt(Math.min(clip.duration, frameTime(clip, f)), false);
    const p = worldOfTarget(arcSpec);
    if (p) points.push({ frame: f, ...p });
  }
  applyPoseAt(displayTime(), true);
  arcCache = { clip, rig, spec: arcSpec, a, b, points, stats: arcStats(points) };
  return arcCache;
}

function drawArc(): void {
  const arc = currentArc();
  if (!arc || arc.points.length < 2) return;
  const px = 1 / zoom();
  const pts = arc.points;
  overlay.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) overlay.lineTo(pts[i]!.x, pts[i]!.y);
  overlay.stroke({ width: 2 * px, color: 0xffd34a, alpha: 0.75 });
  const shown = timeToFrame(clip, displayTime());
  pts.forEach((p, i) => {
    const ratio = arc.stats.ratios[Math.min(i, arc.stats.ratios.length - 1)] ?? 1;
    overlay.circle(p.x, p.y, (p.frame % 5 === 0 ? 5 : 3.6) * px).fill({ color: stepColor(ratio), alpha: 0.95 }).stroke({ width: px, color: 0x14171d, alpha: 0.8 });
    if (p.frame === shown) overlay.circle(p.x, p.y, 10 * px).stroke({ width: 2.5 * px, color: 0xffffff });
  });
  // Direction of travel at the last sample.
  const t = arcTangent(pts, pts.length - 1);
  const last = pts[pts.length - 1]!;
  if (t) {
    overlay
      .moveTo(last.x + t.x * 12 * px - t.y * 7 * px, last.y + t.y * 12 * px + t.x * 7 * px)
      .lineTo(last.x + t.x * 22 * px, last.y + t.y * 22 * px)
      .lineTo(last.x + t.x * 12 * px + t.y * 7 * px, last.y + t.y * 12 * px - t.x * 7 * px)
      .stroke({ width: 2 * px, color: 0xffd34a });
  }
}

function setArc(spec: string | null): void {
  arcSpec = spec && parseArcTarget(spec) ? spec : null;
  arcCache = null;
  renderArcPanel();
  markPose();
}

/** What the arc panel offers: both fists, the weapon tip (when the rig has point slots), then every bone origin. */
function arcChoices(): { spec: string; label: string }[] {
  const out: { spec: string; label: string }[] = [];
  if (!rig) return out;
  for (const side of ["l", "r"] as const) if (skeleton?.findBone(sn("hand", side))) out.push({ spec: `tip:${sn("hand", side)}`, label: `Fist ${side === "l" ? "near / L" : "far / R"} (${sn("hand", side)} tip)` });
  for (const slot of rig.doc.slots) {
    const atts = Object.values(rig.doc.skins).flatMap((sk) => Object.values(sk.attachments[slot.name] ?? {}));
    if (atts.length && atts.every((a) => a.type === "point")) out.push({ spec: `point:${slot.name}`, label: `Point ${slot.name}` });
  }
  for (const b of rig.doc.bones) if (b.name !== "root") out.push({ spec: `bone:${b.name}`, label: `Bone ${b.name}` });
  return out;
}

function arcInfo(): { spec: string | null; frames: number[]; points: ArcPoint[]; stats: ArcStats | null } {
  const arc = currentArc();
  return { spec: arcSpec, frames: arc ? arc.points.map((p) => p.frame) : [], points: arc?.points ?? [], stats: arc?.stats ?? null };
}

function renderArcPanel(): void {
  const box = $("arcpanel");
  box.replaceChildren();
  if (!rig) return;
  const pick = el("select", {});
  pick.append(el("option", { value: "", textContent: "(off)" }));
  for (const c of arcChoices()) pick.append(el("option", { value: c.spec, textContent: c.label, selected: c.spec === arcSpec }));
  pick.addEventListener("change", () => setArc(pick.value || null));
  box.append(el("h2", { textContent: "Arc overlay" }), el("div", { className: "kv" }, el("span", { className: "label", textContent: "Track" }), el("span", { className: "v" }, pick)));
  const arc = currentArc();
  if (!arc || !arc.points.length) {
    box.append(el("div", { className: "note", textContent: "Pick a fist, the weapon tip or a bone to draw its path with one dot per frame." }));
    return;
  }
  const st = arc.stats;
  const spacing = st.uneven.length ? `frames ${st.uneven.slice(0, 12).join(", ")}${st.uneven.length > 12 ? "..." : ""}` : "even";
  box.append(
    el(
      "div",
      { className: "kv", style: "margin-top: 6px" },
      el("span", { className: "label", textContent: "Frames" }),
      el("span", { className: "v", textContent: `${arc.a}-${arc.b} (${st.frames} dots)` }),
      el("span", { className: "label", textContent: "Length" }),
      el("span", { className: "v", textContent: `${st.length.toFixed(0)} px, chord ${st.chord.toFixed(0)} px` }),
      el("span", { className: "label", textContent: "Curve" }),
      el("span", { className: "v", textContent: st.bulge < 0.06 ? `bulge ${(st.bulge * 100).toFixed(0)}% (almost straight)` : `bulge ${(st.bulge * 100).toFixed(0)}% of the chord` }),
      el("span", { className: "label", textContent: "Spacing" }),
      el("span", { className: "v", textContent: `${spacing}; peak ${st.peakRatio.toFixed(1)}x the median` })
    ),
    el("div", { className: "note", textContent: "Dots: blue = slow or held, grey = even, red = fast. White ring = shown frame." })
  );
}

// ---------------------------------------------------------------------------------------------
// Viewport input: select, rotate, pan, zoom
// ---------------------------------------------------------------------------------------------

let spaceDown = false;
let drag:
  | { kind: "pan"; x: number; y: number; wx: number; wy: number }
  | { kind: "rotate"; bone: string; last: number; accum: number; start: number; sign: number; bases: Record<string, number>; armed: boolean; sx: number; sy: number; empty?: boolean; ref: { prevKey: number | null; mirror: number | null } }
  | { kind: "move"; bone: string; gx: number; gy: number; starts: Record<string, { x: number; y: number }>; from: { x: number; y: number }; arm: Arm | null; armed: boolean; sx: number; sy: number; empty?: boolean; ikRot?: { pivot: { x: number; y: number }; last: number; accum: number } }
  | { kind: "scale"; bone: string; axis: "x" | "y" | "xy"; start: { x: number; y: number }; d0: { x: number; y: number }; r0: number }
  | { kind: "shear"; bone: string; axis: "x" | "y"; last: number; accum: number; start: number; sign: number }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; sx: number; sy: number; mode: SelectMode; moved: boolean }
  | { kind: "ik"; side: Side; gx: number; gy: number }
  | null = null;

/** Where the last canvas press landed (screen px): a rotate or move drag only starts after the pointer travels a few pixels, so a click never keys. */
let downScreen = { sx: 0, sy: 0 };
const DRAG_DEAD_ZONE = 4;

/** True once the pointer has left the dead zone (arms the drag). */
function armDrag(d: { armed: boolean; sx: number; sy: number }, p: { sx: number; sy: number }): boolean {
  if (!d.armed) {
    if (Math.hypot(p.sx - d.sx, p.sy - d.sy) < DRAG_DEAD_ZONE) return false;
    d.armed = true;
  }
  return true;
}

function toSkeleton(e: PointerEvent | WheelEvent): { x: number; y: number; sx: number; sy: number } {
  const rect = app.canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  return { x: (sx - world.x) / zoom(), y: (sy - world.y) / zoom(), sx, sy };
}

/** Helpers that do nothing right now (IK targets with the constraint off, weapon markers). */
function hiddenNow(): Set<string> {
  if (!skeleton) return new Set();
  return hiddenHelpers(helperSet, skeleton.ikConstraints.map((c) => ({ target: c.target.data.name, mix: c.pose.mix })));
}

/** Targets of IK constraints that are on right now (mix > 0): the bones the pink handles drag. */
function liveIkTargets(): Bone[] {
  return skeleton ? skeleton.ikConstraints.filter((c) => c.pose.mix > 1e-6).map((c) => c.target) : [];
}

/** Helpers to leave off the canvas: all of them unless "show helpers" is on, always the ones that do nothing now (live IK targets stay). */
function overlayHiddenNow(): Set<string> {
  const out = overlayHidden(helperSet, hiddenNow(), new Set(liveIkTargets().map((t) => t.data.name)), showHelpers);
  for (const n of outlinerHiddenBones()) out.add(n);
  return out;
}

/** The live IK target whose pink square is under a skeleton-space point. */
function ikTargetAt(x: number, y: number): Bone | null {
  const g = HANDLE_PX.ikGrab / zoom();
  let best: Bone | null = null;
  let bestD = g;
  for (const t of liveIkTargets()) {
    const d = Math.hypot(x - t.world.x, y - t.world.y);
    if (d <= bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** The IK target to drag instead of `name` when a live (mix > 0) constraint drives it: its chain bones and the bone hanging off the chain's end (the foot). */
function ikHandleFor(name: string): { target: string; ik: string; chain: boolean } | null {
  if (!skeleton) return null;
  for (const c of skeleton.ikConstraints) {
    if (c.pose.mix <= 1e-6) continue;
    const last = c.bones[c.bones.length - 1];
    const chain = c.bones.some((b) => b.data.name === name);
    if (chain || last?.children.some((b) => b.data.name === name && b.data.length > 0 && b.data.name !== c.target.data.name)) return { target: c.target.data.name, ik: c.data.name, chain };
  }
  return null;
}

/** What turning an IK-driven bone does, for the hover label and the status line (null when no live IK drives it). */
function ikHint(name: string): string | null {
  const h = ikHandleFor(name);
  if (!h) return null;
  return h.chain ? `IK ${h.ik}: turning ${name} swings the chain by moving its target ${h.target}` : `IK ${h.ik}: dragging ${name} moves the target ${h.target}`;
}

/**
 * Turning a bone of a live IK chain: the constraint's target swings about the bone's origin by the pointer's turn, so the solved chain follows
 * (a thigh swings the whole leg; a shin bends the knee with the hip fixed). Keyed through the target like a plain target drag.
 */
function startIkRotate(bone: string, target: string, x: number, y: number): void {
  const b = skeleton?.findBone(bone);
  if (!b) return;
  startMove(target, x, y);
  if (drag?.kind !== "move") return;
  const pivot = { x: b.world.x, y: b.world.y };
  drag.ikRot = { pivot, last: Math.atan2(y - pivot.y, x - pivot.x), accum: 0 };
}

/** Atlas page pixels (alpha) for art picking, read back once per page and dropped when the character is replaced. */
const pagePixels = new Map<object, { w: number; h: number; data: Uint8ClampedArray }>();

function pageAlpha(tex: { source: object }, u: number, v: number): number {
  let e = pagePixels.get(tex.source);
  if (!e) {
    try {
      const out = app.renderer.extract.pixels({ target: tex as never });
      e = { w: out.width, h: out.height, data: out.pixels };
    } catch {
      e = { w: 0, h: 0, data: new Uint8ClampedArray(0) };
    }
    pagePixels.set(tex.source, e);
  }
  if (!e.w) return 255;
  const x = Math.min(e.w - 1, Math.max(0, Math.floor(u * e.w)));
  const y = Math.min(e.h - 1, Math.max(0, Math.floor(v * e.h)));
  return e.data[(y * e.w + x) * 4 + 3] ?? 0;
}

/** The bone of the topmost slot whose art has a visible pixel under (x, y), or null. */
function artBone(x: number, y: number): string | null {
  if (!skeleton || !character || !imagesSelectable()) return null;
  const meshes = character.slotMeshes;
  const order = skeleton.drawOrder;
  const hidden = overlayHiddenNow();
  const pt = { x, y };
  for (let i = meshes.length - 1; i >= 0; i--) {
    const mesh = meshes[i]!;
    const slot = order[i];
    if (!slot || !mesh.visible || mesh.alpha < 0.05) continue;
    const name = slot.bone.data.name;
    if (name === "root" || hidden.has(name) || outlinerLocked(name)) continue;
    const l = mesh.toLocal(pt, world);
    const g = mesh.geometry;
    const P = g.positions;
    const U = g.uvs;
    const I = g.indices;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = I[t]!;
      const b = I[t + 1]!;
      const c = I[t + 2]!;
      const ax = P[a * 2]!;
      const ay = P[a * 2 + 1]!;
      const bx = P[b * 2]!;
      const by = P[b * 2 + 1]!;
      const cx = P[c * 2]!;
      const cy = P[c * 2 + 1]!;
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(den) < 1e-9) continue;
      const w0 = ((by - cy) * (l.x - cx) + (cx - bx) * (l.y - cy)) / den;
      const w1 = ((cy - ay) * (l.x - cx) + (ax - cx) * (l.y - cy)) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const u = U[a * 2]! * w0 + U[b * 2]! * w1 + U[c * 2]! * w2;
      const v = U[a * 2 + 1]! * w0 + U[b * 2 + 1]! * w1 + U[c * 2 + 1]! * w2;
      if (pageAlpha(mesh.texture as never, u, v) > 40) return name;
    }
  }
  return null;
}

function pickCandidates(): PickBone[] {
  if (!skeleton) return [];
  const hidden = overlayHiddenNow();
  const out: PickBone[] = [];
  for (const bone of skeleton.bones) {
    if (bone.data.name === "root") continue;
    const { ox, oy, tx, ty } = boneEnds(bone);
    out.push({ name: bone.data.name, ox, oy, tx, ty, helper: helperSet.has(bone.data.name), hidden: hidden.has(bone.data.name) || outlinerLocked(bone.data.name) || !boneSelectable(helperSet.has(bone.data.name)) });
  }
  return out;
}

/** The bone under a skeleton-space point: the closest, real bones before helpers, hidden helpers never. */
function pickBone(x: number, y: number): string | null {
  const rb = skeleton?.findBone("root");
  if (rb && showBones && hitsRootGlyph(x, y, rb.world.x, rb.world.y, zoom())) return "root";
  return pickBoneAt(pickCandidates(), x, y, HANDLE_PX.pick / zoom(), { selected });
}

/** Every bone under a point, best first, without the selected-bone bonus (Alt+click walks this list); art follows when no stick matched it. */
function pickStack(x: number, y: number): string[] {
  const out = rankBones(pickCandidates(), x, y, HANDLE_PX.pick / zoom());
  const art = artBone(x, y);
  if (art && !out.includes(art)) out.push(art);
  return out;
}

/**
 * The bone a plain click at a point would grab, in the order the press tries: the selected bone's gizmo (rotate ring, move arm, scale
 * or shear handle, hand IK ring), a live IK target, the nearest bone, then the art. Hover uses it too, so what lights up is what a click takes.
 */
function grabTargetAt(x: number, y: number, mapDriven = true): string | null {
  if (!skeleton || facingRight) return null;
  const sel = selected ? skeleton.findBone(selected) : undefined;
  // A press on a bone an IK constraint drives grabs the constraint's target (see the pointerdown handler), so the hover shows that target too.
  const driven = (name: string | null): string | null => (name && mapDriven && !setup.active() ? (ikHandleFor(name)?.target ?? name) : name);
  if (sel && !setup.active()) {
    if (gizmoMode === "rotate" && onRotateRing(Math.hypot(x - sel.world.x, y - sel.world.y), RING, zoom())) return driven(sel.data.name);
    if (gizmoMode === "move" && moveArmAt(sel.world, sel, getSpace(), zoom(), x, y)) return driven(sel.data.name);
    if ((gizmoMode === "scale" || gizmoMode === "shear") && scaleShearAxis(sel, x, y)) return sel.data.name;
  }
  if (gizmoMode === "ik" && !setup.active()) {
    const side = handUnder(x, y);
    return side ? sn("hand", side) : null;
  }
  return driven(ikTargetAt(x, y)?.data.name ?? pickBone(x, y) ?? artBone(x, y));
}

function pointerAngle(bone: Bone, x: number, y: number): number {
  return (Math.atan2(y - bone.world.y, x - bone.world.x) * 180) / Math.PI;
}

function startMove(name: string, x: number, y: number, arm: Arm | null = null): void {
  const bone = skeleton?.findBone(name);
  if (!bone || !skeleton) return;
  if (playing) setPlaying(false);
  applyPoseAt(displayTime(), true);
  const starts: Record<string, { x: number; y: number }> = {};
  for (const n of moveNames(name)) {
    const b = skeleton.findBone(n);
    if (b) starts[n] = { x: b.world.x, y: b.world.y };
  }
  assistReset();
  drag = { kind: "move", bone: name, gx: x - bone.world.x, gy: y - bone.world.y, starts, from: { ...currentMove(bone) }, arm, armed: false, ...downScreen };
}

/** The bones a move of `name` carries: the whole selection when `name` is in it, minus bones that already ride a selected ancestor. */
function moveNames(name: string): string[] {
  if (!(multi.has(name) && multi.size > 1)) return [name];
  const riders = withSelectedAncestor([...multi], (n) => skeleton?.findBone(n)?.parent?.data.name ?? null);
  return [...multi].filter((n) => !riders.has(n));
}

/** The bones a rotation of `name` turns: the whole selection when `name` is in it. */
function rotateNames(name: string): string[] {
  return multi.has(name) && multi.size > 1 ? [...multi] : [name];
}

/**
 * Runs `mutate` (which changes pending offsets of `names`) and, with Compensate on, puts the direct children of those bones
 * back where they were on screen by adjusting their offsets.
 */
function withCompensation(names: readonly string[], mutate: () => void): void {
  if (!compensate || !skeleton) return mutate();
  applyPoseAt(displayTime(), true);
  const anchors = anchorsFor(skeleton, names, new Set(multi.size > 1 ? [...multi, ...names] : names));
  mutate();
  if (!anchors.length) return;
  applyPoseAt(displayTime(), true);
  const r = (v: number) => Math.round(v * 100) / 100;
  for (const f of solveCompensation(skeleton, anchors)) {
    pending = { ...pending, [f.name]: r(f.rotate) };
    pendingMove = { ...pendingMove, [f.name]: { x: r(f.move.x), y: r(f.move.y) } };
  }
}

function handUnder(x: number, y: number): Side | null {
  if (!skeleton) return null;
  let best: Side | null = null;
  let bestD = 26 / zoom();
  for (const side of ["l", "r"] as const) {
    const h = skeleton.findBone(sn("hand", side));
    if (!h) continue;
    const { ox, oy, tx, ty } = boneEnds(h);
    const d = Math.min(Math.hypot(x - ox, y - oy), segmentDistance(x, y, ox, oy, tx, ty));
    if (d < bestD) {
      bestD = d;
      best = side;
    }
  }
  return best;
}

/** The IK constraint that drives a hand (target `hand_<side>_target`), when the rig has one. */
function handIk(side: Side): { ik: string; target: string } | null {
  const c = rig?.doc.ik.find((i) => i.target === `${sn("hand", side)}_target`);
  return c ? { ik: c.name, target: c.target } : null;
}

/** Live mode: switches the arm's IK on here (mix 1, target keyed where the hand stands) when it is not already, then drags the target. */
function startLiveIk(side: Side, x: number, y: number, c: { ik: string; target: string }): void {
  const target = skeleton?.findBone(c.target);
  const hand = skeleton?.findBone(sn("hand", side));
  if (!target || !hand) return;
  if (!ikLiveAt(clip, c.ik, keyTime()) || !clip.bones[c.target]?.translate?.length) {
    applyPoseAt(displayTime(), true);
    const local = { x: 0, y: 0 };
    target.worldToParent(hand.world.x, hand.world.y, local);
    clearPending();
    commit(keyHandIk(clip, c.ik, c.target, keyTime(), local.x - target.data.x, local.y - target.data.y), `Hand IK ${side.toUpperCase()} live: ${c.ik} mix 1 and ${c.target} keyed at frame ${timeToFrame(clip, time)}`);
  }
  select(c.target);
  startMove(c.target, x, y);
}

function startIk(side: Side, x: number, y: number): void {
  const hand = skeleton?.findBone(sn("hand", side));
  if (!hand) return;
  if (playing) setPlaying(false);
  lastIkSide = side;
  const live = ikLive ? handIk(side) : null;
  if (live) return startLiveIk(side, x, y, live);
  drag = { kind: "ik", side, gx: x - hand.world.x, gy: y - hand.world.y };
}

/** Solves the dragged arm (and the pinned second arm) so the hand origin reaches (x, y); the offsets stay unkeyed until release. */
function ikTo(side: Side, x: number, y: number): { reached: boolean; gripReached: boolean | null } | null {
  if (!skeleton) return null;
  lastIkSide = side;
  applyPoseAt(displayTime(), true);
  const r = solveHands(skeleton, side, [x, y], grip.on ? { along: grip.along, across: grip.across } : undefined);
  if (!r) return null;
  const rounded = Object.fromEntries(Object.entries(r.offsets).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  pending = { ...pending, ...rounded };
  lastIkNames = Object.keys(rounded);
  markPose();
  renderBones();
  return { reached: r.reached, gripReached: r.gripReached };
}

/** Keys the rotations of the last IK solve (both arms with a grip) in one undo step. */
function keyIk(): void {
  if (noClipKeys()) return;
  const names = lastIkNames.filter((n) => pending[n] !== undefined);
  if (!names.length) return;
  let next = clip;
  for (const n of names) next = setRotateKey(next, n, keyTime(), pending[n]!);
  const keyed = names.join(", ");
  for (const n of names) {
    const { [n]: _drop, ...rest } = pending;
    pending = rest;
  }
  lastIkNames = [];
  commit(next, `Keyed ${keyed} at frame ${timeToFrame(clip, time)}`);
}

/** Pins the other hand to the grip point of `side`'s hand without moving `side`'s hand. */
function snapGrip(side: Side = lastIkSide): void {
  if (!skeleton) return;
  applyPoseAt(displayTime(), true);
  const h = skeleton.findBone(sn("hand", side));
  if (!h) return;
  grip = { ...grip, on: true };
  ikTo(side, h.world.x, h.world.y);
  if (autoKey) keyIk();
}

function setIkLive(on: boolean): boolean {
  ikLive = on;
  renderIkPanel();
  status(on ? "Hand IK live: the arm stays IK-driven; the hand target is keyed" : "Hand IK bakes to FK rotate keys");
  return ikLive;
}

function renderIkPanel(): void {
  const box = $("ikpanel");
  box.replaceChildren();
  box.style.display = gizmoMode === "ik" ? "" : "none";
  if (gizmoMode !== "ik") return;
  const on = el("input", { type: "checkbox" });
  on.checked = grip.on;
  on.addEventListener("change", () => {
    grip = { ...grip, on: on.checked };
    drawOverlay();
  });
  const along = el("input", { type: "number", step: "5", value: String(grip.along) });
  const across = el("input", { type: "number", step: "5", value: String(grip.across) });
  const upd = () => {
    grip = { ...grip, along: Number(along.value) || 0, across: Number(across.value) || 0 };
    drawOverlay();
  };
  along.addEventListener("change", upd);
  across.addEventListener("change", upd);
  const snap = el("button", { textContent: "Pin other hand now", title: "Move the other hand onto the grip point of the hand you last dragged, and key it" });
  snap.addEventListener("click", () => snapGrip());
  const keyBtn = el("button", { textContent: "Key arms", title: "Key the unkeyed arm rotations" });
  keyBtn.addEventListener("click", keyIk);
  const live = el("input", { type: "checkbox" });
  live.id = "ikliveopt";
  live.checked = ikLive;
  live.addEventListener("change", () => setIkLive(live.checked));
  box.append(
    el("h2", { textContent: "Hand IK" }),
    el("div", { className: "label", textContent: ikLive ? "Live: dragging a fist moves the hand target bone; the IK constraint stays on (mix 1), so in-betweens follow the target keys." : "Drag a fist: the arm follows (never stretched, elbow keeps its side). Written as rotate keys." }),
    el("div", { className: "row" }, el("label", { className: "label", title: "Keep the arm IK constraint on (mix keyed to 1) and key the hand target bone instead of baking FK rotations (needs the rig's hand IK constraints)" }, live, " Keep IK live (key the hand target)")),
    el("div", { className: "row" }, el("label", { className: "label" }, on, " Two-hand grip: the other hand stays on the weapon")),
    el("div", { className: "kv", style: "margin-top: 6px" }, el("span", { className: "label", textContent: "Grip along" }), el("span", { className: "v" }, along, " px"), el("span", { className: "label", textContent: "Grip across" }), el("span", { className: "v" }, across, " px")),
    el("div", { className: "row" }, snap, keyBtn)
  );
}

/** Moves the bone's origin to the world point (x, y): the offset is taken in its parent's space. */
function dragMoveTo(name: string, x: number, y: number, starts: Record<string, { x: number; y: number }>, arm: Arm | null = null): void {
  const bone = skeleton?.findBone(name);
  const from = starts[name];
  if (!bone || !from) return;
  // Grabbed on a gizmo arm: the drag is held to that axis of the Local / Parent / World frame.
  const { dx, dy } = projectMove(bone, getSpace(), arm, x - from.x, y - from.y);
  const names = Object.keys(starts);
  withCompensation(names, () => {
    for (const n of names) {
      const b = skeleton?.findBone(n);
      const s = starts[n];
      if (!b || !s) continue;
      const local = { x: s.x + dx, y: s.y + dy };
      if (b.parent) b.parent.worldToLocal(local.x, local.y, local);
      applyMove(n, local.x - b.data.x, local.y - b.data.y);
    }
  });
  markPose();
}

function applyMove(name: string, x: number, y: number): void {
  const r = (v: number) => Math.round(v * 100) / 100;
  pendingMove = { ...pendingMove, [name]: { x: r(x), y: r(y) } };
  if (drag?.kind === "move" && drag.bone === name) showReadout(moveReadout(r(x), r(y), drag.from.x, drag.from.y, moveTyped));
  markPose();
  renderBones();
}

function keyMove(name: string): void {
  if (noClipKeys()) return;
  const m = pendingMove[name];
  if (!m) return;
  const { [name]: _drop, ...rest } = pendingMove;
  pendingMove = rest;
  commit(setVectorKey(clip, name, "translate", keyTime(), m.x, m.y), `Keyed ${name} translate (${m.x.toFixed(1)}, ${m.y.toFixed(1)}) at frame ${timeToFrame(clip, time)}`);
}

function applyScale(name: string, x: number, y: number): void {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  pendingScale = { ...pendingScale, [name]: { x: r(x), y: r(y) } };
  markPose();
  renderBones();
}

function keyScale(name: string): void {
  if (noClipKeys()) return;
  const m = pendingScale[name];
  if (!m) return;
  const { [name]: _drop, ...rest } = pendingScale;
  pendingScale = rest;
  commit(setVectorKey(clip, name, "scale", keyTime(), m.x, m.y), `Keyed ${name} scale (${m.x.toFixed(3)}, ${m.y.toFixed(3)}) at frame ${timeToFrame(clip, time)}`);
}

function applyShear(name: string, x: number, y: number): void {
  const r = (v: number) => Math.round(v * 100) / 100;
  pendingShear = { ...pendingShear, [name]: { x: r(x), y: r(y) } };
  markPose();
  renderBones();
}

function keyShear(name: string): void {
  if (noClipKeys()) return;
  const m = pendingShear[name];
  if (!m) return;
  const { [name]: _drop, ...rest } = pendingShear;
  pendingShear = rest;
  commit(setVectorKey(clip, name, "shear", keyTime(), m.x, m.y), `Keyed ${name} shear (${m.x.toFixed(2)}°, ${m.y.toFixed(2)}°) at frame ${timeToFrame(clip, time)}`);
}

/** Drops one channel's unkeyed edit of a bone. */
function dropPending(ch: Channel, name: string): void {
  if (ch === "rotate") {
    const { [name]: _drop, ...rest } = pending;
    pending = rest;
  } else if (ch === "translate") {
    const { [name]: _drop, ...rest } = pendingMove;
    pendingMove = rest;
  } else if (ch === "scale") {
    const { [name]: _drop, ...rest } = pendingScale;
    pendingScale = rest;
  } else {
    const { [name]: _drop, ...rest } = pendingShear;
    pendingShear = rest;
  }
}

/**
 * Sets one channel of a bone from stored values (rotate: degrees from setup in x; translate: offset from setup in the parent's space;
 * scale: multiplier; shear: degrees). The Pose panel fields and the transform strip both come here, so a translate carries the selection
 * and Compensate and Auto key behave the same from either. `live` (a scrub or wheel in progress) leaves Auto key to `autoKeyChannel`.
 */
function applyChannel(name: string, ch: Channel, x: number, y: number, live = false): void {
  const bone = skeleton?.findBone(name);
  if (!bone) return;
  if (ch === "rotate") {
    applyRotate(x, name);
    if (autoKey && !live) keyPending();
    limitHit = null;
  } else if (ch === "translate") {
    const cur = currentMove(bone);
    const group = moveNames(name).filter((n) => n !== name);
    withCompensation([name, ...group], () => {
      for (const n of group) {
        const gb = skeleton?.findBone(n);
        if (gb) applyMove(n, currentMove(gb).x + (x - cur.x), currentMove(gb).y + (y - cur.y));
      }
      applyMove(name, x, y);
    });
    if (autoKey && !live) keyPending();
  } else if (ch === "scale") {
    if (!(x > 0 && y > 0)) return;
    applyScale(name, x, y);
    if (autoKey && !live) keyScale(name);
  } else {
    applyShear(name, x, y);
    if (autoKey && !live) keyShear(name);
  }
}

/** Auto key after a live edit of one channel. */
function autoKeyChannel(name: string, ch: Channel): void {
  if (!autoKey) return;
  if (ch === "rotate" || ch === "translate") keyPending();
  else if (ch === "scale") keyScale(name);
  else keyShear(name);
}

/**
 * Keys only these channels of a bone at the playhead, with the value it shows now (an unkeyed edit or the posed value). With Compensate on,
 * the direct children whose offsets Compensate moved get their rotate / translate keyed in the same step.
 */
function keyChannels(name: string, chs: readonly Channel[]): void {
  if (noClipKeys()) return;
  const bone = skeleton?.findBone(name);
  if (!bone) return;
  const t = keyTime();
  let next = clip;
  const done: string[] = [];
  const put = (n: string, ch: Channel, b: Bone) => {
    if (ch === "rotate") next = setRotateKey(next, n, t, currentOffset(b));
    else {
      const v = ch === "translate" ? currentMove(b) : ch === "scale" ? currentScale(b) : currentShear(b);
      next = setVectorKey(next, n, ch, t, v.x, v.y);
    }
    dropPending(ch, n);
    done.push(`${n} ${ch}`);
  };
  for (const ch of chs) put(name, ch, bone);
  if (compensate && (chs.includes("rotate") || chs.includes("translate"))) {
    for (const kid of bone.children) {
      const n = kid.data.name;
      if (pending[n] !== undefined) put(n, "rotate", kid);
      if (pendingMove[n]) put(n, "translate", kid);
    }
  }
  commit(next, `Keyed ${done.length > 3 ? `${done.length} channels` : done.join(", ")} at frame ${timeToFrame(clip, time)}`);
}

/** The active bone's channels for the transform strip. */
function xformRead(): XformRead | null {
  if (setup.active() || !selected || !skeleton) return null;
  const bone = skeleton.findBone(selected);
  if (!bone) return null;
  const t = keyTime();
  const n = bone.data.name;
  const chs = ["rotate", "translate", "scale", "shear"] as const;
  return {
    bone: n,
    values: { rotate: currentOffset(bone), translate: currentMove(bone), scale: currentScale(bone), shear: currentShear(bone) },
    keyed: Object.fromEntries(chs.map((ch) => [ch, hasKey(clip, n, ch, t)])) as XformRead["keyed"],
    unkeyed: { rotate: pending[n] !== undefined, translate: !!pendingMove[n], scale: !!pendingScale[n], shear: !!pendingShear[n] }
  };
}

/** Editor-only layer visibility (the Bones / Images / Others grid): Bones and Others are the overlay's bones and helper bones, Images the character. */
function setLayerVisible(layer: Layer, on: boolean): void {
  if (layer === "bones") {
    setBoneView(on ? lastBoneView : "off");
    return;
  } else if (layer === "others") {
    showHelpers = on;
    $("helpersvis").classList.toggle("on", on);
  } else if (character) character.visible = on;
  drawOverlay();
  renderBones();
}

/** The scale / shear handle of `bone` under a point (the centre grabs both axes in Scale), or null. */
function scaleShearAxis(bone: Bone, x: number, y: number): "x" | "y" | "xy" | null {
  return handleAt(handleFrame(bone), gizmoMode === "shear" ? "shear" : "scale", x, y, HANDLE_GRAB / zoom());
}

/** Starts a scale or shear drag when the pointer is on a handle of the selected bone; true when it grabbed one. */
function startScaleShear(x: number, y: number): boolean {
  const bone = selected ? skeleton?.findBone(selected) : undefined;
  if (!bone) return false;
  const f = handleFrame(bone);
  const axis = scaleShearAxis(bone, x, y);
  if (!axis) return false;
  if (playing) setPlaying(false);
  if (gizmoMode === "scale") {
    const st = scaleStart(f, x, y);
    drag = { kind: "scale", bone: bone.data.name, axis, start: { ...currentScale(bone) }, d0: st.d0, r0: st.r0 };
  } else if (axis !== "xy") {
    const cur = currentShear(bone);
    drag = { kind: "shear", bone: bone.data.name, axis, last: pointerAngle(bone, x, y), accum: 0, start: axis === "x" ? cur.x : cur.y, sign: rotationSign(bone) };
  } else return false;
  drawOverlay();
  return true;
}

function startRotate(name: string, x: number, y: number): void {
  const bone = skeleton?.findBone(name);
  if (!bone) return;
  if (playing) setPlaying(false);
  const bases: Record<string, number> = {};
  for (const n of rotateNames(name)) {
    const b = skeleton?.findBone(n);
    if (b) bases[n] = currentOffset(b);
  }
  assistReset();
  drag = { kind: "rotate", bone: name, last: pointerAngle(bone, x, y), accum: 0, start: currentOffset(bone), sign: rotationSign(bone), bases, armed: false, ref: assistRefs(name), ...downScreen };
}

// ---------------------------------------------------------------------------------------------
// Smart pose assist (poseAssist.ts): snaps, guides, the readout and typed numbers during a rotate or move drag
// ---------------------------------------------------------------------------------------------

/** The snap in force and its guides for the rotate drag in progress (the overlay draws them); null otherwise. */
let assistState: (AssistResult & { bone: string }) | null = null;
/** The number being typed during a rotate drag (null = not typing) and during a move drag. */
let typedBuf: string | null = null;
let moveTyped: { x: string; y: string; field: "x" | "y" } | null = null;
/** Ends the drag in progress as a mouse release would (set by the viewport wiring; Enter after typing a number uses it). */
let endDragNow: (() => void) | null = null;

function assistReset(): void {
  assistState = null;
  typedBuf = null;
  moveTyped = null;
}

/** What Ctrl snaps a rotation to: the bone's rotation at its previous key, and the mirror partner's angle seen from this bone. */
function assistRefs(name: string): { prevKey: number | null; mirror: number | null } {
  let prevKey: number | null = null;
  const t = keyTime();
  for (const k of clip.bones[name]?.rotate ?? []) if (k.time < t - 1e-6) prevKey = k.value;
  let mirror: number | null = null;
  const mrig = mirrorRig();
  const partner = mrig?.partner.get(name);
  if (mrig && partner && skeleton?.findBone(partner)) {
    try {
      mirror = Math.round(mirrorOffsets(mrig, { from: partner, to: name }, mirrorRead(partner)).rotate * 100) / 100;
    } catch {
      mirror = null;
    }
  }
  return { prevKey, mirror };
}

/** A key pressed during an armed rotate or move drag: a number key types an exact value, Enter sets it and ends the drag. True when it was used. */
function assistKey(e: KeyboardEvent): boolean {
  if (!drag || (drag.kind !== "rotate" && drag.kind !== "move") || !drag.armed || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === "Enter") {
    if (!endDragNow) return false;
    e.preventDefault();
    const typed = typedBuf !== null || !!moveTyped;
    endDragNow();
    status(typed ? "Set the typed value" : "Drag set");
    return true;
  }
  if (drag.kind === "rotate") {
    const next = typeKey(typedBuf ?? "", e.key);
    if (next === null || (typedBuf === null && e.key === "Backspace")) return false;
    typedBuf = next;
    applyTyped();
    return true;
  }
  if (e.key === "Tab") {
    moveTyped = { x: moveTyped?.x ?? "", y: moveTyped?.y ?? "", field: moveTyped?.field === "x" ? "y" : "x" };
    applyTyped();
    return true;
  }
  const cur = moveTyped ?? { x: "", y: "", field: "x" as const };
  const next = typeKey(cur[cur.field], e.key);
  if (next === null || (!moveTyped && e.key === "Backspace")) return false;
  moveTyped = { ...cur, [cur.field]: next };
  applyTyped();
  return true;
}

/** Writes the typed number onto the dragged bone, with the limit flash and the readout as for a mouse drag. */
function applyTyped(): void {
  if (!drag) return;
  if (drag.kind === "rotate") {
    const v = typedBuf === null ? null : typedValue(typedBuf);
    if (v === null) {
      showReadout(rotateReadout(drag.start, drag.start, null, typedBuf));
      return;
    }
    applyRotate(v, drag.bone, drag.bases, {});
  } else if (drag.kind === "move" && moveTyped) {
    const bone = skeleton?.findBone(drag.bone);
    if (!bone) return;
    const cur = currentMove(bone);
    const x = typedValue(moveTyped.x) ?? cur.x;
    const y = typedValue(moveTyped.y) ?? cur.y;
    applyMove(drag.bone, x, y);
  }
  drawOverlay();
}

/** Clamps one bone's rotation offset to its range on a loop (a one-shot clip may pass it, with a warning) and records it unkeyed. */
function setRotatePending(name: string, raw: number, primary: boolean): void {
  const bone = skeleton?.findBone(name);
  if (!bone) return;
  const limits = bone.data.limits;
  let value = raw;
  let hit: typeof limitHit = null;
  const blocking = clip.loop;
  if (limits && raw < limits.min) {
    if (blocking) value = limits.min;
    hit = { bone: name, bound: "min", value: limits.min };
  } else if (limits && raw > limits.max) {
    if (blocking) value = limits.max;
    hit = { bone: name, bound: "max", value: limits.max };
  }
  pending = { ...pending, [name]: Math.round(value * 100) / 100 };
  if (!primary) return;
  limitHit = hit;
  const flash = $("limitflash");
  if (hit) {
    flash.textContent = blocking
      ? `${name} at its ${hit.bound} limit ${hit.value}° (range ${limits!.min}..${limits!.max}°)`
      : `${name} ${Math.round(value)}° is past its ${hit.bound} limit ${hit.value}° (warning only on a non-loop clip)`;
    flash.style.display = "block";
  } else flash.style.display = "none";
}

/**
 * Sets the rotation offset of `name` to `raw` (degrees from setup). With a multi-selection the other bones turn by the
 * same amount on screen (`bases` are their offsets when the gesture began; taken now when omitted). Shift in `mods` snaps to 15 degrees,
 * Ctrl to the previous key's angle or the mirror bone's (poseAssist.ts).
 */
function applyRotate(raw: number, name: string, bases?: Record<string, number>, mods: { shift?: boolean; ctrl?: boolean } = {}): void {
  const bone = skeleton?.findBone(name);
  if (!bone || !skeleton) return;
  const ref = drag?.kind === "rotate" ? drag.ref : { prevKey: null, mirror: null };
  const assist = assistRotation({ raw, shift: !!mods.shift, ctrl: !!mods.ctrl, prevKey: ref.prevKey, mirror: ref.mirror });
  raw = assist.value;
  const snap = assist.snap === "step";
  assistState = drag?.kind === "rotate" && (assist.snap || assist.guides.length) ? { ...assist, bone: name } : null;
  const names = rotateNames(name);
  const from = bases ?? Object.fromEntries(names.flatMap((n) => { const b = skeleton!.findBone(n); return b ? [[n, currentOffset(b)] as const] : []; }));
  limitHit = null;
  const turn = rotationSign(bone) * (raw - (from[name] ?? currentOffset(bone)));
  withCompensation(names, () => {
    for (const n of names) {
      const b = skeleton?.findBone(n);
      if (!b) continue;
      setRotatePending(n, n === name ? raw : (from[n] ?? currentOffset(b)) + rotationSign(b) * turn, n === name);
    }
  });
  markPose();
  renderDetail();
  if (drag?.kind === "rotate") {
    status(`${name} ${(pending[name] ?? raw).toFixed(1)}° from setup${snap ? " (snapped to 15°)" : assist.snap ? ` (snapped to the ${assist.snap === "key" ? "previous key" : "mirror bone"})` : ""}${names.length > 1 ? ` + ${names.length - 1} more` : ""}`);
    showReadout(rotateReadout(pending[name] ?? raw, drag.start, assist.snap, typedBuf));
  }
}

/** Hover highlight: the bone under the cursor and a small name label beside it. */
let hoverLabel: HTMLDivElement | null = null;
function ensureHoverLabel(): HTMLDivElement {
  if (!hoverLabel) {
    hoverLabel = document.createElement("div");
    hoverLabel.id = "hoverlabel";
    app.canvas.parentElement?.appendChild(hoverLabel);
  }
  return hoverLabel;
}

/** Where the pointer is on the canvas (screen px) while a drag runs: the live readout follows it. */
let lastPtr = { sx: 0, sy: 0 };
/** Live value readout beside the cursor during a drag (angle, offset). */
function showReadout(r: Readout): void {
  const l = ensureHoverLabel();
  l.className = `assist${r.snap ? ` snap-${r.snap}` : ""}${r.typing ? " typing" : ""}`;
  l.replaceChildren(el("div", { className: "as-main", textContent: r.main }), el("div", { className: "as-sub", textContent: r.sub }));
  l.style.display = "flex";
  const host = l.parentElement;
  const maxX = (host?.clientWidth ?? 9999) - l.offsetWidth - 8;
  const maxY = (host?.clientHeight ?? 9999) - l.offsetHeight - 8;
  // Beside the cursor, flipped to its other side when it would run off the view.
  const x = lastPtr.sx + 18 > maxX ? lastPtr.sx - 18 - l.offsetWidth : lastPtr.sx + 18;
  const y = lastPtr.sy + 20 > maxY ? lastPtr.sy - 20 - l.offsetHeight : lastPtr.sy + 20;
  l.style.left = `${Math.max(4, Math.round(x))}px`;
  l.style.top = `${Math.max(4, Math.round(y))}px`;
}

/** What was pending when the press landed: Esc during a drag puts it back. */
let dragSnap: { pending: typeof pending; move: typeof pendingMove; scale: typeof pendingScale; shear: typeof pendingShear } | null = null;

/** Esc during a drag: drops the unkeyed edits the drag made and ends it (nothing is keyed, nothing to undo). */
function cancelDrag(): boolean {
  if (!drag || drag.kind === "pan") return false;
  if (drag.kind === "box") {
    drag = null;
    drawOverlay();
    return true;
  }
  if (dragSnap) {
    pending = dragSnap.pending;
    pendingMove = dragSnap.move;
    pendingScale = dragSnap.scale;
    pendingShear = dragSnap.shear;
  }
  drag = null;
  assistReset();
  limitHit = null;
  $("limitflash").style.display = "none";
  ensureHoverLabel().style.display = "none";
  markPose();
  drawOverlay();
  renderDetail();
  status("Drag cancelled");
  return true;
}

function setHover(name: string | null, sx: number, sy: number): void {
  ensureHoverLabel();
  if (!hoverLabel) return;
  if (name) {
    hoverLabel.className = "";
    hoverLabel.textContent = name;
    const hint = setup.active() ? null : ikHint(name);
    if (hint) hoverLabel.append(el("div", { className: "as-sub", textContent: hint }));
    hoverLabel.style.display = "block";
    hoverLabel.style.left = `${Math.round(sx + 14)}px`;
    hoverLabel.style.top = `${Math.round(sy + 16)}px`;
  } else hoverLabel.style.display = "none";
  if (name !== hoverBone) {
    hoverBone = name;
    drawOverlay();
  }
}

/** Where the right button went down (client and skeleton space); null once it came up. */
let ctxCandidate: { cx: number; cy: number; x: number; y: number } | null = null;

function wireViewport(): void {
  const canvas = app.canvas;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    const p = toSkeleton(e);
    downScreen = { sx: p.sx, sy: p.sy };
    lastPtr = { sx: p.sx, sy: p.sy };
    dragSnap = { pending: structuredClone(pending), move: structuredClone(pendingMove), scale: structuredClone(pendingScale), shear: structuredClone(pendingShear) };
    // Leave a focused field or dropdown so the hotkeys work on the canvas again.
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    canvas.setPointerCapture(e.pointerId);
    ctxCandidate = e.button === 2 ? { cx: e.clientX, cy: e.clientY, x: p.x, y: p.y } : null;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && (spaceDown || viewModes.pan))) {
      viewGoal = null;
      canvas.style.cursor = "grabbing";
      drag = { kind: "pan", x: p.sx, y: p.sy, wx: world.x, wy: world.y };
      return;
    }
    if (e.button === 0 && abView) {
      setAbView(false);
      return;
    }
    if (e.button !== 0 || !skeleton) return;
    if (facingRight) {
      status("Preview facing right is look-only: switch it off to edit.");
      return;
    }
    if (setup.active()) {
      setup.pointerDown(p, e);
      return;
    }
    // Alt+click walks the bones stacked under the pointer (the next one after the selected bone), so a bone hidden under another can be taken.
    if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const stack = pickStack(p.x, p.y);
      const next = cycleStack(stack, selected);
      if (next) {
        select(next);
        status(stack.length > 1 ? `Alt+click: ${next} (${stack.indexOf(next) + 1} of ${stack.length} under the pointer)` : `Selected ${next}`);
      }
      return;
    }
    // A registered Animate canvas tool (Shape keys ...) gets the press before the bone tools.
    if (activeCanvasTool()?.pointerDown?.(p as CanvasPoint, e, getHost()!)) return;
    // A press on the selected bone's rotate ring always turns that bone: another bone's stick, art or IK handle under the ring never steals it.
    const ringSel = gizmoMode === "rotate" && !e.shiftKey && !e.ctrlKey && !e.metaKey && selected ? skeleton.findBone(selected) : undefined;
    const onRing = !!ringSel && onRotateRing(Math.hypot(p.x - ringSel.world.x, p.y - ringSel.world.y), RING, zoom());
    const hit = onRing ? ringSel!.data.name : (pickBone(p.x, p.y) ?? artBone(p.x, p.y));
    // Shift adds to the selection, Ctrl / Cmd toggles; with a modifier a press only selects (no rotate drag).
    const mode: SelectMode | null = e.shiftKey ? "add" : e.ctrlKey || e.metaKey ? "toggle" : null;
    if (gizmoMode === "ik") {
      const side = handUnder(p.x, p.y);
      if (side) {
        select(sn("hand", side));
        startIk(side, p.x, p.y);
      }
      return;
    }
    if (gizmoMode === "scale" || gizmoMode === "shear") {
      if (startScaleShear(p.x, p.y)) return;
      if (hit) select(hit);
      return;
    }
    const ikT = !mode && !onRing && showBones ? ikTargetAt(p.x, p.y) : null;
    if (ikT) {
      grabSelection(ikT.data.name);
      startMove(ikT.data.name, p.x, p.y);
      status(`Dragging IK target ${ikT.data.name}`);
      return;
    }
    if (mode && hit) {
      select(hit, mode);
      return;
    }
    const sel = selected ? skeleton.findBone(selected) : undefined;
    let grab: string | null = hit;
    let arm: Arm | null = null;
    if (gizmoMode === "move") {
      arm = sel && !mode ? moveArmAt(sel.world, sel, getSpace(), zoom(), p.x, p.y) : null;
      if (arm && !mode) grab = sel!.data.name;
    } else if (!grab && !mode && sel && Math.hypot(p.x - sel.world.x, p.y - sel.world.y) <= (RING * 1.3) / zoom()) grab = sel.data.name;
    if (grab) {
      // A bone an IK constraint drives ignores its own rotate / move: grab the constraint's target instead.
      const handle = ikHandleFor(grab);
      if (handle) {
        grabSelection(handle.target);
        if (handle.chain && gizmoMode === "rotate") startIkRotate(grab, handle.target, p.x, p.y);
        else startMove(handle.target, p.x, p.y);
        status(handle.chain && gizmoMode === "rotate" ? `${grab} is driven by IK '${handle.ik}': turning it moves the target ${handle.target} (the chain follows)` : `${grab} is driven by IK '${handle.ik}': dragging its target ${handle.target}`);
        return;
      }
      grabSelection(grab);
      if (gizmoMode === "move") startMove(grab, p.x, p.y, arm);
      else startRotate(grab, p.x, p.y);
      return;
    }
    // standard: with a bone selected, a press anywhere else turns (or moves) it; a plain click there still deselects.
    // Shift / Ctrl + drag on empty space box-selects instead.
    const selIk = sel ? ikHandleFor(sel.data.name) : null;
    if (!mode && sel && selIk?.chain && gizmoMode === "rotate") {
      startIkRotate(sel.data.name, selIk.target, p.x, p.y);
      if (drag && drag.kind === "move") drag.empty = true;
      status(`${sel.data.name} is driven by IK '${selIk.ik}': turning it moves the target ${selIk.target} (the chain follows)`);
      return;
    }
    if (!mode && sel && (gizmoMode === "rotate" || gizmoMode === "move") && !selIk) {
      if (gizmoMode === "move") startMove(sel.data.name, p.x, p.y);
      else startRotate(sel.data.name, p.x, p.y);
      if (drag && (drag.kind === "rotate" || drag.kind === "move")) drag.empty = true;
      return;
    }
    drag = { kind: "box", x0: p.x, y0: p.y, x1: p.x, y1: p.y, sx: p.sx, sy: p.sy, mode: mode ?? "replace", moved: false };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag && setup.active()) {
      if (!setup.pointerMove(toSkeleton(e))) canvas.style.cursor = spaceDown || viewModes.pan ? "grab" : "default";
      return;
    }
    if (!drag && activeCanvasTool()?.pointerMove?.(toSkeleton(e) as CanvasPoint, getHost()!)) return;
    if (!drag) {
      const p = toSkeleton(e);
      const over = showBones ? grabTargetAt(p.x, p.y) : null;
      canvas.style.cursor = spaceDown || viewModes.pan ? "grab" : over ? "pointer" : "default";
      setHover(over, p.sx, p.sy);
      return;
    }
    const p = toSkeleton(e);
    lastPtr = { sx: p.sx, sy: p.sy };
    if (drag.kind === "pan") {
      world.position.set(drag.wx + p.sx - drag.x, drag.wy + p.sy - drag.y);
      requestRender();
      return;
    }
    if ((drag.kind === "move" || drag.kind === "rotate") && !armDrag(drag, p)) return;
    if (drag.kind === "move") {
      let tx = p.x - drag.gx;
      let ty = p.y - drag.gy;
      const from = drag.starts[drag.bone];
      if (drag.ikRot && from) {
        const r = drag.ikRot;
        let d = Math.atan2(p.y - r.pivot.y, p.x - r.pivot.x) - r.last;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        r.last += d;
        r.accum += d;
        const dx = from.x - r.pivot.x;
        const dy = from.y - r.pivot.y;
        tx = r.pivot.x + Math.cos(r.accum) * dx - Math.sin(r.accum) * dy;
        ty = r.pivot.y + Math.sin(r.accum) * dx + Math.cos(r.accum) * dy;
        if (moveTyped) return;
        dragMoveTo(drag.bone, tx, ty, drag.starts, null);
        return;
      }
      // Shift locks the move to the horizontal or vertical axis (whichever the pointer travelled further along).
      if (e.shiftKey && from) {
        if (Math.abs(tx - from.x) >= Math.abs(ty - from.y)) ty = from.y;
        else tx = from.x;
      }
      if (moveTyped) return; // typed numbers hold the position until Enter or Esc
      dragMoveTo(drag.bone, tx, ty, drag.starts, drag.arm);
      return;
    }
    if (drag.kind === "box") {
      drag.x1 = p.x;
      drag.y1 = p.y;
      if (!drag.moved && Math.hypot(p.sx - drag.sx, p.sy - drag.sy) > 4) drag.moved = true;
      if (drag.moved) drawOverlay();
      return;
    }
    if (drag.kind === "ik") {
      ikTo(drag.side, p.x - drag.gx, p.y - drag.gy);
      return;
    }
    if (drag.kind === "scale") {
      const bone = skeleton?.findBone(drag.bone);
      if (!bone) return;
      const f = handleFrame(bone);
      const sc = scaleAt(f, { d0: drag.d0, r0: drag.r0 }, drag.axis, drag.start, p.x, p.y);
      applyScale(drag.bone, sc.x, sc.y);
      return;
    }
    if (drag.kind === "shear") {
      const bone = skeleton?.findBone(drag.bone);
      if (!bone) return;
      const a = pointerAngle(bone, p.x, p.y);
      let d = a - drag.last;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      drag.last = a;
      drag.accum += d;
      const v = shearValue(drag.start, drag.sign, drag.accum);
      const cur = currentShear(bone);
      if (drag.axis === "x") applyShear(drag.bone, v, cur.y);
      else applyShear(drag.bone, cur.x, v);
      return;
    }
    const bone = skeleton?.findBone(drag.bone);
    if (!bone) return;
    const a = pointerAngle(bone, p.x, p.y);
    let d = a - drag.last;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    drag.last = a;
    drag.accum += d;
    if (typedBuf !== null) return; // a typed number holds the angle until Enter or Esc
    applyRotate(drag.start + drag.sign * drag.accum, drag.bone, drag.bases, { shift: e.shiftKey || viewModes.rot15, ctrl: e.ctrlKey || e.metaKey || viewModes.snapKey });
  });
  // Every pointer move shows its pose and render at once (not on a later timer), so a drag follows the pointer at display rate.
  canvas.addEventListener("pointermove", () => {
    if (drag && (poseDirty || renderDirty)) flush();
  });
  const end = () => {
    if (!drag && activeCanvasTool()?.pointerUp?.(getHost()!)) return;
    assistReset();
    if ((drag?.kind === "rotate" || drag?.kind === "move") && drag.empty && !drag.armed) {
      // A click (no drag) on empty space: deselect, as before.
      drag = null;
      setSelection({ active: null, names: [] });
      return;
    }
    if (detailDue) {
      detailDue = false;
      renderDetailNow();
    }
    if (drag && drag.kind !== "pan" && drag.kind !== "box") ensureHoverLabel().style.display = "none";
    if (drag?.kind === "pan") canvas.style.cursor = spaceDown || viewModes.pan ? "grab" : "default";
    if (setup.active() && setup.pointerUp()) return;
    if (drag?.kind === "ik") {
      if (autoKey) keyIk();
      drawOverlay();
    }
    if (drag?.kind === "move") {
      if (autoKey) keyPending();
      drawOverlay();
    }
    if (drag?.kind === "scale") {
      if (autoKey && pendingScale[drag.bone]) keyScale(drag.bone);
      drawOverlay();
    }
    if (drag?.kind === "shear") {
      if (autoKey && pendingShear[drag.bone]) keyShear(drag.bone);
      drawOverlay();
    }
    if (drag?.kind === "rotate") {
      if (autoKey) keyPending();
      limitHit = null;
      $("limitflash").style.display = "none";
      drawOverlay();
    }
    if (drag?.kind === "box") {
      const box = drag;
      drag = null;
      if (box.moved) {
        const names = bonesInBox(pickCandidates(), box);
        setSelection(selectBones(currentSelection(), names, box.mode));
        status(`${multi.size} bone${multi.size === 1 ? "" : "s"} selected`);
      } else if (box.mode === "replace") setSelection({ active: null, names: [] });
      drawOverlay();
      return;
    }
    drag = null;
  };
  // A right press that never travelled is a click: the canvas menu. A right drag stays a pan.
  canvas.addEventListener("pointerup", (e) => {
    const c = ctxCandidate;
    ctxCandidate = null;
    if (e.button !== 2 || !c || Math.hypot(e.clientX - c.cx, e.clientY - c.cy) > 4) return;
    openCanvasMenu(e.clientX, e.clientY, c.x, c.y);
  });
  endDragNow = end;
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => setHover(null, 0, 0));
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = toSkeleton(e);
      // Line-mode wheels report lines, pinch gestures (ctrlKey) report small deltas: bring both to the pixel scale.
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), p.sx, p.sy);
    },
    { passive: false }
  );
}

// ---------------------------------------------------------------------------------------------
// Rig and clip loading
// ---------------------------------------------------------------------------------------------

function loadRig(outfit: OutfitFixture): Promise<Rig> {
  let p = rigCache.get(outfit.id);
  if (!p) {
    p = (async () => {
      const [json, packed, manifest] = await Promise.all([fetch(`/repo/${outfit.document}`, { cache: "no-store" }).then((r) => r.json() as Promise<unknown>), loadPackedAtlas(`/repo/${outfit.atlas}?v=${Date.now()}`), fetch(`/repo/${outfit.atlas}`, { cache: "no-store" }).then((r) => r.json() as Promise<unknown>)]);
      const extra = new Map<string, RgbaImage>();
      if (outfit.standInWeapon) extra.set(STAND_IN_PATH, standInAxePixels());
      const smears = outfit.standInWeapon ? await loadSavedSmears(extra) : [];
      const doc = withEventDefs(loadAnimDocument(outfit.standInWeapon ? withSmears(withStandInWeapon(json), smears) : json, { source: outfit.document }));
      return { outfit, doc, images: chainImages(separateImages(extra), packed), extra, skinChoice: null, skinMix: [], raw: structuredClone(json) as JsonObject, regions: atlasRegions(manifest) };
    })();
    rigCache.set(outfit.id, p);
    p.catch(() => rigCache.delete(outfit.id));
  }
  return p;
}

/** Puts the clip being edited into the shown rig and recompiles the playback data. */
function rebuildState(): void {
  if (!rig) return;
  // The runtime ties a state to the exact document object its skeleton was built from.
  rig.doc.animations = clipName ? { [clipName]: clip } : {};
  // A fresh library: the runtime caches one per document object, compiled on first use.
  try {
    stateData = new AnimationStateData(new AnimationLibrary(rig.doc));
  } catch (error) {
    // The open clip keys bones this rig does not have (a rig switch kept the old rig's clip): never leave the old state behind, which would
    // throw "skeleton was built from a different document" every frame. Show the setup pose until a clip of this rig is opened.
    const was = clipName;
    rig.doc.animations = {};
    stateData = new AnimationStateData(new AnimationLibrary(rig.doc));
    clipName = "";
    clip = emptyClip();
    status(`Clip '${was}' does not fit this rig (${error instanceof Error ? error.message : String(error)}): showing the setup pose`, "bad");
  }
  tracksPreview?.invalidate();
  transitionsPreview?.invalidate();
  phone?.changed();
}

/** Adds a button for a discovered rig to the outfit menu (set when the menu is built). */
let outfitAdder: ((o: OutfitFixture) => void) | null = null;
let stepsCard: ReturnType<typeof mountStepsCard> | null = null;
let goWorkspace: ((id: "home" | "animate" | "swag" | "rig" | "ship" | "pro") => void) | null = null;

function openNewRig(): void {
  openNewRigDialog({
    existingIds: () => OUTFITS.map((o) => o.id),
    onCreated: rigCreated
  });
}

async function renameOpenRig(): Promise<void> {
  const o = rig?.outfit;
  if (!o) return;
  if (!DISCOVERED_IDS.has(o.id)) return status(`'${o.label}' is a built-in rig: only rigs made with New rig can be renamed`, "bad");
  const name = (await promptDialog({ title: "Rename rig", message: `New name for the rig '${o.label}'`, value: o.label, confirmLabel: "Rename", id: "rename-rig-dialog" }))?.trim();
  if (!name || name === o.label) return;
  try {
    const r = await fetch("/api/rig/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: o.id, label: name }) });
    if (!r.ok) return status(`Rename failed: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status}`, "bad");
    for (const f of ALL_OUTFITS) if (f.id === o.id) f.label = name;
    document.querySelectorAll<HTMLElement>(`#outfits-menu button[data-id="${o.id}"]`).forEach((b) => (b.textContent = name));
    status(`Rig renamed to '${name}'`, "ok");
  } catch (error) {
    status(`Rename failed: ${String(error)}`, "bad");
  }
}

async function deleteOpenRig(): Promise<void> {
  const o = rig?.outfit;
  if (!o) return;
  if (!DISCOVERED_IDS.has(o.id)) return status(`'${o.label}' is a built-in rig and cannot be deleted`, "bad");
  if (!(await confirmDialog(`Delete the rig '${o.label}'?`, "Its files are removed. A copy of its document stays in Versions.", "Delete rig"))) return;
  try {
    const r = await fetch("/api/rig/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: o.id }) });
    if (!r.ok) return status(`Delete failed: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status}`, "bad");
    for (const list of [ALL_OUTFITS, OUTFITS]) {
      const i = list.findIndex((f) => f.id === o.id);
      if (i >= 0) list.splice(i, 1);
    }
    DISCOVERED_IDS.delete(o.id);
    document.querySelectorAll(`#outfits-menu button[data-id="${o.id}"]`).forEach((b) => b.remove());
    await mountOutfit(defaultOutfitId());
    status(`Rig '${o.label}' deleted (its document is in Versions)`, "ok");
  } catch (error) {
    status(`Delete failed: ${String(error)}`, "bad");
  }
}

/** A rig the server just made: list it, open it in the Rig workspace and show the steps card. */
async function rigCreated(entry: DiscoveredRig): Promise<void> {
  for (const o of registerDiscoveredRigs([entry])) outfitAdder?.(o);
  // A new rig starts with no clip: the previous rig's clips (and the open one) do not belong to its bones.
  if (previewState) exitPreview(false);
  // Every unsaved clip, unkeyed pose and Setup / skin edit of this session is autosaved first (); if that fails the session
  // stays as it is (the new rig is already listed in the rig picker) instead of being cleared.
  const what = unsavedSummary();
  const kept = await preserveSession("new-rig");
  if (!kept.ok) {
    status(`New rig '${entry.label}' is saved and listed, but this session's unsaved work could not be autosaved (${kept.error}): staying here. Save, then open the new rig.`, "bad");
    return;
  }
  library.clear();
  dirty.clear();
  drafts.clear();
  clipOrigin.clear();
  clipBase.clear();
  clipName = "";
  clip = emptyClip();
  clearPending();
  keySel = [];
  playRange = null;
  setPlaying(false);
  rigCache.delete(entry.id);
  await mountOutfit(entry.id);
  goWorkspace?.("rig");
  status(`New rig '${entry.label}' saved to your rigs folder (${entry.id})${what ? `; the previous session's ${what} are kept in History (autosave)` : ""}`, "ok");
  renderStepsCard();
}

/** Facts about the open rig for the steps card (from the rig document, so they follow Setup edits). */
function rigFacts() {
  const raw = (rig?.raw ?? {}) as { bones?: { name: string }[]; slots?: { bone: string }[]; skins?: Record<string, { attachments?: Record<string, Record<string, { type?: string }>> }> };
  const rootName = raw.bones?.[0]?.name ?? "root";
  let meshes = 0;
  for (const sk of Object.values(raw.skins ?? {})) for (const slot of Object.values(sk.attachments ?? {})) for (const a of Object.values(slot)) if (a.type === "mesh") meshes++;
  const slots = raw.slots ?? [];
  return { slots: slots.length, bones: Math.max(0, (raw.bones?.length ?? 1) - 1), boundSlots: slots.filter((s) => s.bone !== rootName).length, meshes, clips: library.size };
}

function renderStepsCard(): void {
  const ws = workspaceNow?.() ?? "home";
  stepsCard?.render(!!rig && DISCOVERED_IDS.has(rig.outfit.id) && (ws === "rig" || ws === "pro"));
}

let addingParts = false;
async function addPartsHere(files: File[]): Promise<void> {
  if (!rig || !DISCOVERED_IDS.has(rig.outfit.id)) return status("Parts can be dropped on rigs made with New rig", "bad");
  if (addingParts) return status("Still adding the parts you picked: wait for it to finish", "bad");
  if (setup.unsavedEdits()) return status("Save the rig first (Ctrl+S): adding parts reloads it", "bad");
  addingParts = true;
  try {
    const id = rig.outfit.id;
    const label = rig.outfit.label;
    status(`Adding parts to ${label}...`);
    const slots = (rig.raw["slots"] as { name: string }[] | undefined)?.map((s) => s.name) ?? [];
    const done = await addPartsToRig(id, files, { label, slots });
    if (!done) return status("Add parts cancelled: nothing changed");
    rigCache.delete(id); // the cached rig predates the new parts: reload its document and atlas from disk
    await mountOutfit(id);
    const bits = [done.added ? `Added ${done.added} part${done.added === 1 ? "" : "s"}` : "", done.replaced ? `${done.added ? "replaced" : "Replaced"} ${done.replaced}` : ""].filter(Boolean).join(", ");
    status(`${bits} ${done.added && !done.replaced ? "to" : "in"} ${label}`, "ok");
    renderStepsCard();
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), "bad");
  } finally {
    addingParts = false;
  }
}

function runStep(id: StepId): void {
  if (id === "animate") return void goWorkspace?.("animate");
  if (id === "parts") return void pickPartFiles().then((f) => (f.length ? addPartsHere(f) : undefined));
  goWorkspace?.("rig");
  if (!setup.active()) setup.setMode("setup");
  if (id === "bones") setup.api.setupTool("bone");
  else if (id === "bind") void setup.api.autoBind().then(() => renderStepsCard());
  else if (id === "mesh") setup.api.setupTool("mesh");
}

/** One rig's clip session: the library and everything keyed by its clip names. Parked while another rig is open. */
interface RigSession {
  library: Map<string, ClipData>;
  origin: Map<string, string>;
  dirty: Set<string>;
  base: Map<string, string>;
  applied: Map<string, ClipData>;
  clipName: string;
  undo: HistoryStep[];
  redo: HistoryStep[];
}
const rigSessions = new Map<string, RigSession>();

/** Moves the live clip session (library, dirty set, hashes, open clip, undo) out of the editor and under `rigId`. */
function parkRigSession(rigId: string): void {
  rigSessions.set(rigId, {
    library: new Map(library),
    origin: new Map(clipOrigin),
    dirty: new Set(dirty),
    base: new Map(clipBase),
    applied: new Map(appliedRev),
    clipName,
    undo: undoStack.splice(0),
    redo: redoStack.splice(0)
  });
  library.clear();
  clipOrigin.clear();
  dirty.clear();
  clipBase.clear();
  appliedRev.clear();
  clipName = "";
  clip = emptyClip();
}

/** Brings back the clip session parked for `rigId`; with none, the editor is left empty and mountOutfit seeds it from the rig file. */
function restoreRigSession(rigId: string): void {
  const s = rigSessions.get(rigId);
  if (!s) return;
  rigSessions.delete(rigId);
  for (const [k, v] of s.library) library.set(k, v);
  for (const [k, v] of s.origin) clipOrigin.set(k, v);
  for (const k of s.dirty) dirty.add(k);
  for (const [k, v] of s.base) clipBase.set(k, v);
  for (const [k, v] of s.applied) appliedRev.set(k, v);
  clipName = s.clipName;
  undoStack.push(...s.undo);
  redoStack.push(...s.redo);
}

async function mountOutfit(requested: string): Promise<void> {
  // front view retired 2026-10-25: a stored retired outfit id opens the turned rig.
  const id = liveOutfitId(requested);
  const outfit = OUTFITS.find((o) => o.id === id);
  if (!outfit) return;
  status(`Loading ${outfit.label} rig...`);
  setOutfitButtons(id, true);
  try {
    const next = await loadRig(outfit);
    // The clip library belongs to a rig: switching to another rig parks this rig's session and brings back (or seeds) the other's.
    const leaving = rig && rig.outfit.id !== outfit.id ? rig.outfit.id : "";
    if (leaving) {
      const kept = await preserveSession("rig-switch"); // dirty clips are autosaved first; they also stay in the parked session
      if (!kept.ok) status(`Could not autosave ${leaving} before switching (${kept.error}); its unsaved clips are kept in this tab`, "bad");
      parkRigSession(leaving);
      restoreRigSession(outfit.id);
    }
    if (!library.size) {
      for (const [name, data] of Object.entries(next.doc.animations)) {
        const read = snapClipTimes(structuredClone(data));
        library.set(name, read);
        appliedRev.set(name, read);
        clipOrigin.set(name, `rig (${outfit.document.split("/").pop()})`);
      }
    }
    const sk = new Skeleton(next.doc);
    const skins = activeList(next.doc.skins, next.skinChoice, next.skinMix);
    if (skins.length) sk.setActiveSkins(skins);
    const switched = rig?.outfit.id !== outfit.id;
    const shared = reuseAtlas && !!atlas && !!character && rig?.outfit.id === outfit.id;
    reuseAtlas = false;
    const at = shared ? atlas! : new DynamicAtlas({ pageSize: 1024 });
    const ch = new AnimatorCharacter({ skeleton: sk, atlas: at, images: next.images });
    if (character && atlas) {
      world.removeChild(character);
      retired.push({ node: character, atlas: shared ? null : atlas, ticks: 2 });
    }
    world.addChildAt(ch, 0);
    applyFacing(ch, facingRight ? "right" : "left");
    applySilhouette();
    hideLimitFlash();
    rig = next;
    helperSet = helperBones(next.doc.bones, next.doc.ik);
    // A bone that no longer exists drops out; a fresh editor starts with nothing selected (the status bar says "No bone selected").
    if (selected && !sk.findBone(selected)) selected = null;
    multi = new Set([...multi].filter((n) => sk.findBone(n)));
    if (selected) multi.add(selected);
    skeleton = sk;
    character = ch;
    pagePixels.clear();
    atlas = at;
    if (!clipName) clipName = startClipName(library.keys());
    clip = library.get(clipName) ?? emptyClip();
    rebuildState();
    markPose();
    setOutfitButtons(id, false);
    renderAll();
    // The Setup panels (Rig panel: draw order, constraints, image list) keep their own selection and are drawn only on Setup events.
    setup.api.rigSwitched(switched);
    offerFirstClip();
    renderPoseLibrary();
    const missing = ch.missingTextures.length ? ` (${ch.missingTextures.length} missing textures)` : "";
    status(`${outfit.label}: ${next.doc.bones.length} bones, ${next.doc.slots.length} slots${missing}`, missing ? "bad" : "");
    hostBus.emit("rig");
  } catch (error) {
    setOutfitButtons(rig?.outfit.id ?? "", false);
    status(`Could not load ${outfit.label}: ${error instanceof Error ? error.message : String(error)}`, "bad");
  }
}

/** A rig with no clip opens in its setup pose; in an animating workspace the new-clip form is offered instead of a dead timeline. */
function offerFirstClip(): void {
  if (clipName || !rig) return;
  const ws = workspaceNow?.() ?? "home";
  if (ws === "home" || ws === "rig") return;
  // The New popover opens only when the user presses New (a stale open popover used to sit over the Pro header).
  status(ws === "swag" ? "No clip open: the sheet's Pose sweep works without one" : `No clips yet: ${ws === "animate" ? "open one from Clips" : "press New and name one"} to start animating`);
}

/** Removes a clip from the session library; if it was the one being edited, moves to a neighbour or to "no clip". */
function dropClip(name: string): void {
  if (!library.has(name)) return;
  const next = clipAfterDelete([...library.keys()], name);
  library.delete(name);
  dirty.delete(name);
  clipOrigin.delete(name);
  clipBase.delete(name);
  if (name !== clipName) return renderClipSelect();
  if (next) return switchClip(next);
  clipName = "";
  clip = emptyClip();
  clearPending();
  keySel = [];
  setPlaying(false);
  rebuildState();
  markPose();
  renderAll();
  offerFirstClip();
  hostBus.emit("clip");
}

function setOutfitButtons(active: string, busy: boolean): void {
  for (const b of $("outfits").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.id === active);
    b.disabled = busy;
  }
  // The older rigs are folded under More: it shows as on while one of them is the active rig.
  $("outfits-more").classList.toggle("on", !!$("outfits-menu").querySelector(".on"));
}

function switchClip(name: string): void {
  const data = library.get(name);
  if (!data) return;
  if (previewState) exitPreview(false);
  // The outgoing clip is autosaved first (the snapshot is taken now, the request finishes in the background).
  if (name !== clipName) void autosaver.now("switch");
  // The outgoing clip's unkeyed edits are parked with it (), and the incoming clip's draft at this frame comes back.
  const leftFrame = timeToFrame(clip, time);
  const leftClip = clipName;
  const parked = name !== clipName ? parkPending() : [];
  if (name === clipName) parkPending();
  clipName = name;
  clip = data;
  keySel = [];
  playRange = null;
  renderRangeInfo();
  time = Math.min(time, clip.duration);
  setPlaying(false);
  const back = unparkDraft();
  rebuildState();
  markPose();
  renderAll();
  status(
    parked.length
      ? parkedMessage(parked, leftFrame, ` of ${leftClip || "the working pose"}`)
      : `Clip ${name}: ${clip.duration.toFixed(2)} s, ${frameCount(clip) + (clip.loop ? 0 : 1)} frames at ${clipFps(clip)} fps (${clipOrigin.get(name) ?? "new"})${back.length ? `; ${back.length} unkeyed bone${back.length === 1 ? "" : "s"} back from an earlier visit` : ""}`
  );
  hostBus.emit("clip");
}

async function openFixture(file: string): Promise<void> {
  const raw = (await (await fetch(`/repo/${file}`)).json()) as unknown;
  if (isChannelSpec(raw)) {
    const name = (raw.name ?? file.split("/").pop()!.replace(/\.json$/, "")).replace(/[^A-Za-z0-9_.-]/g, "_");
    const out = importChannelSpec(raw, skeleton?.bones.map((b) => b.data.name) ?? []);
    library.set(name, out.clip);
    clipOrigin.set(name, `imported from ${file}`);
    switchClip(name);
    status(`Imported ${name}: rotate keys for ${out.imported.length} bones; skipped ${out.skipped.join(", ")} (procedural or no rig units)`, "ok");
    return;
  }
  if (library.has("walk_in_place")) switchClip("walk_in_place");
  status(`${file.split("/").pop()} holds walk parameters, not keys; its bake is the rig clip walk_in_place (opened).`);
}

async function openSaved(file: string): Promise<void> {
  const name = file.replace(/\.clip\.json$/, "");
  try {
    const res = await fetch(`/repo/${SAVE_DIR}/${file}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not open ${file}: ${res.status === 404 ? "it is not saved (deleted in another tab?)" : await apiError(res)}`);
    const text = await res.text();
    library.set(name, parseClip(JSON.parse(text)));
    clipBase.set(name, textHash(text));
    clipOrigin.set(name, `${SAVE_DIR}/${file}`);
    dirty.delete(name);
    switchClip(name);
  } catch (error) {
    status(String(error instanceof Error ? error.message : error), "bad");
  }
}

async function refreshSaved(): Promise<void> {
  try {
    savedFiles = (await (await fetch("/api/clips")).json()) as string[];
  } catch {
    savedFiles = [];
  }
  renderClipSelect();
}

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

/**
 * With no clip open nothing can be keyed. Spine's Animate mode has no timeline without an animation, so the pose a gizmo edit makes is kept
 * as the WORKING POSE instead (the unkeyed `pending` edits stay, show on the canvas and in the strip, and are flagged "unkeyed" in the
 * outliner). Opening or creating a clip drops them, as moving the playhead does. Returns true when keying was skipped.
 */
function noClipKeys(): boolean {
  if (clipName) return false;
  if (drag) status("No clip open: the pose is kept as a working pose (unkeyed). Create a clip to key it.");
  return true;
}

function commit(next: ClipData, message?: string): void {
  if (noClipKeys()) return;
  if (previewState) {
    status("Previewing an autosave version: Exit preview (History panel) or Restore it before editing", "bad");
    return;
  }
  // Editing the clip ends the mix preview (): the stage must show the clip that was just changed.
  if (mixPreview()) exitMixPreview("Editing the clip");
  selOf.set(clip, editSelBefore ?? keySel);
  editSelBefore = null;
  undoStack.push({ name: clipName, clip, label: stepLabel(message) });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  clip = next;
  library.set(clipName, clip);
  dirty.add(clipName);
  rebuildState();
  markPose();
  renderAll();
  if (message) status(message);
}

function keyTime(): number {
  return frameTime(clip, timeToFrame(clip, time));
}

function keyBone(name: string, value: number): void {
  if (noClipKeys()) return;
  const { [name]: _drop, ...rest } = pending;
  pending = rest;
  commit(setRotateKey(clip, name, keyTime(), value), `Keyed ${name} rotate ${value.toFixed(2)}° at frame ${timeToFrame(clip, time)}`);
}

/** Keys every unkeyed edit, all four channels, at the playhead in one undo step ("Key it"). Returns how many bones it keyed. */
function keyAllUnkeyed(): number {
  if (noClipKeys()) {
    status("Open or create a clip first: an unkeyed pose has nowhere to go", "bad");
    return 0;
  }
  const t = keyTime();
  let next = clip;
  const names = unkeyedNow();
  if (!names.length) return 0;
  for (const [n, v] of Object.entries(pending)) next = setRotateKey(next, n, t, v);
  for (const [n, m] of Object.entries(pendingMove)) next = setVectorKey(next, n, "translate", t, m.x, m.y);
  for (const [n, m] of Object.entries(pendingScale)) next = setVectorKey(next, n, "scale", t, m.x, m.y);
  for (const [n, m] of Object.entries(pendingShear)) next = setVectorKey(next, n, "shear", t, m.x, m.y);
  clearPending();
  commit(next, `Keyed ${names.length > 3 ? `${names.length} bones` : names.join(", ")} at frame ${timeToFrame(clip, time)}`);
  return names.length;
}

/** Keys every unkeyed gizmo edit (all four channels) at the playhead in one undo step. */
function keyPending(): void {
  if (noClipKeys()) return;
  keyAllUnkeyed();
}

/** The unkeyed channels of one bone, in key order (: K and Key selected key every changed channel, not only rotate / move). */
function pendingChannelsOf(n: string): Channel[] {
  const out: Channel[] = [];
  if (pending[n] !== undefined) out.push("rotate");
  if (pendingMove[n]) out.push("translate");
  if (pendingScale[n]) out.push("scale");
  if (pendingShear[n]) out.push("shear");
  return out;
}

/** "rotate, translate, scale" -> "rotate + move + scale" for the status line. */
const channelWords = (chs: readonly Channel[]) => chs.map((c) => (c === "translate" ? "move" : c)).join(" + ");

/** The bones K and Delete act on: the whole selection. */
function selectedBones(): string[] {
  return multi.size ? [...multi] : selected ? [selected] : [];
}

/**
 * Keys the selected bones at the playhead: every channel the bone has an unkeyed change on (rotate, move, scale, shear), or its rotate
 * when nothing on it changed. Only the channels actually keyed leave the unkeyed set; the status line names them.
 */
function setKey(): void {
  if (noClipKeys()) return;
  if (!skeleton) return;
  const t = keyTime();
  let next = clip;
  const done: string[] = [];
  for (const n of selectedBones()) {
    const bone = skeleton.findBone(n);
    if (!bone) continue;
    const chs = pendingChannelsOf(n);
    if (!chs.length) chs.push("rotate");
    for (const ch of chs) {
      if (ch === "rotate") next = setRotateKey(next, n, t, currentOffset(bone));
      else {
        const v = ch === "translate" ? currentMove(bone) : ch === "scale" ? currentScale(bone) : currentShear(bone);
        next = setVectorKey(next, n, ch, t, v.x, v.y);
      }
      dropPending(ch, n);
    }
    done.push(`${n} (${channelWords(chs)})`);
  }
  if (!done.length) return;
  commit(next, `Keyed ${done.length > 3 ? `${done.length} bones` : done.join(", ")} at frame ${timeToFrame(clip, time)}`);
}

function deleteKey(): void {
  const live = liveSelection(clip, keySel);
  if (live.length) {
    clearPending();
    editSelBefore = keySel;
    keySel = [];
    commit(deleteSelectedKeys(clip, live), `Deleted ${live.length} selected key${live.length === 1 ? "" : "s"}`);
    return;
  }
  const t = keyTime();
  const names = selectedBones().filter((n) => hasAnyKey(clip, n, t));
  if (!names.length) {
    status(`${selected ?? "No bone selected"}: no key at frame ${timeToFrame(clip, time)}`);
    return;
  }
  let next = clip;
  for (const n of names) {
    next = deleteKeys(next, n, t);
    const { [n]: _drop, ...rest } = pending;
    pending = rest;
  }
  commit(next, `Deleted ${names.length > 3 ? `${names.length} bones'` : names.join(", ")} keys at frame ${timeToFrame(clip, time)}`);
}

// ---------------------------------------------------------------------------------------------
// Dopesheet: selection, move, scale, copy range, play range
// ---------------------------------------------------------------------------------------------

function setKeySelection(next: KeySel[]): void {
  keySel = next;
  ($("pastekeys") as HTMLButtonElement).disabled = !keyBoard;
  drawTimeline();
  keyInspector?.render();
}

function selectAllKeys(): void {
  setKeySelection(allKeys(clip));
  status(`Selected ${keySel.length} keys`);
}

function selectRangeKeys(): void {
  const fps = clipFps(clip);
  const a = playRange ? playRange.a / fps : 0;
  const b = playRange ? (playRange.b + 1) / fps : clip.duration;
  setKeySelection(keysInRange(clip, a, b));
  status(`Selected ${keySel.length} keys ${playRange ? `in frames ${playRange.a}-${playRange.b}` : "in the clip"}`);
}

function copySelectedKeys(): void {
  const board = copyKeys(clip, keySel);
  if (!board) {
    status("No keys selected to copy");
    return;
  }
  keyBoard = board;
  lastCopy = "keys";
  ($("pastekeys") as HTMLButtonElement).disabled = false;
  status(`Copied ${board.entries.length} key${board.entries.length === 1 ? "" : "s"} (${board.frames} frames wide)`);
}

function pasteKeyBoard(at?: number): void {
  if (!keyBoard) return;
  const r = pasteKeys(clip, keyBoard, at === undefined ? keyTime() : frameTime(clip, at));
  clearPending();
  editSelBefore = keySel;
  keySel = r.sel;
  commit(r.clip, `Pasted ${keyBoard.entries.length} key${keyBoard.entries.length === 1 ? "" : "s"} at frame ${at ?? timeToFrame(clip, time)}`);
}

function moveSelectedKeys(deltaFrames: number): void {
  if (!liveSelection(clip, keySel).length) {
    status("Select keys in the timeline first, then nudge them", "bad");
    return;
  }
  const before = Math.min(...liveSelection(clip, keySel).map((k) => timeToFrame(clip, k.time)));
  const r = moveKeys(clip, keySel, deltaFrames);
  if (r.clip === clip) {
    status(`The selected keys are already at the ${deltaFrames < 0 ? "start" : "end"} of the clip`);
    return;
  }
  const moved = Math.min(...r.sel.map((k) => timeToFrame(r.clip, k.time))) - before;
  clearPending();
  editSelBefore = keySel;
  keySel = r.sel;
  commit(r.clip, nudgeLabel(r.sel.length, moved));
}

function scaleSelectedKeys(factor: number, pivotFrame = timeToFrame(clip, time)): void {
  if (!(factor > 0)) return;
  if (!liveSelection(clip, keySel).length) {
    const next = scaleClipTiming(clip, factor);
    clearPending();
    commit(next, `Scaled the whole clip to ${Math.round(factor * 100)}% (${next.duration.toFixed(2)} s)`);
    setTime(Math.min(time, next.duration));
    return;
  }
  const r = scaleKeys(clip, keySel, factor, pivotFrame);
  clearPending();
  editSelBefore = keySel;
  keySel = r.sel;
  commit(r.clip, `Scaled ${r.sel.length} keys to ${Math.round(factor * 100)}% about frame ${pivotFrame}`);
}

function setPlayRange(a: number | null, b?: number): void {
  const n = frameCount(clip);
  playRange = a === null ? null : { a: Math.max(0, Math.min(n, Math.min(a, b ?? n))), b: Math.max(0, Math.min(n, Math.max(a, b ?? n))) };
  renderRangeInfo();
  drawTimeline();
}

function renderRangeInfo(): void {
  $("rangeinfo").textContent = playRange ? `frames ${playRange.a}-${playRange.b}` : "";
}

/** Every bone's offsets from setup as currently posed (unkeyed gizmo edits included). */
function currentPoseCopy(opts: { root?: boolean; shear?: boolean } = {}): PoseCopy {
  const copy: PoseCopy = {};
  for (const bone of skeleton?.bones ?? []) {
    if (bone.data.name === "root" && !opts.root) continue;
    const shear = opts.shear ? currentShear(bone) : null;
    copy[bone.data.name] = {
      rotate: currentOffset(bone),
      translate: { x: bone.pose.x - bone.data.x, y: bone.pose.y - bone.data.y },
      scale: { x: bone.data.scaleX ? bone.pose.scaleX / bone.data.scaleX : 1, y: bone.data.scaleY ? bone.pose.scaleY / bone.data.scaleY : 1 },
      // Shear is only written when the bone is sheared, so poses of unsheared characters stay as they were.
      ...(shear && (Math.abs(shear.x) > 1e-4 || Math.abs(shear.y) > 1e-4) ? { shear } : {})
    };
  }
  return copy;
}

/** Copies the pose at the playhead: every bone, or only the selected bones (paste then keys just those). */
function copyPose(onlySelected = false): void {
  if (!skeleton) return;
  const all = currentPoseCopy();
  const names = onlySelected ? selectedBones().filter((n) => all[n]) : Object.keys(all);
  if (!names.length) return void status("Select bones to copy first");
  poseClipboard = Object.fromEntries(names.map((n) => [n, all[n]!]));
  lastCopy = "pose";
  ($("pastepose") as HTMLButtonElement).disabled = false;
  status(`Copied ${onlySelected ? `${names.length} selected bone${names.length === 1 ? "" : "s"}` : "the pose"} at frame ${timeToFrame(clip, time)} of ${clipName}; Ctrl+V pastes at the playhead`);
}

function pasteClipboard(): void {
  if (!poseClipboard) return;
  clearPending();
  commit(pastePose(clip, poseClipboard, keyTime()), `Pasted the pose at frame ${timeToFrame(clip, time)}`);
}

// ---------------------------------------------------------------------------------------------
// Mirror pose and breakdown
// ---------------------------------------------------------------------------------------------

export interface MirrorSummary {
  /** Bones that got keys. */
  keyed: string[];
  /** The side copied from (null for a flip or when only axis bones were mirrored). */
  from: BodySide | null;
  /** Selected bones left alone because a constraint (leg IK) drives them. */
  driven: string[];
  /** Bones with no partner that are not on the axis. */
  unmatched: string[];
  /** IK constraints whose mix was keyed to follow the mirror. */
  ik: string[];
}

function mirrorRig(): MirrorRig | null {
  return rig ? makeMirrorRig(rig.doc.bones) : null;
}

/** A bone's offsets from setup as posed now, unkeyed gizmo edits included (all four channels). */
function mirrorRead(name: string): MirrorOffsets {
  const bone = skeleton?.findBone(name);
  if (!bone) throw new Error(`no bone ${name}`);
  const shear = pendingShear[name] ?? { x: bone.pose.shearX - bone.data.shearX, y: bone.pose.shearY - bone.data.shearY };
  return { rotate: currentOffset(bone), translate: currentMove(bone), scale: currentScale(bone), shear };
}

const otherBodySide = (side: BodySide): BodySide => (side === "near" ? "far" : "near");

/**
 * Bones whose own keys show nothing right now, so a mirror leaves them alone: the chain of an IK constraint that is on (the leg follows its foot
 * target, which is mirrored instead), a bone whose rotation a world transform constraint takes over completely (the foot follows its plant
 * target), and physics bones. The relative helpers (elbow, wrist, knee, hip halves) add to their own pose, so they are not in the set.
 */
function mirrorSkipped(): Set<string> {
  const out = new Set<string>();
  if (!skeleton) return out;
  for (const c of skeleton.ikConstraints) if (c.pose.mix > 1e-6) for (const b of c.bones) out.add(b.data.name);
  for (const c of skeleton.transformConstraints) if (!c.data.relative && !c.data.local && c.pose.mixRotate >= 0.999) for (const b of c.bones) out.add(b.data.name);
  for (const c of skeleton.pathConstraints) for (const b of c.bones) out.add(b.data.name);
  for (const c of skeleton.physicsConstraints) out.add(c.bone.data.name);
  return out;
}

function runMirror(plan: MirrorPlan, mrig: MirrorRig, label: string, driven: string[]): MirrorSummary {
  const summary: MirrorSummary = { keyed: [], from: plan.from, driven, unmatched: plan.unmatched, ik: [] };
  if (!skeleton || !rig) return summary;
  if (!plan.ops.length) {
    status(driven.length ? `${driven.join(", ")} ${driven.length === 1 ? "is" : "are"} driven by IK: mirror its target bone (or the whole limb) instead` : plan.unmatched.length ? `No mirror partner for ${plan.unmatched.join(", ")}` : "Nothing to mirror", "bad");
    return summary;
  }
  const t = keyTime();
  const r = applyMirror(clip, mrig, plan.ops, mirrorRead, t);
  let next = r.clip;
  for (const op of mirrorIkOps(rig.doc.ik, plan.ops)) {
    const src = skeleton.ikConstraints.find((c) => c.data.name === op.from);
    const dst = skeleton.ikConstraints.find((c) => c.data.name === op.to);
    if (!src || !dst) continue;
    // Equal mixes on an unkeyed constraint (both legs on) need no key; anything else follows the mirror.
    if (Math.abs(src.pose.mix - dst.pose.mix) < 1e-6 && !(clip.ik[op.to]?.length ?? 0)) continue;
    next = setIkMixKey(next, op.to, t, src.pose.mix, dst.pose.mix);
    summary.ik.push(op.to);
  }
  clearPending();
  summary.keyed = r.keyed;
  commit(next, `${label}: keyed ${r.keyed.length} bone${r.keyed.length === 1 ? "" : "s"} at frame ${timeToFrame(clip, time)}${driven.length ? `; left ${driven.join(", ")} (IK-driven)` : ""}`);
  return summary;
}

/** M: copies the selected bones (their whole limb with limb = true) onto the other side; a bone on the axis (spine, head) mirrors in place. */
function mirrorSelection(options: { limb?: boolean; from?: BodySide } = {}): MirrorSummary | null {
  const mrig = mirrorRig();
  if (!mrig || !skeleton || setup.active()) return null;
  const names = selectedBones();
  if (!names.length) {
    status("Select bones to mirror first", "bad");
    return null;
  }
  const drivenNow = mirrorSkipped();
  const plan = planMirror(mrig, names, { limb: options.limb ?? ($("mirrorlimb") as HTMLInputElement).checked, active: selected, skip: drivenNow, ...(options.from ? { from: options.from } : {}) });
  const label = plan.from ? `Mirrored ${plan.from} to ${otherBodySide(plan.from)}` : "Mirrored";
  return runMirror(plan, mrig, label, names.filter((n) => drivenNow.has(n)));
}

/** Copies a whole arm or leg (IK target and IK mix included) of side `from` onto the other side. */
function mirrorLimb(limb: Limb, from: BodySide): MirrorSummary | null {
  const mrig = mirrorRig();
  if (!mrig || !skeleton || setup.active()) return null;
  const plan = planLimb(mrig, limb, from, mirrorSkipped());
  return runMirror(plan, mrig, `${limb[0]!.toUpperCase()}${limb.slice(1)} ${from} to ${otherBodySide(from)}`, []);
}

/** Shift+M: swaps near and far for the whole pose and mirrors the spine and head. */
function flipPose(): MirrorSummary | null {
  const mrig = mirrorRig();
  if (!mrig || !skeleton || setup.active()) return null;
  return runMirror(planFlip(mrig, mirrorSkipped()), mrig, "Flipped the pose", []);
}

const bdSlider = () => $("bdslider") as HTMLInputElement;
const bdNumber = () => $("bdvalue") as HTMLInputElement;
/** The clip as it was when the slider drag began (the drag edits the clip live and becomes one undo step on release). */
let breakdownBase: ClipData | null = null;

function breakdownPercent(): number {
  return clampBreakdown(Number(bdSlider().value) || 0);
}

function syncBreakdown(p: number): void {
  bdSlider().value = String(p);
  bdNumber().value = String(p);
}

/**
 * Keys the selected bones at the playhead at `percent` between their previous and next keys (0 = previous, 100 = next, outside = overshoot).
 * `live` (a slider drag) edits the clip without an undo step; endBreakdownDrag() closes it.
 */
function breakdown(percent: number = breakdownPercent(), live = false): BreakdownResult | null {
  if (!skeleton || setup.active()) return null;
  const names = selectedBones().filter((n) => skeleton!.findBone(n));
  if (!names.length) {
    status("Select bones for the breakdown first", "bad");
    return null;
  }
  const p = clampBreakdown(percent);
  syncBreakdown(p);
  const r = breakdownBones(breakdownBase ?? clip, names, keyTime(), p);
  const count = Object.keys(r.keyed).length;
  if (!count) {
    status(`No breakdown: ${names.length === 1 ? names[0] : `${names.length} bones`} need a key before and after frame ${timeToFrame(clip, time)}`, "bad");
    return r;
  }
  clearPending();
  const message = `Breakdown ${p}%: keyed ${count} bone${count === 1 ? "" : "s"} at frame ${timeToFrame(clip, time)}${r.skipped.length ? `; ${r.skipped.length} without keys either side` : ""}`;
  if (live) {
    breakdownBase ??= clip;
    clip = r.clip;
    library.set(clipName, clip);
    dirty.add(clipName);
    rebuildState();
    markPose();
    renderAll();
    status(message);
  } else {
    breakdownBase = null;
    commit(r.clip, message);
  }
  return r;
}

/** Closes a live slider drag: the whole drag is one undo step. */
function endBreakdownDrag(): void {
  const base = breakdownBase;
  breakdownBase = null;
  if (!base || base === clip) return;
  undoStack.push({ name: clipName, clip: base, label: "Breakdown" });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

function wireMirrorBreakdown(): void {
  $("mirrorsel").addEventListener("click", () => mirrorSelection());
  $("flippose").addEventListener("click", () => flipPose());
  for (const [id, limb, from] of [["mirror-arm-nf", "arm", "near"], ["mirror-arm-fn", "arm", "far"], ["mirror-leg-nf", "leg", "near"], ["mirror-leg-fn", "leg", "far"]] as const) {
    $(id).addEventListener("click", () => mirrorLimb(limb, from));
  }
  const slider = bdSlider();
  const number = bdNumber();
  slider.min = String(BREAKDOWN_MIN);
  slider.max = String(BREAKDOWN_MAX);
  number.min = String(BREAKDOWN_MIN);
  number.max = String(BREAKDOWN_MAX);
  syncBreakdown(50);
  slider.addEventListener("input", () => {
    number.value = slider.value;
    breakdown(Number(slider.value), true);
  });
  slider.addEventListener("change", () => endBreakdownDrag());
  number.addEventListener("change", () => breakdown(Number(number.value) || 0));
  const presets = $("bdpresets");
  for (const p of BREAKDOWN_PRESETS) {
    const b = el("button", { textContent: String(p), title: `Key the selected bones ${p}% of the way from their previous key to their next key` });
    b.dataset.percent = String(p);
    b.addEventListener("click", () => breakdown(p));
    presets.append(b);
  }
}

/** Undo / redo swap the clip: remember the selection the left state had, and bring back the keys of the state we return to (P0-4). */
function swapKeySelection(leaving: ClipData, arriving: ClipData): void {
  selOf.set(leaving, keySel);
  keySel = liveSelection(arriving, selOf.get(arriving) ?? keySel);
  clearTlHover();
}

function undo(): void {
  if (setup.active() && !(skinTurn && undoStack.at(-1)?.skin)) return void setup.undo();
  const entry = undoStack.pop();
  if (!entry) return;
  if (entry.swap) {
    redoStack.push(entry);
    entry.swap.undo();
    renderClipControls();
    status(historyStatus("Undo", entry.label));
    return;
  }
  const leaving = library.get(entry.name)!;
  redoStack.push({ name: entry.name, clip: leaving, label: entry.label });
  library.set(entry.name, entry.clip);
  if (entry.name !== clipName) switchClip(entry.name);
  swapKeySelection(leaving, entry.clip);
  clip = entry.clip;
  clearPending();
  rebuildState();
  markPose();
  renderAll();
  status(historyStatus("Undo", entry.label));
}

function redo(): void {
  if (setup.active() && !(skinTurn && redoStack.at(-1)?.skin)) return void setup.redo();
  const entry = redoStack.pop();
  if (!entry) return;
  if (entry.swap) {
    undoStack.push(entry);
    entry.swap.redo();
    renderClipControls();
    status(historyStatus("Redo", entry.label));
    return;
  }
  const leaving = library.get(entry.name)!;
  undoStack.push({ name: entry.name, clip: leaving, label: entry.label });
  library.set(entry.name, entry.clip);
  if (entry.name !== clipName) switchClip(entry.name);
  swapKeySelection(leaving, entry.clip);
  clip = entry.clip;
  clearPending();
  rebuildState();
  markPose();
  renderAll();
  status(historyStatus("Redo", entry.label));
}

function setTime(t: number, snap = true): void {
  const next = Math.max(0, Math.min(clip.duration, t));
  const to = snap ? frameTime(clip, timeToFrame(clip, next)) : next;
  // : leaving a frame parks its unkeyed edits there (they used to be dropped); arriving on a frame brings its draft back.
  const fromFrame = timeToFrame(clip, time);
  const parked = timeToFrame(clip, to) !== fromFrame ? parkPending() : [];
  time = to;
  const back = unparkDraft();
  preview?.sync(false);
  hideLimitFlash();
  if (parked.length) status(parkedMessage(parked, fromFrame));
  else if (back.length) status(`Unkeyed changes on ${back.length > 3 ? `${back.length} bones` : back.join(", ")} are back (parked here earlier, not keyed yet)`);
  markPose();
  updateReadout();
  drawTimeline();
  renderBones();
  hostBus.emit("time");
  renderDetail();
  if (!playing) audioTrack?.scrub();
}

function setPlaying(on: boolean): void {
  const wasPlaying = playing;
  playing = on;
  if (on && abView) setAbView(false);
  if (on && !wasPlaying) {
    const frameNow = timeToFrame(clip, time);
    const parked = parkPending();
    if (parked.length) status(parkedMessage(parked, frameNow, " while playing"));
    // One thing plays at a time (): playing the clip closes the mix preview.
    if (mixPreview()) exitMixPreview("Playing the clip");
  }
  if (on && playRange && (timeToFrame(clip, time) < playRange.a || timeToFrame(clip, time) > playRange.b)) time = frameTime(clip, playRange.a);
  if (on && !wasPlaying && !clip.loop && !playRange && time >= clip.duration - KEY_EPSILON) time = 0;
  if (on && !wasPlaying) playStartTime = time;
  if (!on) {
    time = frameTime(clip, timeToFrame(clip, held ? heldTime(clip, time) : time));
    // Stopping on a frame that has a parked draft brings it back ().
    if (wasPlaying) unparkDraft();
  }
  preview?.sync(on);
  paintPlay(on);
  audioTrack?.playChanged(on);
  markPose();
  if (!on) {
    updateReadout();
    drawTimeline();
    renderBones();
    renderDetail();
  }
}

function validForSave(): string | null {
  try {
    parseClip(writeClip(clip));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const issues = rig ? poseGates(rig.doc, clipName, clip, 0).filter((i) => i.kind === "format" || i.kind === "reference").filter((i) => i.severity === "error") : [];
  return issues.length ? issues.map((i) => i.message).join("; ") : null;
}

/**
 * What a clip save did (): the exact revision (library object) that reached the file, or why nothing was written. Mark done,
 * Apply and the clip board act only on `ok`, and Apply writes the saved revision, not whatever the clip became meanwhile.
 */
type SaveOutcome = { ok: true; name: string; clip: ClipData } | { ok: false; error: string };
const notSaved = (error: string): SaveOutcome => ({ ok: false, error });

async function save(): Promise<SaveOutcome> {
  if (previewState) {
    status("Previewing an autosave version: Exit preview or Restore it before saving", "bad");
    return notSaved("an autosave version is being previewed");
  }
  if (!clipName) return notSaved("no clip open");
  if (!(await persistSkins())) return notSaved("the skins did not save");
  const problem = validForSave();
  if (problem) {
    status(`Not saved: ${problem}`, "bad");
    return notSaved(problem);
  }
  return saveClipFile(clipName);
}

/** One save per clip at a time (): a second save waits for the first, then writes against the hash the first one got back. */
const saveChains = new Map<string, Promise<unknown>>();
/** The clip revision each name has in the rig file (read from it, or written by Apply): what a Spine export contains (). */
const appliedRev = new Map<string, ClipData>();
function saveClipFile(name: string): Promise<SaveOutcome> {
  const run = (saveChains.get(name) ?? Promise.resolve()).then(() => writeClipFile(name, clipBase.get(name) ?? CLIP_BASE_NEW));
  saveChains.set(name, run.catch(() => undefined));
  return run;
}

/**
 * Writes one clip file with the conflict check; a 409 opens the two-tabs dialog. The clip object is captured before the request: when
 * it finishes, `dirty` is cleared only if the library still holds that same revision, so an edit made while the save was in flight
 * stays unsaved ().
 */
async function writeClipFile(name: string, base: string): Promise<SaveOutcome> {
  const file = `${name}.clip.json`;
  const data = library.get(name);
  if (!data) return notSaved(`${name} is not open`);
  let res: Response;
  try {
    res = await fetch(`/api/clips/${encodeURIComponent(file)}`, { method: "POST", body: clipJson(data), headers: { "Content-Type": "application/json", [CLIP_BASE_HEADER]: base } });
  } catch (error) {
    status("Save failed: the editor server is not answering. Your edits are still here: do not close the tab.", "bad");
    showToast(`Save failed: the editor server is not answering. ${name} is NOT saved.`, "bad", String(error));
    return notSaved("the editor server is not answering");
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; current?: string | null };
    status(`Not saved: ${body.error ?? "the clip changed in another tab/window"}`, "bad");
    const choice = await conflictDialog(name, body.error ?? "the saved file changed since this tab opened it");
    if (choice === "overwrite") return writeClipFile(name, body.current ?? CLIP_BASE_NEW);
    if (choice === "reload") {
      if (!body.current) {
        status(`${file} no longer exists on disk: nothing to reload`, "bad");
        return notSaved(`${file} no longer exists on disk`);
      }
      await reloadFromDisk(name);
      status(`Reloaded ${file} from disk (your edits here were dropped)`, "ok");
      return notSaved("reloaded the file from disk instead of saving");
    }
    if (choice === "copy") {
      const copy = copyClipName(name, (n) => library.has(n) || savedFiles.includes(`${n}.clip.json`));
      library.set(copy, data);
      clipOrigin.set(copy, "new");
      dirty.add(copy);
      if (name === clipName) switchClip(copy);
      const copied = await writeClipFile(copy, CLIP_BASE_NEW);
      if (copied.ok && body.current) await reloadFromDisk(name);
      return notSaved(copied.ok ? `saved as the copy ${copy}, not as ${name}` : copied.error);
    }
    return notSaved(body.error ?? "the clip changed in another tab/window");
  }
  if (!res.ok) {
    const message = await apiError(res);
    status(`Save failed: ${message}`, "bad");
    showToast(`Save failed: ${message}. ${name} is NOT saved.`, "bad", `POST /api/clips/${file} -> ${res.status}\n${message}`);
    return notSaved(message);
  }
  const { path, hash } = (await res.json()) as { path: string; hash?: string };
  if (hash) clipBase.set(name, hash);
  const newer = library.get(name) !== data;
  if (!newer) dirty.delete(name);
  refreshStatusBar();
  clipOrigin.set(name, path);
  await refreshSaved();
  const shown = path.split("/").pop() ?? name;
  status(newer ? `Saved ${shown}; the edits made during the save are still unsaved` : `Saved ${shown} to your clips folder`, newer ? "" : "ok");
  hostBus.emit("save");
  return { ok: true, name, clip: data };
}

/** Replaces a library clip with its saved file (after "Reload theirs", "Save mine as a copy" or a restore); stays on the clip that is open. */
async function reloadFromDisk(name: string): Promise<void> {
  const res = await fetch(`/repo/${SAVE_DIR}/${name}.clip.json`, { cache: "no-store" });
  if (!res.ok) return;
  const text = await res.text();
  library.set(name, parseClip(JSON.parse(text)));
  clipBase.set(name, textHash(text));
  clipOrigin.set(name, `${SAVE_DIR}/${name}.clip.json`);
  dirty.delete(name);
  if (name === clipName) switchClip(name);
  else renderClipSelect();
  refreshStatusBar();
}

function exportClip(): void {
  if (!clipName) {
    status("Nothing to export: open or create a clip first", "bad");
    return;
  }
  const problem = validForSave();
  if (problem) {
    status(`Not exported: ${problem}`, "bad");
    return;
  }
  const url = URL.createObjectURL(new Blob([clipJson(clip)], { type: "application/json" }));
  const a = el("a", { href: url, download: `${clipName}.clip.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status(clipDownloadMessage(`${clipName}.clip.json`), "ok");
}

// ---------------------------------------------------------------------------------------------
// Apply to the rig document, and render the contact sheet and phone-size previews through the CLI
// ---------------------------------------------------------------------------------------------

const rigFileName = (outfit: OutfitFixture): string => outfit.document.split("/").pop()!;

/** Saves the clip file and writes the clip into the rig document(s). Returns the files written, or null on failure. */
async function applyToRig(allViews = $<HTMLInputElement>("applyall").checked): Promise<string[] | null> {
  const problem = validForSave();
  if (problem || !rig || !clipName) {
    status(`Not applied: ${problem ?? "no rig"}`, "bad");
    return null;
  }
  // Apply writes exactly the revision that was saved (): nothing is applied when the save did not complete.
  const saved = await save();
  if (!saved.ok) {
    status(`Not applied: the clip did not save (${saved.error})`, "bad");
    return null;
  }
  if (usesStandIn(saved.clip)) {
    status("Not applied: the clip keys the stand-in weapon, which is not in the rig file yet", "bad");
    return null;
  }
  const files = allViews ? [...new Set(OUTFITS.map(rigFileName))] : [rigFileName(rig.outfit)];
  const res = await fetch("/api/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files, clip: saved.name, data: writeClip(saved.clip) }) });
  const body = (await res.json()) as { files?: string[]; hashes?: Record<string, string>; error?: string };
  if (!res.ok || !body.files) {
    status(`Apply failed: ${body.error ?? res.status}`, "bad");
    return null;
  }
  // This tab changed the rig file: Setup / skins saves continue from its new hash (and still refuse another tab's change).
  setup.rebase(body.hashes?.[rig.outfit.document] ?? null);
  appliedRev.set(saved.name, saved.clip);
  status(`Applied ${saved.name} to ${body.files.join(", ")}`, "ok");
  return body.files;
}

/** True when the clip keys anything the stand-in weapon added (it exists only in the editor). */
function usesStandIn(c: ClipData): boolean {
  return !!rig?.outfit.standInWeapon && (!!c.bones.weapon || Object.keys(c.slots).some((n) => n.startsWith("weapon")));
}

// ---------------------------------------------------------------------------------------------
// Spine import / export (Export tab; routes in vite.config.ts, logic in src/spineApi.ts)
// ---------------------------------------------------------------------------------------------

/** The last Spine import that can still be reverted. */
let lastSpineImport: { file: string; backup: string } | null = null;

function spineResult(lines: string[], kind: "" | "bad" | "ok" = "", path = ""): void {
  const box = $("spine-result");
  box.replaceChildren(...lines.map((line) => el("div", { textContent: line })));
  box.className = kind ? `note ${kind}` : "note";
  if (path) box.dataset.path = path;
  else delete box.dataset.path;
  $<HTMLButtonElement>("spine-revert").disabled = !lastSpineImport;
}

/** Loads a rig document that changed on disk (Spine import / revert): remounts it and refreshes every clip that has no unsaved edits. */
async function adoptDiskRig(text: string): Promise<void> {
  await setRigRaw(JSON.parse(text) as JsonObject);
  if (!rig) return;
  for (const [name, data] of Object.entries(rig.doc.animations))
    if (!dirty.has(name)) {
      const read = snapClipTimes(structuredClone(data));
      library.set(name, read);
      appliedRev.set(name, read);
    }
  for (const name of [...library.keys()]) if (!rig.doc.animations[name] && !dirty.has(name) && clipOrigin.get(name)?.startsWith("rig")) library.delete(name);
  if (!library.has(clipName)) clipName = startClipName(library.keys());
  clip = library.get(clipName) ?? emptyClip();
  undoStack.length = 0;
  redoStack.length = 0;
  setup.api.setupResetSession();
  rebuildState();
  markPose();
  renderAll();
  hostBus.emit("clip");
}

async function importSpineFile(file: File): Promise<void> {
  if (!rig || rig.outfit.standInWeapon) return spineResult(["Open a saved rig (not the in-memory weapon view) to import into."], "bad");
  const rigFile = rig.outfit.document;
  spineResult([`Checking ${file.name}...`]);
  try {
    const spineText = await file.text();
    // : a dry run first, then the loss report in a dialog; nothing is written until it is confirmed.
    const dry = await fetch("/api/rig/import-spine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: rigFile, spine: spineText, dryRun: true }) });
    const dryBody = (await dry.json()) as { error?: string; meshes: string[]; linked: string[]; deform: string[]; clips: { name: string; replaced: boolean }[]; warnings: string[] };
    if (!dry.ok) return spineResult([`Import failed: ${dryBody.error ?? dry.status}`], "bad");
    const report = spineImportLoss(JSON.parse(spineText) as unknown, dryBody);
    const go = await confirmDialog("Import from Spine into this rig?", `${file.name} is merged into the saved rig (not a new rig). Revert import puts the rig back. This is what comes across and what does not.`, "Import", false, { lines: lossLines(report), id: "spine-loss-dialog" });
    if (!go) return spineResult([`Import of ${file.name} cancelled: nothing was changed.`]);
    spineResult([`Importing ${file.name}...`]);
    const res = await fetch("/api/rig/import-spine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: rigFile, spine: spineText }) });
    const body = (await res.json()) as { error?: string; backup?: string | null; meshes: string[]; linked: string[]; deform: string[]; clips: { name: string; replaced: boolean; duration: number }[]; warnings: string[]; text: string };
    if (!res.ok) return spineResult([`Import failed: ${body.error ?? res.status}`], "bad");
    lastSpineImport = body.backup ? { file: rigFile, backup: body.backup } : null;
    await adoptDiskRig(body.text);
    const changed = body.meshes.length + body.linked.length + body.deform.length + body.clips.length;
    spineResult(
      [
        changed ? `Imported ${file.name}: ${body.meshes.length} mesh(es) with weights, ${body.linked.length} linked mesh(es), ${body.deform.length} deform timeline(s), ${body.clips.length} clip(s).` : `${file.name}: nothing in it matched this rig.`,
        ...body.clips.map((c) => `  clip ${c.name}: ${c.replaced ? "replaced" : "added"}, ${c.duration}s`),
        ...(body.meshes.length ? [`  meshes: ${body.meshes.join(", ")}`] : []),
        ...body.warnings.map((w) => `warning: ${w}`),
        ...(lastSpineImport ? ["Revert import puts the rig back as it was."] : [])
      ],
      body.warnings.length ? "" : "ok"
    );
    status(`Imported from Spine: ${changed} item(s)${body.warnings.length ? `, ${body.warnings.length} warning(s)` : ""}`, "ok");
  } catch (error) {
    spineResult([`Import failed: ${error instanceof Error ? error.message : String(error)}`], "bad");
  }
}

async function revertSpineImport(): Promise<void> {
  const last = lastSpineImport;
  if (!last) return;
  const res = await fetch("/api/rig/import-spine/revert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(last) });
  const body = (await res.json()) as { error?: string; text?: string };
  if (!res.ok || !body.text) return spineResult([`Revert failed: ${body.error ?? res.status}`], "bad");
  lastSpineImport = null;
  await adoptDiskRig(body.text);
  spineResult(["Reverted the Spine import: the rig is as it was before it."], "ok");
  status("Reverted the Spine import", "ok");
}

async function exportSpineFull(): Promise<void> {
  if (!rig || rig.outfit.standInWeapon) {
    status("Not exported: open a saved rig (not the in-memory weapon view) to export it to Spine", "bad");
    return spineResult(["Open a saved rig (not the in-memory weapon view) to export it to Spine."], "bad");
  }
  // Preflight (): the export reads the SAVED rig file. Unsaved Setup / skin edits block it; an open clip that is not the
  // applied revision is applied first on request, or the result says plainly that it is not included.
  const unsaved = [setup.unsavedEdits() ? "unsaved Setup edits" : "", rig.skinsDirty ? "unsaved skin edits" : ""].filter(Boolean);
  if (unsaved.length) {
    const why = `Not exported: the export reads the saved rig file and this tab has ${unsaved.join(" and ")}. Save rig first.`;
    status(why, "bad");
    return spineResult([why], "bad");
  }
  let note = "";
  if (clipName && appliedRev.get(clipName) !== library.get(clipName)) {
    const state = dirty.has(clipName) ? "has unsaved edits" : "is not applied to the rig file";
    const apply = await confirmDialog("The open clip is not in the rig file", `${clipName} ${state}, so the Spine export would not contain the animation you see. Apply it to the rig first?`, "Apply, then export", false);
    if (apply) {
      if (!(await applyToRig())) return spineResult([`Not exported: ${clipName} did not apply (see the status line).`], "bad");
    } else note = `${clipName} is NOT in this export: it ${state}.`;
  }
  // : say what the file will not carry before writing it.
  const report = spineExportLoss(rig.raw);
  const go = await confirmDialog("Export to Spine?", `${rig.outfit.label} is written as a Spine skeleton. This is what comes across and what does not.`, "Export", false, { lines: lossLines(report), id: "spine-loss-dialog" });
  if (!go) return spineResult(["Export cancelled: nothing was written."]);
  spineResult(["Exporting the rig to Spine..."]);
  status("Exporting the rig to Spine...");
  try {
    const res = await fetch("/api/rig/export-spine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: rig.outfit.document, base: await setup.baseHash() }) });
    const body = (await res.json()) as { error?: string; json: string; images: number; clips: string[]; warnings: string[]; deformTimelines: number; linkedMeshes: number };
    if (!res.ok) {
      status(`Spine export failed: ${body.error ?? res.status}`, "bad");
      return spineResult([`Export failed: ${body.error ?? res.status}`], "bad");
    }
    spineResult([...(note ? [note] : []), ...spineExportLines(body)], body.warnings.length || note ? "" : "ok", body.json);
    status(`${spineExportStatus(body)}${note ? ` (${note})` : ""}`, body.warnings.length || note ? "" : "ok");
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    status(`Spine export failed: ${why}. Is the editor server running?`, "bad");
    spineResult([`Export failed: ${why}`], "bad");
  }
}

type RenderResult = { files: { scale: number; sheet: string; gif: string; log: string }[] };

async function renderSheets(): Promise<RenderResult | null> {
  if (!rig) return null;
  const applied = await applyToRig();
  if (!applied) return null;
  const preset = activeRenderPreset();
  status(`Rendering ${clipName} at ${preset.scales.join(" and ")} (${preset.label}) through the animator CLI...`);
  const res = await fetch("/api/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: rigFileName(rig.outfit), clip: clipName, scales: preset.scales, background: preset.background }) });
  const body = (await res.json()) as RenderResult & { error?: string };
  if (!res.ok || !body.files) {
    status(`Render failed: ${body.error ?? res.status}`, "bad");
    return null;
  }
  showExportResult(body);
  status(`Rendered ${clipName}: contact sheets and previews in packages/animator-editor/exports`, "ok");
  return body;
}

function showExportResult(result: RenderResult): void {
  let panel = document.getElementById("exportresult");
  if (!panel) {
    panel = el("div", { className: "hud br" });
    panel.id = "exportresult";
    viewEl.append(panel);
  }
  panel.style.right = "10px";
  panel.replaceChildren();
  const close = el("button", { textContent: "Close" });
  close.addEventListener("click", () => panel!.remove());
  panel.append(el("div", { className: "pvhead" }, el("span", { className: "label", textContent: `Rendered ${clipName} (CLI): contact sheet and phone-size preview at each scale` }), close));
  const row = el("div", { className: "imgs" });
  for (const f of result.files) {
    const cell = el("div", {}, el("div", { className: "label", textContent: `${f.scale}: ${f.log.replace(/ \(.*$/, "")}` }));
    for (const path of [f.sheet, f.gif]) {
      const img = el("img", { title: path }) as HTMLImageElement;
      img.src = `/repo/${path}?${Date.now()}`;
      cell.append(img);
    }
    row.append(cell);
  }
  panel.append(row);
}

// ---------------------------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------------------------

function currentSelection(): BoneSelection {
  return { active: selected, names: [...multi] };
}

function setSelection(next: BoneSelection): void {
  if (next.active !== selected) hideLimitFlash();
  selected = next.active;
  multi = new Set(next.names);
  renderBones();
  renderDetail();
  drawOverlay();
  drawTimeline();
  document.querySelector("#bones .bone.sel")?.scrollIntoView({ block: "nearest" });
  setup.onSelect();
  refreshStatusBar();
  if (selected && !setup.active() && !drag) {
    const hint = ikHint(selected);
    if (hint) status(hint);
  }
  hostBus.emit("pose");
}

/** Selects `name` (replacing the selection by default; "add" and "toggle" extend it) and makes it the active bone. */
function select(name: string | null, mode: SelectMode = "replace"): void {
  if (name === null) return setSelection({ active: null, names: [] });
  setSelection(selectBones(currentSelection(), [name], mode, mode === "toggle" && multi.has(name) ? undefined : name));
}

/** A press on a bone: keeps a multi-selection it belongs to (the pressed bone becomes active), else selects just it. */
function grabSelection(name: string): void {
  if (multi.has(name) && multi.size > 1) {
    if (selected !== name) setSelection({ active: name, names: [...multi] });
  } else select(name);
}

function ikChains(): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of rig?.doc.ik ?? []) for (const b of c.bones) out.set(b, c.name);
  return out;
}

/** The bone list rows in order (Shift-click selects the rows between). */
let boneRows: string[] = [];

function renderBones(): void {
  const tree = outlinerActive(workspaceNow?.() ?? "", setup.active());
  document.body.classList.toggle("ol-on", tree);
  if (tree) return renderOutliner();
  const list = $("bones");
  const filter = ($("bonefilter") as HTMLInputElement).value.trim().toLowerCase();
  list.replaceChildren();
  if (!rig) return;
  const depth = new Map<string, number>();
  const ik = ikChains();
  const t = keyTime();
  boneRows = [];
  // The Animate workspace lists only the BONE-STANDARD controls (animateBones.ts), the FK chain under "More".
  const lists = document.body.classList.contains("ws-animate") && !setup.active() ? animateBoneLists(rig.doc.bones.map((b) => b.name)) : null;
  const moreOpen = document.body.classList.contains("bones-more");
  const labels = new Map<string, AnimateBone>();
  if (lists) for (const a of [...lists.main, ...lists.more]) labels.set(a.name, a);
  const rows = lists ? [...lists.main, ...(moreOpen ? lists.more : [])] : null;
  let moreRow: HTMLElement | null = null;
  const shownBones = rows ? rows.map((a) => rig!.doc.bones.find((b) => b.name === a.name)!) : rig.doc.bones;
  for (const b of shownBones) {
    const d = rows ? 0 : b.parent ? (depth.get(b.parent) ?? 0) + 1 : 0;
    depth.set(b.name, d);
    const anim = labels.get(b.name);
    if (filter && !b.name.toLowerCase().includes(filter) && !anim?.label.toLowerCase().includes(filter)) continue;
    if (anim && !moreRow && lists!.more.some((a) => a.name === b.name)) list.append((moreRow = animateMoreRow(lists!.more.length)));
    const keys = boneKeyTimes(clip, b.name);
    const here = keys.some((k) => Math.abs(k - t) < KEY_EPSILON);
    boneRows.push(b.name);
    const row = el(
      "div",
      { className: `bone${b.name === selected ? " sel" : multi.has(b.name) ? " multi" : ""}${helperSet.has(b.name) && !anim ? " helper" : ""}`, title: `${anim ? `${b.name}: ` : ""}${b.limits ? `range ${b.limits.min}..${b.limits.max}°` : "no declared range"}${helperSet.has(b.name) ? " (helper: steers the rig, no art)" : ""}` },
      el("span", { style: `padding-left:${d * 10}px` }),
      ...(anim ? [el("span", { className: "dot", style: `background:${anim.color}` })] : []),
      anim ? anim.label : b.name,
      ...(ik.has(b.name) ? [el("span", { className: "ik", textContent: "IK" })] : []),
      ...(pending[b.name] !== undefined || pendingMove[b.name] || pendingScale[b.name] || pendingShear[b.name] ? [el("span", { className: "ik", textContent: "unkeyed", style: "color:var(--warn)" })] : []),
      el("span", { className: `k${here ? " here" : keys.length ? " has" : ""}` })
    );
    row.addEventListener("click", (e) => {
      if (e.shiftKey) setSelection(selectBones(currentSelection(), rangeBetween(boneRows, selected, b.name), "replace", b.name));
      else if (e.ctrlKey || e.metaKey) select(b.name, "toggle");
      else select(b.name);
    });
    if (setup.active()) setup.decorateRow(row, b.name);
    list.append(row);
  }
  if (lists) {
    if (!moreRow) list.append(animateMoreRow(lists.more.length));
    const all = el("button", { type: "button", className: "bones-showall", textContent: "Show all bones (Pro)" });
    all.id = "bones-showall";
    all.addEventListener("click", () => document.getElementById("ws-pro")?.click());
    const full = el("button", { type: "button", className: "bones-showall", textContent: "Show full tree", title: "Swap this list for the full Tree: bones, slots, attachments and constraints" });
    full.id = "bones-fulltree";
    full.addEventListener("click", () => setOutlinerFull(true));
    list.append(full, all);
  }
}

/** The "More" row of the Animate bone list: opens and closes the clavicles / FK chain group. */
function animateMoreRow(count: number): HTMLElement {
  const open = document.body.classList.contains("bones-more");
  const row = el("button", { type: "button", className: "bones-more-row", textContent: `${open ? "Fewer" : "More"} (${count})` });
  row.id = "bones-more";
  row.setAttribute("aria-expanded", String(open));
  row.addEventListener("click", () => {
    document.body.classList.toggle("bones-more", !open);
    renderBones();
  });
  return row;
}

let detailTimer = 0;
let detailDue = false;
/** The detail panels rebuild their DOM: during a canvas drag that happens at most every 100 ms so the render never waits on it. */
function renderDetail(): void {
  if (drag && drag.kind !== "pan" && drag.kind !== "box") {
    detailDue = true;
    if (!detailTimer) {
      detailTimer = window.setTimeout(() => {
        detailTimer = 0;
        if (detailDue) {
          detailDue = false;
          renderDetailNow();
        }
      }, 100);
    }
    return;
  }
  detailDue = false;
  renderDetailNow();
}

/** The canvas strip carries the Rotate / Translate / Scale / Shear rows in Animate and Pro: the Pose panel does not repeat them. */
function transformInStrip(): boolean {
  return document.body.classList.contains("ws-animate") || document.body.classList.contains("ws-pro");
}

function renderDetailNow(): void {
  renderIkPanel();
  renderSlotPanel();
  renderEventPanel();
  renderCurvePanel();
  const box = $("detail");
  box.replaceChildren();
  const bone = selected && skeleton ? skeleton.findBone(selected) : undefined;
  if (!bone) {
    box.append(el("h2", { textContent: "Bone" }), el("div", { className: "label", textContent: "Select a bone in the list or on the canvas." }));
    return;
  }
  const name = bone.data.name;
  const off = currentOffset(bone);
  const limits = bone.data.limits;
  const t = keyTime();
  const channels = (["rotate", "translate", "scale", "shear"] as const).filter((ch) => hasKey(clip, name, ch, t));
  box.append(
    el("h2", {}, "Bone ", el("span", { textContent: name, style: "color:var(--accent);text-transform:none;letter-spacing:0;font-size:13px" }), ...(multi.size > 1 ? [el("span", { className: "pill", textContent: `+${multi.size - 1} selected`, title: [...multi].join(", ") })] : [])),
    el(
      "div",
      { className: "kv" },
      el("span", { className: "label", textContent: "Parent" }),
      el("span", { className: "v", textContent: bone.data.parent ?? "none" }),
      el("span", { className: "label", textContent: "Setup rot" }),
      el("span", { className: "v", textContent: `${bone.data.rotation.toFixed(2)}°` }),
      ...(transformInStrip() ? [] : poseRows(getHost()!)),
      el("span", { className: "label", textContent: "Key here" }),
      el("span", { className: "v", textContent: channels.length ? channels.join(", ") : "none" }),
      el("span", { className: "label", textContent: "Keys" }),
      el("span", { className: "v", textContent: `${boneKeyTimes(clip, name).length} in clip` })
    )
  );
  if (limits) {
    const span = limits.max - limits.min || 1;
    const pos = (v: number) => `${((Math.min(limits.max, Math.max(limits.min, v)) - limits.min) / span) * 100}%`;
    const atLimit = Math.abs(off - limits.min) < 1e-3 || Math.abs(off - limits.max) < 1e-3;
    box.append(
      el(
        "div",
        { className: `range${atLimit ? " limit" : ""}`, title: "declared range (relative to setup)" },
        el("div", { className: "zero", style: `left:${pos(0)}` }),
        el("div", { className: "cur", style: `left:calc(${pos(off)} - 1px)` })
      ),
      el("div", { className: "rangelabels" }, el("span", { textContent: `${limits.min}°` }), el("span", { textContent: atLimit ? "at limit" : "range" }), el("span", { textContent: `${limits.max}°` }))
    );
  } else box.append(el("div", { className: "note", textContent: "No declared range: rotation is free." }));
  const chain = ikChains().get(name);
  if (chain && skeleton) {
    const c = skeleton.ikConstraints.find((k) => k.data.name === chain);
    const mix = c?.pose.mix ?? 0;
    if (mix > 0) box.append(el("div", { className: "note", textContent: `IK '${chain}' drives this bone (mix ${mix.toFixed(2)} here): FK rotation shows only where the clip's IK mix is 0.` }));
  }
  const row = el("div", { className: "row" });
  for (const k of boneKeyTimes(clip, name).slice(0, 24)) {
    const b = el("button", { textContent: `f${timeToFrame(clip, k)}`, title: `${k}s` });
    if (Math.abs(k - t) < KEY_EPSILON) b.classList.add("on");
    b.addEventListener("click", () => setTime(k));
    row.append(b);
  }
  if (row.childElementCount) box.append(row);
}

// ---------------------------------------------------------------------------------------------
// Curve panel: easing of the key at the playhead (to the next key)
// ---------------------------------------------------------------------------------------------

/** The keys the curve panel edits: the selected bone's keys at the playhead. */
function curveTargets(): CurveTarget[] {
  if (!selected) return [];
  const target: CurveTarget = { kind: "bone", name: selected, time: keyTime() };
  return keyCurveAt(clip, target) === undefined ? [] : [target];
}

function applyCurve(spec: CurveSpec, targets: CurveTarget[] = curveTargets()): void {
  if (!targets.length) {
    status("Select a bone that has a key at the playhead to set its curve");
    return;
  }
  const label = curveKind(spec);
  commit(setCurves(clip, targets, spec), `Curve ${CURVE_LABELS[label]} on ${targets.map((t) => t.name).join(", ")} from frame ${timeToFrame(clip, time)}`);
}

/** The keys an easing preset applies to: the selected bone and IK keys, else the selected bone's key at the playhead. */
function easingTargets(): CurveTarget[] {
  const out: CurveTarget[] = [];
  for (const k of liveSelection(clip, keySel)) {
    if (k.row.startsWith("bone:")) out.push({ kind: "bone", name: rowBone(k.row)!, time: k.time });
    else if (k.row.startsWith("ik:")) out.push({ kind: "ik", name: k.row.slice(3), time: k.time });
  }
  return out.length ? out : curveTargets();
}

function applyEasingPreset(id: EasingId, targets: CurveTarget[] = easingTargets()): void {
  if (!targets.length) {
    status("Select keys in the dopesheet (or a bone with a key at the playhead) to ease them");
    return;
  }
  const label = EASING_PRESETS.find((p) => p.id === id)?.label ?? id;
  clearPending();
  commit(applyEasing(clip, id, targets), `${label} on ${targets.length} key${targets.length === 1 ? "" : "s"}`);
}

function easingRow(): HTMLElement {
  const row = el("div", { className: "row" });
  row.id = "easingrow";
  row.append(el("span", { className: "label", textContent: "Presets" }));
  for (const p of EASING_PRESETS) {
    const b = el("button", { textContent: p.label, title: `${p.hint}. Applies to the selected keys (or this key).` });
    b.dataset.preset = p.id;
    b.addEventListener("click", () => applyEasingPreset(p.id));
    row.append(b);
  }
  return row;
}

const CURVE_Y0 = -0.5;
const CURVE_Y1 = 1.5;

function drawCurveGraph(canvas: HTMLCanvasElement, spec: CurveSpec): void {
  const w = canvas.width;
  const h = canvas.height;
  const g = canvas.getContext("2d")!;
  const X = (x: number) => 12 + x * (w - 24);
  const Y = (y: number) => h - 8 - ((y - CURVE_Y0) / (CURVE_Y1 - CURVE_Y0)) * (h - 16);
  g.clearRect(0, 0, w, h);
  g.strokeStyle = "#2d3443";
  for (const y of [0, 1]) {
    g.beginPath();
    g.moveTo(X(0), Y(y));
    g.lineTo(X(1), Y(y));
    g.stroke();
  }
  g.strokeStyle = "#3b4357";
  g.beginPath();
  g.moveTo(X(0), Y(0));
  g.lineTo(X(1), Y(1));
  g.stroke();
  g.strokeStyle = "#f0b84a";
  g.lineWidth = 2;
  g.beginPath();
  if (spec === "linear") {
    g.moveTo(X(0), Y(0));
    g.lineTo(X(1), Y(1));
  } else if (spec === "stepped") {
    g.moveTo(X(0), Y(0));
    g.lineTo(X(1), Y(0));
    g.lineTo(X(1), Y(1));
  } else {
    const b = spec as Bezier;
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      const bx = 3 * b[0] * t * (1 - t) ** 2 + 3 * b[2] * t * t * (1 - t) + t ** 3;
      const by = 3 * b[1] * t * (1 - t) ** 2 + 3 * b[3] * t * t * (1 - t) + t ** 3;
      if (i === 0) g.moveTo(X(bx), Y(by));
      else g.lineTo(X(bx), Y(by));
    }
  }
  g.stroke();
  g.lineWidth = 1;
  if (Array.isArray(spec)) {
    const b = spec as Bezier;
    g.strokeStyle = "#5fb3ff";
    for (const [px, py, qx, qy] of [[0, 0, b[0], b[1]], [1, 1, b[2], b[3]]] as const) {
      g.beginPath();
      g.moveTo(X(px), Y(py));
      g.lineTo(X(qx), Y(qy));
      g.stroke();
      g.fillStyle = "#5fb3ff";
      g.beginPath();
      g.arc(X(qx), Y(qy), 5, 0, Math.PI * 2);
      g.fill();
    }
  }
}

function renderCurvePanel(): void {
  const box = $("curvepanel");
  box.replaceChildren();
  const targets = curveTargets();
  box.append(el("h2", { textContent: "Curve (this key to the next)" }));
  if (!targets.length) {
    box.append(el("div", { className: "label", textContent: selected ? `${selected} has no key at frame ${timeToFrame(clip, time)}; move the playhead onto a key.` : "Select a bone." }), easingRow());
    return;
  }
  const spec = keyCurveAt(clip, targets[0]!) ?? "linear";
  const kind = curveKind(spec);
  const row = el("div", { className: "row", style: "margin-top: 0" });
  for (const k of ["linear", "stepped", "ease-in", "ease-out", "ease-in-out"] as const) {
    const b = el("button", { textContent: CURVE_LABELS[k], title: `${CURVE_LABELS[k]} from this key to the next` });
    if (kind === k) b.classList.add("on");
    b.addEventListener("click", () => applyCurve(CURVE_PRESETS[k]));
    row.append(b);
  }
  const custom = el("button", { textContent: "Bezier", title: "Drag the two handles, or type the control points" });
  if (kind === "bezier") custom.classList.add("on");
  custom.addEventListener("click", () => applyCurve(Array.isArray(spec) ? spec : bezier(0.42, 0, 0.58, 1)));
  row.append(custom);
  const canvas = el("canvas", { style: "margin-top: 8px; width: 100%; height: 130px" }) as HTMLCanvasElement;
  canvas.id = "curvecanvas";
  canvas.width = 640;
  canvas.height = 260;
  let live: CurveSpec = spec;
  drawCurveGraph(canvas, live);
  const nums = el("div", { className: "curvenums", style: "margin-top: 6px" });
  const inputs: HTMLInputElement[] = [];
  const bz: Bezier = Array.isArray(spec) ? (spec as Bezier) : kind === "stepped" ? [0, 0, 1, 0] : [0, 0, 1, 1];
  ["x1", "y1", "x2", "y2"].forEach((label, i) => {
    const input = el("input", { type: "number", step: "0.05", value: String(bz[i]), title: label }) as HTMLInputElement;
    input.disabled = !Array.isArray(spec);
    input.addEventListener("change", () => {
      const v = inputs.map((x) => Number(x.value));
      if (v.some((n) => !Number.isFinite(n))) return;
      applyCurve(bezier(v[0]!, v[1]!, v[2]!, v[3]!));
    });
    inputs.push(input);
    nums.append(input);
  });
  const rect = () => canvas.getBoundingClientRect();
  const fromEvent = (e: PointerEvent): { x: number; y: number } => {
    const r = rect();
    const px = ((e.clientX - r.left) / r.width) * canvas.width;
    const py = ((e.clientY - r.top) / r.height) * canvas.height;
    return { x: (px - 12) / (canvas.width - 24), y: CURVE_Y0 + ((canvas.height - 8 - py) / (canvas.height - 16)) * (CURVE_Y1 - CURVE_Y0) };
  };
  let dragging: 0 | 1 | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (!Array.isArray(live)) return;
    const p = fromEvent(e);
    const b = live as Bezier;
    const d0 = Math.hypot(p.x - b[0], (p.y - b[1]) * 0.5);
    const d1 = Math.hypot(p.x - b[2], (p.y - b[3]) * 0.5);
    dragging = d0 <= d1 ? 0 : 1;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging === null || !Array.isArray(live)) return;
    const p = fromEvent(e);
    const b = [...(live as Bezier)] as [number, number, number, number];
    b[dragging * 2] = p.x;
    b[dragging * 2 + 1] = p.y;
    live = bezier(b[0], b[1], b[2], b[3]);
    (live as Bezier).forEach((v, i) => (inputs[i]!.value = String(v)));
    drawCurveGraph(canvas, live);
  });
  canvas.addEventListener("pointerup", () => {
    if (dragging === null) return;
    dragging = null;
    applyCurve(live);
  });
  box.append(row, canvas, nums, easingRow());
}

/** Placeholder names a slot can show: every attachment name its skins define for it. */
function slotPlaceholders(slot: string): string[] {
  const out = new Set<string>();
  for (const skin of Object.values(rig?.doc.skins ?? {})) for (const name of Object.keys(skin.attachments[slot] ?? {})) out.add(name);
  return [...out];
}

function renderSlotPanel(): void {
  const box = $("slotpanel");
  box.replaceChildren();
  if (!rig) return;
  const names = rig.doc.slots.map((s) => s.name);
  if (!selectedSlot || !names.includes(selectedSlot)) selectedSlot = names.includes("eyes") ? "eyes" : (names[0] ?? null);
  const slot = selectedSlot;
  if (!slot) return;
  const t = keyTime();
  const pick = el("select", {});
  for (const n of names) pick.append(el("option", { value: n, textContent: `${n}${clip.slots[n]?.attachment ? " *" : ""}`, selected: n === slot }));
  pick.addEventListener("change", () => selectSlot(pick.value));
  const posed = skeleton?.slots.find((s) => s.data.name === slot);
  const swap = attachmentKeyAt(clip, slot, t);
  const options = slotPlaceholders(slot);
  const choice = el("select", {});
  choice.append(el("option", { value: "", textContent: "(hidden)" }));
  const current = attachmentAt(clip, slot, t);
  for (const o of options) choice.append(el("option", { value: o, textContent: o, selected: o === (swap?.name ?? current ?? posed?.placeholder) }));
  const offsets = drawOrderAt(clip, t);
  const offset = offsets.find((o) => o.slot === slot)?.offset ?? 0;
  const keyBtn = el("button", { textContent: swap ? "Replace image swap" : "Key image swap", title: "Key image swap: show the chosen image on this slot from the playhead frame on (one undo step)" });
  keyBtn.id = "slot-key-swap";
  keyBtn.addEventListener("click", () => setSlotAttachment(slot, choice.value === "" ? null : choice.value));
  const delBtn = el("button", { textContent: "Delete swap key", title: "Remove this slot's image swap key at the playhead" });
  delBtn.id = "slot-del-swap";
  delBtn.addEventListener("click", () => removeSlotAttachment(slot));
  (delBtn as HTMLButtonElement).disabled = !swap;
  const earlier = el("button", { textContent: "Earlier", title: "Draw this slot one place earlier (behind) from this frame on" });
  earlier.addEventListener("click", () => moveSlotOrder(slot, offset - 1));
  const later = el("button", { textContent: "Later", title: "Draw this slot one place later (in front) from this frame on" });
  later.addEventListener("click", () => moveSlotOrder(slot, offset + 1));
  const keyOrder = el("button", { textContent: "Key draw order", title: "Key draw order: key this slot's current place in the draw order at the playhead frame (one undo step)" });
  keyOrder.id = "slot-key-order";
  keyOrder.addEventListener("click", () => moveSlotOrder(slot, offset));
  const reset = el("button", { textContent: "Reset", title: "Key this slot back at its setup place" });
  reset.addEventListener("click", () => moveSlotOrder(slot, 0));
  const delOrder = el("button", { textContent: "Delete order key", title: "Remove the draw order key at the playhead" });
  delOrder.id = "slot-del-order";
  delOrder.addEventListener("click", () => removeDrawOrderKey());
  (delOrder as HTMLButtonElement).disabled = !drawOrderKeyAt(clip, t);
  const state = drawOrderState(rig.doc.slots.map((s) => s.name), offsets);
  const presetRow = el("div", { className: "row" });
  presetRow.id = "draworderpresets";
  presetRow.append(el("span", { className: "label", textContent: "State" }));
  const setupBtn = el("button", { textContent: "Setup order", title: "Key the rig's own draw order from this frame on" });
  if (state === "setup") setupBtn.classList.add("on");
  setupBtn.addEventListener("click", () => setDrawPreset("setup"));
  presetRow.append(setupBtn);
  for (const p of DRAW_PRESETS) {
    const r = resolveDrawPreset(rig.doc.slots.map((s) => s.name), p.id);
    const b = el("button", { textContent: p.label, title: r.applicable ? `${p.hint}. Keys it at the playhead in one click.` : `${p.hint}. Not on this rig: ${r.reason}` });
    b.dataset.preset = p.id;
    (b as HTMLButtonElement).disabled = !r.applicable;
    if (state === p.id) b.classList.add("on");
    b.addEventListener("click", () => setDrawPreset(p.id));
    presetRow.append(b);
  }
  box.append(
    el("h2", { textContent: "Slot keys (image swap and draw order)" }),
    el(
      "div",
      { className: "kv" },
      el("span", { className: "label", textContent: "Slot" }),
      el("span", { className: "v" }, pick),
      el("span", { className: "label", textContent: "Shown" }),
      el("span", { className: "v", textContent: posed ? (posed.placeholder ?? "(nothing)") : "-" }),
      el("span", { className: "label", textContent: "Swap key" }),
      el("span", { className: "v", textContent: swap ? (swap.name ?? "(hidden)") : "none here" }),
      el("span", { className: "label", textContent: "Show" }),
      el("span", { className: "v" }, choice),
      el("span", { className: "label", textContent: "Order" }),
      el("span", { className: "v", textContent: `${offset > 0 ? "+" : ""}${offset} place${Math.abs(offset) === 1 ? "" : "s"} from setup` })
    ),
    el("div", { className: "row" }, keyBtn, delBtn),
    el("div", { className: "row" }, keyOrder, earlier, later, reset, delOrder),
    presetRow,
    el("div", { className: "note", textContent: `Order state here: ${state === "custom" ? "custom offsets" : state === "setup" ? "setup order" : state}` })
  );
}


// ---------------------------------------------------------------------------------------------
// Skins panel: named sets of attachments (an outfit swaps in one click)
// ---------------------------------------------------------------------------------------------

/** The skin the panel edits (not necessarily worn), the slot whose placeholders it lists, and the add form's fields. */
let skinSel: string | null = null;
let skinSlot: string | null = null;
let skinAddName = "";
let skinTint = "";

const activeSkinNames = (): string[] => (rig ? activeList(rig.doc.skins, rig.skinChoice, rig.skinMix) : []);

function skinState(): { names: string[]; base: string | null; active: string[]; choice: string | null; mix: string[]; selected: string | null; overrides: { slot: string; placeholder: string; skin: string; covers: string[] }[]; hides: string[]; counts: Record<string, number> } | null {
  if (!rig) return null;
  const active = activeSkinNames();
  return {
    names: Object.keys(rig.doc.skins),
    base: baseSkin(rig.doc.skins) ?? null,
    active,
    choice: rig.skinChoice,
    mix: [...rig.skinMix],
    selected: skinSel,
    overrides: resolveActive(rig.doc.skins, active).filter((r) => r.covers.length > 0),
    hides: activeHides(rig.doc.skins, active),
    counts: Object.fromEntries(Object.entries(rig.doc.skins).map(([n, s]) => [n, Object.values(s.attachments).reduce((a, b) => a + Object.keys(b).length, 0)]))
  };
}

/** Remembers that the skins changed (written to the rig file by Save / Apply) and keeps Setup mode's copy of the file in step. */
function markSkinsDirty(): void {
  if (!rig) return;
  rig.skinsDirty = true;
  rig.raw = { ...rig.raw, skins: structuredClone(rig.doc.skins) as unknown as JsonObject };
  phone?.changed();
}

/** Writes the skins (and changed setup placeholders) into the open rig document when they have unsaved edits. */
async function persistSkins(): Promise<boolean> {
  if (!rig?.skinsDirty) return true;
  // : compare-and-swap on the rig file's hash, and the revision sent is captured so a skin edit made meanwhile stays dirty.
  const r = rig;
  const sent = r.doc;
  const sentSetup = { ...(r.setupEdits ?? {}) };
  const send = (base: string | null) =>
    fetch("/api/skins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: r.outfit.document, skins: sent.skins, setup: sentSetup, base }) });
  let res = await send(await setup.baseHash());
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; current?: string };
    const file = r.outfit.document.split("/").pop();
    const overwrite = await confirmDialog(
      "This rig changed in another tab/window",
      `${file}: ${body.error ?? "it changed on disk"}. Your skin edits are still here. Save them over the newer file? (The newer file is kept under Rig Versions.)`,
      "Save my skins over it"
    );
    if (!overwrite) {
      status("Skins not saved: the rig changed in another tab. Your skin edits are still here (unsaved)", "bad");
      return false;
    }
    res = await send(body.current ?? null);
  }
  if (!res.ok) {
    status(`Skins not saved: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}. Your skin edits are still here`, "bad");
    return false;
  }
  const { hash } = (await res.json().catch(() => ({}))) as { hash?: string };
  setup.rebase(hash ?? null);
  if (rig === r && r.doc === sent) {
    r.skinsDirty = false;
    r.setupEdits = {};
  } else if (rig === r) status("Skins saved; the skin edits made during the save are still unsaved");
  return true;
}

/** The whole skin state of the open rig, for skin undo / redo (). */
interface SkinState {
  outfit: string;
  doc: AnimDocument;
  setupEdits: Record<string, string | null>;
  dirty: boolean;
  choice: string | null;
  mix: string[];
  sel: string | null;
}
function skinSnapshot(): SkinState | null {
  if (!rig) return null;
  return { outfit: rig.outfit.id, doc: rig.doc, setupEdits: { ...(rig.setupEdits ?? {}) }, dirty: !!rig.skinsDirty, choice: rig.skinChoice, mix: [...rig.skinMix], sel: skinSel };
}
async function putSkinState(s: SkinState): Promise<void> {
  if (!rig || rig.outfit.id !== s.outfit) return status("Skin undo: that step belongs to another rig", "bad");
  rig.doc = s.doc;
  rig.setupEdits = { ...s.setupEdits };
  rig.skinChoice = s.choice;
  rig.skinMix = [...s.mix];
  skinSel = s.sel;
  markSkinsDirty();
  await mountOutfit(rig.outfit.id);
  skinTurn = true;
  hostBus.emit("skins");
}
/** True while the newest history step is a skin step (Ctrl+Z in the Rig workspace then undoes it instead of a Setup edit). */
let skinTurn = false;
/** Puts a skin edit on the clip / editor history as one named step: Undo / Redo restore the complete prior skin state (). */
function pushSkinStep(label: string, before: SkinState | null): void {
  const after = skinSnapshot();
  if (!before || !after) return;
  undoStack.push({ name: clipName, clip, label, skin: true, swap: { undo: () => void putSkinState(before), redo: () => void putSkinState(after) } });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  skinTurn = true;
  renderClipControls();
}

/** Replaces the rig's skins (a new document object: the runtime compiles attachments once per document) and remounts it. */
async function editSkins(change: (skins: Skins) => Skins, message: string, slots?: (s: AnimDocument["slots"]) => AnimDocument["slots"]): Promise<boolean> {
  if (!rig) return false;
  const before = skinSnapshot();
  try {
    const skins = change(rig.doc.skins);
    rig.doc = { ...rig.doc, skins, ...(slots ? { slots: slots(rig.doc.slots) } : {}) };
    markSkinsDirty();
    if (rig.skinChoice && !(rig.skinChoice in skins)) rig.skinChoice = null;
    rig.skinMix = rig.skinMix.filter((n) => n in skins);
    if (skinSel && !(skinSel in skins)) skinSel = null;
    await mountOutfit(rig.outfit.id);
    pushSkinStep(message, before);
    status(message, "ok");
    return true;
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), "bad");
    return false;
  }
}

async function renameSkin(name: string, to: string): Promise<boolean> {
  if (!rig) return false;
  const before = skinSnapshot();
  try {
    const doc = renameSkinInDocument(rig.doc, name, to);
    rig.doc = doc;
    markSkinsDirty();
    if (rig.skinChoice === name) rig.skinChoice = to;
    rig.skinMix = rig.skinMix.map((n) => (n === name ? to : n));
    if (skinSel === name) skinSel = to;
    await mountOutfit(rig.outfit.id);
    pushSkinStep(`Rename skin ${name} to ${to}`, before);
    status(`Skin ${name} renamed to ${to}`, "ok");
    return true;
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), "bad");
    return false;
  }
}

/** Wears `name` on top of the base (null = the base alone). The same document, so the skeleton only re-resolves its slots. */
function setActiveSkin(name: string | null): void {
  if (!rig || !skeleton) return;
  if (name !== null && !(name in rig.doc.skins)) {
    status(`No skin ${name}`, "bad");
    return;
  }
  rig.skinChoice = name === baseSkin(rig.doc.skins) ? null : name;
  rig.skinMix = rig.skinMix.filter((n) => n !== name);
  applyActiveSkins();
}

/** Adds or removes `name` as an extra layer between the base and the worn skin. */
function mixSkin(name: string, on: boolean): void {
  if (!rig || !skeleton || name === baseSkin(rig.doc.skins) || !(name in rig.doc.skins)) return;
  rig.skinMix = on ? [...rig.skinMix.filter((n) => n !== name), name] : rig.skinMix.filter((n) => n !== name);
  if (on && rig.skinChoice === name) rig.skinChoice = null;
  applyActiveSkins();
}

function applyActiveSkins(): void {
  if (!rig || !skeleton) return;
  // The character's own method: it re-resolves the skeleton and stages the textures and drawables of the new outfit.
  (character ?? skeleton).setActiveSkins(activeSkinNames());
  markPose();
  renderAll();
  phone?.changed();
  status(wearingText(activeSkinNames()), "ok");
  hostBus.emit("skins");
}

/**
 * Adds (or replaces) the attachment a skin shows for `placeholder` of `slot`: a copy of what another skin has for
 * `from.placeholder` (default: the same placeholder), optionally tinted. Clips key the placeholder name, so one clip
 * works for every skin that defines it.
 */
function addSkinAttachment(skin: string, slot: string, placeholder: string, from: { skin: string; placeholder?: string }, tint?: string): Promise<boolean> {
  return editSkins((skins) => {
    let next = copySkinAttachment(skins, from.skin, slot, from.placeholder ?? placeholder, skin, placeholder);
    if (tint) {
      const a = next[skin]!.attachments[slot]![placeholder] as AttachmentData;
      next = setSkinAttachment(next, skin, slot, placeholder, tintedAttachment(a, tint.replace(/^#/, "").padEnd(8, "f")));
    }
    return next;
  }, `${skin}: ${slot}/${placeholder} set from ${from.skin}`);
}

function setSetup(slot: string, placeholder: string | null): Promise<boolean> {
  if (rig) rig.setupEdits = { ...rig.setupEdits, [slot]: placeholder };
  return editSkins((s) => s, `${slot}: setup placeholder ${placeholder ?? "(none)"}`, (slots) => setSetupPlaceholder(slots, slot, placeholder));
}

function exportSkinsFile(): void {
  if (!rig) return;
  const out = skinsToSpine(rig.doc);
  const url = URL.createObjectURL(new Blob([JSON.stringify({ skins: out.skins, images: out.images }, null, 2)], { type: "application/json" }));
  const a = el("a", { href: url, download: `${rig.doc.name}.skins.json` });
  a.click();
  URL.revokeObjectURL(url);
  status(`Exported ${out.skins.length} Spine skins${out.warnings.length ? ` (${out.warnings.length} warnings: ${out.warnings[0]})` : ""}`, out.warnings.length ? "" : "ok");
}

function renderSkinPanel(): void {
  const box = $("skinpanel");
  box.replaceChildren();
  if (!rig) return;
  const skins = rig.doc.skins;
  const names = Object.keys(skins);
  const base = baseSkin(skins);
  if (!skinSel || !(skinSel in skins)) skinSel = rig.skinChoice ?? base ?? null;
  const active = activeSkinNames();
  const sel = skinSel;
  box.append(el("h2", { textContent: "Skins" }));
  for (const n of names) {
    const worn = rig.skinChoice === n || (n === base && !rig.skinChoice);
    const row = el("div", { className: `skinrow${n === sel ? " sel" : ""}` });
    row.dataset.skin = n;
    const wear = el("button", { textContent: worn ? "Worn" : "Wear", title: n === base ? "Show the base skin alone" : "Wear this skin on top of the base skin (one click swaps the outfit)" });
    wear.classList.toggle("on", worn);
    wear.addEventListener("click", (e) => {
      e.stopPropagation();
      setActiveSkin(n === base ? null : n);
    });
    row.append(el("span", { className: "name", textContent: n }), el("span", { className: "tag", textContent: n === base ? "base" : active.includes(n) ? (rig.skinMix.includes(n) ? "mixed" : "worn") : "" }));
    if (n !== base) {
      const mix = el("input", { type: "checkbox", checked: rig.skinMix.includes(n), title: "Mix: layer this skin between the base and the worn skin (later skins win)" });
      mix.addEventListener("click", (e) => e.stopPropagation());
      mix.addEventListener("change", () => mixSkin(n, mix.checked));
      row.append(mix);
    }
    row.append(wear);
    row.addEventListener("click", () => {
      skinSel = n;
      renderSkinPanel();
    });
    box.append(row);
  }
  const nameBox = el("input", { type: "text", placeholder: "skin name", size: 14, value: "" });
  nameBox.id = "skinname";
  const act = (fn: (name: string) => Promise<boolean> | void) => () => void fn(nameBox.value.trim());
  const mk = (label: string, title: string, fn: () => unknown, off = false) => {
    const b = el("button", { textContent: label, title });
    (b as HTMLButtonElement).disabled = off;
    b.addEventListener("click", () => void fn());
    return b;
  };
  box.append(
    el(
      "div",
      { className: "row" },
      nameBox,
      mk("New", "Create an empty skin with this name", () => editSkins((s) => createSkin(s, nameBox.value.trim()), `Skin ${nameBox.value.trim()} created`).then((ok) => ok && (skinSel = nameBox.value.trim()) && renderSkinPanel())),
      mk("Rename", "Rename the selected skin to this name (references follow)", act((to) => (sel ? renameSkin(sel, to) : undefined)), !sel),
      mk("Duplicate", "Copy the selected skin (to this name, or name-copy)", () => {
        if (!sel) return;
        const to = nameBox.value.trim() || uniqueSkinName(skins, `${sel}-copy`);
        return editSkins((s) => duplicateSkin(s, sel, to), `Skin ${sel} duplicated as ${to}`).then((ok) => ok && (skinSel = to) && renderSkinPanel());
      }, !sel),
      mk("Delete", "Delete the selected skin", () => sel && editSkins((s) => deleteSkin(s, sel), `Skin ${sel} deleted`), !sel || names.length < 2),
      mk("Export Spine skins", "Download every skin as Spine skins JSON (the CLI exporter writes the same skins into the full skeleton)", exportSkinsFile)
    )
  );
  const mixed = resolveActive(skins, active).filter((r) => r.covers.length > 0);
  box.append(el("div", { className: "note", textContent: `Showing ${active.join(" + ")}${mixed.length ? `: ${mixed.length} placeholder${mixed.length === 1 ? "" : "s"} replaced (${mixed.slice(0, 3).map((r) => `${r.slot}/${r.placeholder}`).join(", ")}${mixed.length > 3 ? ", ..." : ""})` : ""}` }));
  if (!sel) return;

  // Attachments of the selected skin, per slot.
  const slotNames = rig.doc.slots.map((s) => s.name);
  if (!skinSlot || !slotNames.includes(skinSlot)) skinSlot = slotNames.includes("shirt_torso") ? "shirt_torso" : (slotNames[0] ?? null);
  const slot = skinSlot;
  if (!slot) return;
  const slotPick = el("select", {});
  for (const n of slotNames) {
    const own = Object.keys(skins[sel]!.attachments[n] ?? {}).length;
    slotPick.append(el("option", { value: n, textContent: `${n}${own ? ` (${own})` : ""}`, selected: n === slot }));
  }
  slotPick.addEventListener("change", () => {
    skinSlot = slotPick.value;
    renderSkinPanel();
  });
  const setup = rig.doc.slots.find((s) => s.name === slot)?.attachment ?? null;
  const holders = slotPlaceholderSkins(skins, slot);
  const setupPick = el("select", {});
  setupPick.append(el("option", { value: "", textContent: "(none)", selected: setup === null }));
  for (const p of holders.keys()) setupPick.append(el("option", { value: p, textContent: p, selected: p === setup }));
  setupPick.addEventListener("change", () => void setSetup(slot, setupPick.value === "" ? null : setupPick.value));
  box.append(
    el("div", { className: "kv", style: "margin-top: 8px" }, el("span", { className: "label", textContent: `${sel} slot` }), el("span", { className: "v" }, slotPick), el("span", { className: "label", textContent: "Setup placeholder" }), el("span", { className: "v" }, setupPick))
  );
  const hidden = skins[sel]!.hides.includes(slot);
  const hideBox = el("input", { type: "checkbox", checked: hidden });
  hideBox.addEventListener("change", () => void editSkins((s) => setSkinHide(s, sel, slot, hideBox.checked), `${sel}: ${slot} ${hideBox.checked ? "hidden" : "shown"} while worn`));
  box.append(el("label", { className: "phrow", title: "While this skin is worn the slot draws nothing (a helmet hides the hair)" }, hideBox, "hide this slot while worn"));
  const winners = new Map(resolveActive(skins, active).filter((r) => r.slot === slot).map((r) => [r.placeholder, r.skin]));
  for (const [placeholder, from] of holders) {
    const has = from.includes(sel);
    const row = el("div", { className: `phrow${winners.get(placeholder) === sel ? " won" : ""}` });
    row.dataset.placeholder = placeholder;
    row.append(el("span", { className: "name", textContent: placeholder, title: `Clips key the placeholder name. Defined by: ${from.join(", ")}. Shown from: ${winners.get(placeholder) ?? "no worn skin"}` }), el("span", { className: "tag", textContent: from.join(", ") }));
    if (has) row.append(mk("Remove", `Remove ${placeholder} from ${sel}`, () => editSkins((s) => removeSkinAttachment(s, sel, slot, placeholder), `${sel}: removed ${slot}/${placeholder}`)));
    else row.append(mk("Add", `Give ${sel} its own ${placeholder} (a copy of ${from[0]}'s; tint below)`, () => addSkinAttachment(sel, slot, placeholder, { skin: from[0]! }, skinTint || undefined)));
    box.append(row);
  }
  const tint = el("input", { type: "text", placeholder: "tint RRGGBB", size: 9, value: skinTint, title: "Optional colour multiplied over the copied attachment (e.g. a0522d)" });
  tint.addEventListener("input", () => (skinTint = tint.value.trim()));
  const nameIn = el("input", { type: "text", placeholder: "new placeholder", size: 12, value: skinAddName, title: "A new placeholder name for this slot, copied from the first placeholder the slot has" });
  nameIn.addEventListener("input", () => (skinAddName = nameIn.value.trim()));
  const first = [...holders.entries()][0];
  box.append(
    el(
      "div",
      { className: "row" },
      nameIn,
      tint,
      mk("Add new", "Add the new placeholder to this skin as a copy of the slot's first placeholder", () => first && addSkinAttachment(sel, slot, skinAddName, { skin: first[1][0]!, placeholder: first[0] }, skinTint || undefined), !first)
    )
  );
}

// ---------------------------------------------------------------------------------------------
// Smear tool: a weapon smear attachment from two frames of a swing
// ---------------------------------------------------------------------------------------------

interface SmearMeta {
  format: "atlas-smear@1";
  name: string;
  slot: string;
  /** The placeholder name the weapon slot is keyed to (e.g. weapon__smear_a). */
  attachment: string;
  path: string;
  region: { x: number; y: number; rotation: number; scaleX: number; scaleY: number; width: number; height: number; opaque?: number[] };
  from: number;
  to: number;
  show: number;
  steps: number;
  stretch: number;
}

const SMEAR_URL = "/repo/packages/animator-editor/smears";

/** The saved smears (dev server), loaded into the stand-in rig's extra images before its document is built. */
async function loadSavedSmears(extra: Map<string, RgbaImage>): Promise<SmearMeta[]> {
  const out: SmearMeta[] = [];
  try {
    const names = (await fetch("/api/smears").then((r) => r.json())) as string[];
    for (const n of names) {
      const meta = (await fetch(`${SMEAR_URL}/${n}.smear.json?v=${Date.now()}`).then((r) => r.json())) as SmearMeta;
      extra.set(meta.path, await loadRgbaImage(`${SMEAR_URL}/${n}.smear.png?v=${Date.now()}`));
      out.push(meta);
    }
  } catch (error) {
    console.error("smears not loaded", error);
  }
  return out;
}

/** Adds each saved smear as a region attachment of its slot in the document's first skin. */
function withSmears(json: unknown, smears: readonly SmearMeta[]): unknown {
  const doc = json as { skins: Record<string, { attachments: Record<string, Record<string, unknown>> }> };
  const skin = doc.skins.body ?? Object.values(doc.skins)[0];
  if (!skin) return json;
  for (const m of smears) (skin.attachments[m.slot] ??= {})[m.attachment] = { type: "region", path: m.path, ...m.region };
  return json;
}

/** The decoded pixels of a texture path: an editor-made image, else a copy of its atlas rectangle. */
function imageOfPath(path: string): RgbaImage | null {
  const own = rig?.extra.get(path);
  if (own) return own;
  const src = rig?.images.get(path);
  if (!src) return null;
  const { pixels, rect } = src;
  const data = new Uint8Array(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.y + y) * pixels.width + rect.x) * 4;
    data.set(pixels.data.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return { width: rect.width, height: rect.height, data };
}

function pngOf(image: RgbaImage): string {
  const c = document.createElement("canvas");
  c.width = image.width;
  c.height = image.height;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return c.toDataURL("image/png");
}

let lastSmear: { meta: SmearMeta; png: string; hullPx: number; inkPx: number } | null = null;

interface SmearRequest {
  /** The two frames the smear spans (the swing's start and end), and the frame it is shown on (default: `to`). */
  from: number;
  to: number;
  show?: number;
  /** Variant letter(s): the attachment is `<slot>__smear_<variant>` (default a). */
  variant?: string;
  slot?: string;
  steps?: number;
  stretch?: number;
  /** Add sub-steps on a long arc so the hull stays connected (default true); false keeps exactly `steps`. */
  densify?: boolean;
  save?: boolean;
}

async function makeSmear(req: SmearRequest): Promise<{ name: string; attachment: string; width: number; height: number; hullPx: number; inkPx: number; png: string } | null> {
  if (!rig || !skeleton) return null;
  const slotName = req.slot ?? "weapon";
  const slot = skeleton.findSlot(slotName);
  if (!slot) {
    status(`This rig has no ${slotName} slot to smear`, "bad");
    return null;
  }
  try {
    assertWeaponSlot(slotName, slot.bone.data.name);
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), "bad");
    return null;
  }
  const baseName = slot.data.attachment;
  const base = baseName ? Object.values(rig.doc.skins).map((sk) => sk.attachments[slotName]?.[baseName]).find((a) => a?.type === "region") : undefined;
  if (!base || base.type !== "region") {
    status(`${slotName} has no region attachment to smear`, "bad");
    return null;
  }
  const image = imageOfPath(base.path);
  if (!image) {
    status(`No image for ${base.path}`, "bad");
    return null;
  }
  const wanted = Math.max(2, req.steps ?? SMEAR_STEPS);
  const bone = slot.bone;
  // Sample the swing densely, then keep the sub-steps that lie evenly along the tip's arc (about 6, more on a long arc).
  const dense: Affine[] = [];
  const denseTips: { x: number; y: number }[] = [];
  for (const t of smearTimes(clip, req.from, req.to, 60)) {
    applyPoseAt(Math.min(clip.duration, t), false);
    dense.push({ a: bone.world.a, b: bone.world.b, c: bone.world.c, d: bone.world.d, tx: bone.world.x, ty: bone.world.y });
    const e = boneEnds(bone);
    denseTips.push({ x: e.tx, y: e.ty });
  }
  const picked = pickByArc(denseTips, wanted, req.densify !== false);
  const steps = picked.map((i) => dense[i]!);
  const tips = picked.map((i) => denseTips[i]!);
  const n = steps.length;
  const showFrame = req.show ?? req.to;
  applyPoseAt(Math.min(clip.duration, frameTime(clip, showFrame)), false);
  const show: Affine = { a: bone.world.a, b: bone.world.b, c: bone.world.c, d: bone.world.d, tx: bone.world.x, ty: bone.world.y };
  applyPoseAt(displayTime(), true);
  const placement: RegionPlacement = { x: base.x, y: base.y, rotation: base.rotation, scaleX: base.scaleX, scaleY: base.scaleY, width: base.width, height: base.height };
  const stretch = req.stretch ?? SMEAR_STRETCH;
  const first = tips[0]!;
  const last = tips[tips.length - 1]!;
  let result;
  try {
    result = renderSmear({ image, region: placement, steps, show, travel: { x: last.x - first.x, y: last.y - first.y }, stretch, ink: { color: STOCK_INK, width: STOCK_INK_WIDTH } });
  } catch (error) {
    status(`Smear failed: ${error instanceof Error ? error.message : String(error)}`, "bad");
    return null;
  }
  const variant = req.variant ?? "a";
  const attachment = `${slotName}__smear_${variant}`;
  const path = `${base.path}__smear_${variant}`;
  const name = `${rig.outfit.id}__${attachment}`;
  const meta: SmearMeta = { format: "atlas-smear@1", name, slot: slotName, attachment, path, region: result.region, from: req.from, to: req.to, show: showFrame, steps: n, stretch };
  const png = pngOf(result.image);
  if (req.save !== false) {
    const res = await fetch(`/api/smears/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ meta, png }) });
    if (!res.ok) status(`Smear not saved to disk: ${((await res.json()) as { error?: string }).error ?? res.status}`, "bad");
  }
  // Register it in the live rig: the skin gets the attachment, the image joins the rig's own images, the skeleton is rebuilt.
  // The runtime compiles attachments once per document object, so the rig gets a new document object carrying the new skin data.
  const skins = structuredClone(rig.doc.skins);
  for (const skin of Object.values(skins)) {
    if (skin.attachments[slotName]?.[baseName!]) skin.attachments[slotName]![attachment] = { type: "region", path, ...result.region, color: "ffffffff" } as never;
  }
  rig.doc = { ...rig.doc, skins };
  rig.extra.set(path, result.image);
  await mountOutfit(rig.outfit.id);
  clearPending();
  commit(keySmear(clip, slotName, bone.data.name, attachment, baseName, showFrame), `Smear ${attachment} keyed on frame ${showFrame}, ${baseName} back on frame ${showFrame + 1}`);
  lastSmear = { meta, png, hullPx: result.hullPx, inkPx: result.inkPx };
  renderSmearPanel();
  return { name, attachment, width: result.image.width, height: result.image.height, hullPx: result.hullPx, inkPx: result.inkPx, png };
}

async function deleteSmear(name: string, ask = true): Promise<boolean> {
  if (ask && !(await confirmDialog(`Delete smear ${name}?`, `This deletes the smear files ${name}.smear.json and .png from disk. It cannot be undone.`, "Delete"))) return false;
  const res = await fetch(`/api/smears/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
  if (!res?.ok) {
    const message = res ? await apiError(res) : "the editor server is not answering";
    status(`Smear ${name} not deleted: ${message}`, "bad");
    showToast(`Smear ${name} not deleted: ${message}`, "bad");
    return false;
  }
  status(`Deleted smear file ${name} (it leaves the rig on the next reload)`, "ok");
  return true;
}

function renderSmearPanel(): void {
  const box = $("smearpanel");
  box.replaceChildren();
  if (!rig) return;
  box.append(el("h2", { textContent: "Smear (weapon swing)" }));
  if (!rig.outfit.standInWeapon) {
    box.append(el("div", { className: "note", textContent: "Needs a rig with a weapon slot. Open Turned L + axe." }));
    return;
  }
  const here = timeToFrame(clip, time);
  const mk = (value: number, title: string) => {
    const i = el("input", { type: "number", value: String(value), step: "1", min: "0", title }) as HTMLInputElement;
    i.style.width = "56px";
    return i;
  };
  const from = mk(Math.max(0, here - 4), "Frame the swing starts on");
  const to = mk(here, "Frame the swing ends on (the smear shows here)");
  const variant = el("input", { value: "a", size: 3, title: "Variant letter: weapon__smear_<letter>" }) as HTMLInputElement;
  const go = el("button", { textContent: "Make smear", title: "Render the weapon at 6 sub-steps along the arc, union, stretch 15%, ink with the stock outline, key it on the end frame" });
  go.id = "makesmear";
  go.addEventListener("click", () => void makeSmear({ from: Number(from.value), to: Number(to.value), variant: variant.value.trim() || "a" }));
  box.append(el("div", { className: "row", style: "margin-top: 0" }, el("span", { className: "label", textContent: "From" }), from, el("span", { className: "label", textContent: "to" }), to, variant, go));
  if (lastSmear) {
    const img = el("img", { src: lastSmear.png, alt: lastSmear.meta.attachment }) as HTMLImageElement;
    img.style.cssText = "max-width: 100%; max-height: 160px; margin-top: 8px; background: #f0ece2; border-radius: 4px; image-rendering: pixelated";
    box.append(img, el("div", { className: "note", textContent: `${lastSmear.meta.attachment}: ${lastSmear.meta.region.width}x${lastSmear.meta.region.height} px, frames ${lastSmear.meta.from}-${lastSmear.meta.to} (${lastSmear.meta.steps} sub-steps, ${(lastSmear.meta.stretch * 100).toFixed(0)}% stretch)` }));
  }
}

// ---------------------------------------------------------------------------------------------
// Root and foot lock: pin a foot to the ground (or hold the root) across a frame range
// ---------------------------------------------------------------------------------------------

let lockRange: { a: number; b: number } | null = null;

/** The IK constraint and target bone of a leg, by the rig's `foot_<side>_target` convention. */
function footIk(side: Side): { ik: string; target: string } | null {
  const c = rig?.doc.ik.find((i) => i.target === `${sn("foot", side)}_target`);
  return c ? { ik: c.name, target: c.target } : null;
}

/** The foot's world position at a frame (as posed by the clip, the playhead pose is restored). */
function footAt(side: Side, frameNo: number): { x: number; y: number } | null {
  const foot = skeleton?.findBone(sn("foot", side));
  if (!foot) return null;
  applyPoseAt(Math.min(clip.duration, frameTime(clip, frameNo)), false);
  const out = { x: foot.world.x, y: foot.world.y };
  applyPoseAt(displayTime(), true);
  return out;
}

function lockFrames(): { a: number; b: number } {
  const n = frameCount(clip);
  const here = timeToFrame(clip, time);
  return lockRange ?? (playRange ? { a: playRange.a, b: playRange.b } : { a: here, b: Math.min(n, here + 8) });
}

function lockFootRange(side: Side, a: number, b: number): boolean {
  const legs = footIk(side);
  const target = legs && skeleton?.findBone(legs.target);
  const spot = footAt(side, a);
  if (!legs || !target || !spot) {
    status(`This rig has no ${side.toUpperCase()} foot IK to lock`, "bad");
    return false;
  }
  const local = { x: 0, y: 0 };
  target.worldToParent(spot.x, spot.y, local);
  clearPending();
  commit(lockFoot(clip, { ...legs, a, b, x: local.x - target.data.x, y: local.y - target.data.y }), `Locked foot ${side.toUpperCase()} to the ground, frames ${a}-${b}`);
  return true;
}

function unlockFootRange(side: Side, a: number, b: number): void {
  const legs = footIk(side);
  if (!legs) return;
  commit(unlockFoot(clip, legs.ik, legs.target, a, b), `Unlocked foot ${side.toUpperCase()}, frames ${a}-${b}`);
}

function lockRootRange(a: number, b: number, boneName = "root"): boolean {
  const bone = skeleton?.findBone(boneName);
  if (!bone) return false;
  applyPoseAt(Math.min(clip.duration, frameTime(clip, a)), false);
  const x = bone.pose.x - bone.data.x;
  const y = bone.pose.y - bone.data.y;
  applyPoseAt(displayTime(), true);
  clearPending();
  commit(lockRoot(clip, boneName, a, b, x, y), `Held ${boneName} still, frames ${a}-${b}`);
  return true;
}

/** How far the foot strays from where it stood on frame a, over frames a..b (px). */
function footDrift(side: Side, a: number, b: number): number {
  const samples: { x: number; y: number }[] = [];
  for (let f = a; f <= b; f++) {
    const p = footAt(side, f);
    if (p) samples.push(p);
  }
  return maxDrift(samples);
}

function renderLockPanel(): void {
  const box = $("lockpanel");
  box.replaceChildren();
  if (!rig) return;
  const r = lockFrames();
  const from = el("input", { type: "number", value: String(r.a), min: "0", step: "1", title: "First locked frame" }) as HTMLInputElement;
  const to = el("input", { type: "number", value: String(r.b), min: "0", step: "1", title: "Last locked frame" }) as HTMLInputElement;
  from.style.width = to.style.width = "56px";
  const range = () => ({ a: Math.max(0, Math.round(Number(from.value))), b: Math.max(0, Math.round(Number(to.value))) });
  const sync = () => (lockRange = range());
  from.addEventListener("change", sync);
  to.addEventListener("change", sync);
  const row = el("div", { className: "row", style: "margin-top: 0" }, el("span", { className: "label", textContent: "Frames" }), from, el("span", { className: "label", textContent: "to" }), to);
  const legs = el("div", { className: "row" });
  for (const side of ["l", "r"] as const) {
    if (!footIk(side)) continue;
    const lock = el("button", { textContent: `Lock foot ${side.toUpperCase()}`, title: "Pin this foot where it stands on the first frame, across the range (leg IK, target held)" });
    lock.id = `lockfoot-${side}`;
    lock.addEventListener("click", () => {
      const q = range();
      lockFootRange(side, q.a, q.b);
    });
    const un = el("button", { textContent: "Unlock", title: "Remove this foot's lock keys in the range" });
    un.addEventListener("click", () => {
      const q = range();
      unlockFootRange(side, q.a, q.b);
    });
    legs.append(lock, un);
  }
  const hold = el("button", { textContent: "Hold root", title: "Keep the root bone at its first-frame position across the range" });
  hold.id = "lockroot";
  hold.addEventListener("click", () => {
    const q = range();
    lockRootRange(q.a, q.b);
  });
  legs.append(hold);
  box.append(el("h2", { textContent: "Root and foot lock" }), row, legs);
  const found: string[] = [];
  for (const side of ["l", "r"] as const) {
    const l = footIk(side);
    if (l) for (const q of footLockRanges(clip, l.ik)) found.push(`foot ${side.toUpperCase()} locked ${q.a}-${q.b}`);
  }
  box.append(el("div", { className: "note", textContent: found.length ? found.join("; ") : "No locks in this clip." }));
}

// ---------------------------------------------------------------------------------------------
// Silhouette preview: the character flat black on a light ground, to judge readability
// ---------------------------------------------------------------------------------------------

const SILHOUETTE_GROUND = 0xe8e4da;
let silhouette = false;
let silhouetteSaved: number | null = null;
const silhouetteFilter = new ColorMatrixFilter();
// rgb = 0, alpha kept: every pixel the character draws becomes black with its own coverage.
silhouetteFilter.matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0];

/** Applies the current silhouette state to the mounted character (called again after the rig is remounted). */
function applySilhouette(): void {
  if (character) character.filters = silhouette ? [silhouetteFilter] : [];
  $("silhouette").classList.toggle("on", silhouette);
  requestRender();
}

function setSilhouette(on?: boolean): boolean {
  const next = on ?? !silhouette;
  if (next === silhouette) return silhouette;
  silhouette = next;
  if (next) {
    silhouetteSaved = background;
    background = SILHOUETTE_GROUND;
  } else if (silhouetteSaved !== null) {
    background = silhouetteSaved;
    silhouetteSaved = null;
  }
  app.renderer.background.color = background;
  applySilhouette();
  markPose();
  return silhouette;
}

/** Reads the stage back and reports how much of it is neither the ground nor black (0 when the silhouette is flat). */
function silhouetteReport(): { on: boolean } & SilhouetteStats {
  const was = overlay.visible;
  overlay.visible = false;
  const hidden = world.children.filter((c) => c !== character && c.visible);
  for (const c of hidden) c.visible = false;
  try {
    app.renderer.render(app.stage);
    const { pixels } = app.renderer.extract.pixels({ target: app.stage });
    return { on: silhouette, ...silhouetteStats(pixels, background) };
  } finally {
    overlay.visible = was;
    for (const c of hidden) c.visible = true;
    markPose();
  }
}

// ---------------------------------------------------------------------------------------------
// Pose library: named poses (bones, attachment swaps, draw order) saved on disk and applied to any clip
// ---------------------------------------------------------------------------------------------

type LibraryPose = { pose: PoseRecord; thumb: string };
let poseLib: LibraryPose[] = [];
let poseParts = { bones: true, attachments: true, order: true };
/** Show the built-in poses made for the other pro rig too. */
let showOtherRigs = false;
const THUMB_W = 300;
const THUMB_H = 490;
const THUMB_SCALE = 0.4;
let thumbTexture: RenderTexture | null = null;

/** The posed character alone at game scale 0.4 as a PNG data URL (the library thumbnail). */
function captureThumb(): string {
  if (!character) return "";
  thumbTexture ??= RenderTexture.create({ width: THUMB_W, height: THUMB_H, resolution: 1 });
  const saved = { x: world.x, y: world.y, sx: world.scale.x, sy: world.scale.y };
  const hidden = world.children.filter((c) => c !== character && c.visible);
  for (const c of hidden) c.visible = false;
  try {
    applyPoseAt(displayTime(), true);
    world.scale.set(THUMB_SCALE);
    // Centred on the rig's own column, the ground (the root bone, plus the sole under it) 16 px above the bottom edge, so poses compare by height.
    const ground = (skeleton?.findBone("root")?.world.y ?? 0) + 70;
    world.position.set(THUMB_W / 2, THUMB_H - 16 - ground * THUMB_SCALE);
    app.renderer.render({ container: app.stage, target: thumbTexture, clear: true, clearColor: background });
    return (app.renderer.extract.canvas(thumbTexture) as unknown as HTMLCanvasElement).toDataURL("image/png");
  } finally {
    for (const c of hidden) c.visible = true;
    world.position.set(saved.x, saved.y);
    world.scale.set(saved.sx, saved.sy);
    markPose();
  }
}

/** The pose at the playhead as a library record. */
function capturePose(name: string, note?: string, extra: { builtin?: boolean; rig?: string } = {}, include: PoseInclude = scopeDefaults("character"), only: readonly string[] | null = null): PoseRecord {
  const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  const attachments: Record<string, string | null> = {};
  const colors: Record<string, string> = {};
  if (include.slots) {
    for (const slot of skeleton?.slots ?? []) {
      const keyed = !!clip.slots[slot.data.name]?.attachment?.length;
      if (keyed || slot.placeholder !== slot.data.attachment) attachments[slot.data.name] = slot.placeholder;
      const c = slot.color;
      const s = slot.setupColor;
      if (Math.abs(c.r - s.r) + Math.abs(c.g - s.g) + Math.abs(c.b - s.b) + Math.abs(c.a - s.a) > 1e-3 || clip.slots[slot.data.name]?.color?.length) colors[slot.data.name] = `${hex(c.r)}${hex(c.g)}${hex(c.b)}${hex(c.a)}`;
    }
  }
  const mixes: PoseMixes = { ik: {}, transform: {} };
  if (include.mixes) {
    for (const c of skeleton?.ikConstraints ?? []) if (clip.ik[c.data.name]?.length || Math.abs(c.pose.mix - c.data.mix) > 1e-4) mixes.ik[c.data.name] = c.pose.mix;
    for (const c of skeleton?.transformConstraints ?? []) {
      const fields = { mixRotate: c.pose.mixRotate, mixX: c.pose.mixX, mixY: c.pose.mixY, mixScaleX: c.pose.mixScaleX, mixScaleY: c.pose.mixScaleY, mixShearY: c.pose.mixShearY };
      const d = c.data as unknown as Record<string, number>;
      if (clip.transform[c.data.name]?.length || Object.entries(fields).some(([k, v]) => Math.abs(v - (d[k] ?? 1)) > 1e-4)) mixes.transform[c.data.name] = fields;
    }
  }
  const deform: PoseDeform[] = [];
  if (include.deforms) {
    const t = keyTime();
    for (const [skin, slots] of Object.entries(clip.deform)) {
      for (const [slot, atts] of Object.entries(slots)) {
        for (const [attachment, keys] of Object.entries(atts)) {
          const key = [...keys].reverse().find((k) => k.time <= t + 1e-4);
          if (key) deform.push({ skin, slot, attachment, offset: key.offset, vertices: [...key.vertices] });
        }
      }
    }
  }
  let bones = currentPoseCopy({ root: include.root, shear: include.shear });
  if (only) bones = Object.fromEntries(Object.entries(bones).filter(([b]) => only.includes(b)));
  const includes = (Object.keys(include) as (keyof PoseInclude)[]).filter((k) => include[k]);
  return makePose({ name, bones, attachments, drawOrder: include.drawOrder ? drawOrderAt(clip, keyTime()) : [], mixes, colors, deform, includes, note, ...extra });
}

async function refreshPoses(): Promise<void> {
  try {
    const names = (await fetch("/api/poses").then((r) => r.json())) as string[];
    const loaded: LibraryPose[] = [];
    for (const n of names) {
      const raw = (await fetch(`/repo/packages/animator-editor/poses/${n}.pose.json?v=${Date.now()}`).then((r) => r.json())) as unknown;
      loaded.push({ pose: parsePose(raw), thumb: `/repo/packages/animator-editor/poses/${n}.pose.png?v=${Date.now()}` });
    }
    poseLib = loaded;
  } catch (error) {
    status(`Pose library unavailable: ${error instanceof Error ? error.message : String(error)}`, "bad");
  }
  renderPoseLibrary();
}

async function savePose(name: string, note?: string): Promise<PoseRecord | null> {
  if (poseLib.find((p) => p.pose.name === name)?.pose.builtin) {
    status(`${name} is a built-in pose (read-only): pick another name`, "bad");
    return null;
  }
  if (!POSE_NAME.test(name)) {
    status("Pose names use letters, digits, _ and - (up to 48 characters)", "bad");
    return null;
  }
  const record = capturePose(name, note);
  const res = await fetch(`/api/poses/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pose: record, png: captureThumb() }) });
  if (!res.ok) {
    status(`Pose not saved: ${((await res.json()) as { error?: string }).error ?? res.status}`, "bad");
    return null;
  }
  await refreshPoses();
  status(`Saved pose ${name} (${poseSummary(record)})`, "ok");
  return record;
}

async function deletePose(name: string, ask = true): Promise<void> {
  if (poseLib.find((p) => p.pose.name === name)?.pose.builtin) {
    status(`${name} is a built-in pose (read-only)`, "bad");
    return;
  }
  if (ask && !(await confirmDialog(`Delete pose ${name}?`, `This deletes the pose ${name} from the pose library on disk. It cannot be undone.`, "Delete"))) return;
  const res = await fetch(`/api/poses/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null);
  if (!res?.ok) {
    const message = res ? await apiError(res) : "the editor server is not answering";
    status(`Pose ${name} not deleted: ${message}`, "bad");
    showToast(`Pose ${name} not deleted: ${message}`, "bad");
    return;
  }
  await refreshPoses();
  status(`Deleted pose ${name}`, "ok");
}

function applyLibraryPose(name: string, options: ApplyOptions & { frame?: number } = {}): { bones: number; slots: number; order: boolean; skipped: string[] } | null {
  const entry = poseLib.find((p) => p.pose.name === name);
  if (!entry || !rig || !skeleton) {
    status(`No pose named ${name}`, "bad");
    return null;
  }
  const t = options.frame === undefined ? keyTime() : frameTime(clip, options.frame);
  const r = applyPoseRecord(clip, entry.pose, t, {
    ...poseParts,
    ...options,
    knownBones: new Set(rig.doc.bones.map((b) => b.name)),
    knownSlots: new Set(rig.doc.slots.map((s) => s.name))
  });
  clearPending();
  commit(r.clip, `Applied pose ${name} at frame ${timeToFrame(clip, t)} (${r.bones} bones, ${r.slots} swaps${r.order ? ", draw order" : ""}${r.skipped.length ? `; skipped ${r.skipped.length}` : ""})`);
  return { bones: r.bones, slots: r.slots, order: r.order, skipped: r.skipped };
}

function renderPoseLibrary(): void {
  const box = $("posepanel");
  if (box.dataset.v2) return; // poseLibrary.ts owns the panel once installed
  box.replaceChildren();
  const nameInput = el("input", { placeholder: "pose_name", size: 14, title: "Letters, digits, _ and -" }) as HTMLInputElement;
  nameInput.id = "posename";
  const save = el("button", { textContent: "Save pose", title: "Save everything about the playhead frame: bones, attachment swaps, draw order, with a 0.4 thumbnail" });
  save.id = "savepose";
  save.addEventListener("click", () => void savePose(nameInput.value.trim()));
  const parts = el("div", { className: "row" });
  for (const part of ["bones", "attachments", "order"] as const) {
    const box2 = el("input", { type: "checkbox", checked: poseParts[part] }) as HTMLInputElement;
    box2.addEventListener("change", () => (poseParts = { ...poseParts, [part]: box2.checked }));
    parts.append(el("label", { className: "label", title: `Apply the pose's ${part}` }, box2, ` ${part}`));
  }
  box.append(el("h2", { textContent: "Pose library" }), el("div", { className: "row", style: "margin-top: 0" }, nameInput, save), parts);
  const otherRigs = poseLib.filter((p) => p.pose.rig && p.pose.rig !== rig?.outfit.id).length;
  if (otherRigs) {
    const other = el("input", { type: "checkbox", checked: showOtherRigs }) as HTMLInputElement;
    other.addEventListener("change", () => {
      showOtherRigs = other.checked;
      renderPoseLibrary();
    });
    parts.append(el("label", { className: "label", title: "The built-in poses are made per pro rig; show the other rig's too" }, other, ` other rigs (${otherRigs})`));
  }
  const list = el("div", { className: "poselist" });
  const shown = poseLib.filter((p) => !p.pose.rig || p.pose.rig === rig?.outfit.id || showOtherRigs);
  // Built-in starter poses first, then the user's own.
  for (const { pose: p, thumb } of [...shown.filter((x) => x.pose.builtin), ...shown.filter((x) => !x.pose.builtin)]) {
    const img = el("img", { src: thumb, alt: p.name, width: THUMB_W / 2, height: THUMB_H / 2 }) as HTMLImageElement;
    img.addEventListener("error", () => (img.style.visibility = "hidden"));
    const apply = el("button", { textContent: "Apply", title: p.note ?? "Key this pose at the playhead of the clip being edited" });
    apply.addEventListener("click", () => applyLibraryPose(p.name));
    const actions = el("div", { className: "row", style: "margin-top: 4px" }, apply);
    if (!p.builtin) {
      const del = el("button", { textContent: "Delete" });
      del.addEventListener("click", () => void deletePose(p.name));
      actions.append(del);
    }
    const title = el("div", { className: "label", textContent: p.name }, ...(p.builtin ? [el("span", { className: "pill", textContent: "built-in", title: "Starter pose shipped with the editor (read-only)" })] : []));
    const card = el("div", { className: "posecard" }, img, title, el("div", { className: "note", textContent: p.note ?? poseSummary(p) }), actions);
    card.dataset.pose = p.name;
    if (p.builtin) card.dataset.builtin = "1";
    list.append(card);
  }
  if (!shown.length) list.append(el("div", { className: "note", textContent: "No saved poses yet. Pose the character, name it and Save pose." }));
  box.append(list);
}

// ---------------------------------------------------------------------------------------------
// Event markers (hit, trail on / off, windup, follow, ready) and the attack profile lock
// ---------------------------------------------------------------------------------------------

/** The attack profile step new hit markers are linked to and the lock button targets. */
let eventLink = { style: "axe:generic", step: 0, link: true };

function renderEventPanel(): void {
  const box = $("eventpanel");
  box.replaceChildren();
  const t = keyTime();
  const here = eventsAt(clip, t);
  const nameSel = el("select", { title: "The rig's defined events (define more in the Rig tab, Tree > Events, or with Create below)" });
  for (const n of rigEventNames()) nameSel.append(el("option", { value: n, textContent: n, selected: n === eventDraft.name }));
  nameSel.addEventListener("change", () => (eventDraft.name = nameSel.value));
  const payloadField = (key: "int" | "float" | "string" | "audio", label: string, tip: string): HTMLElement => {
    const input = el("input", { type: "text", value: eventDraft[key], placeholder: "rig default", id: `event-payload-${key}`, title: tip });
    input.style.width = "0";
    input.style.flex = "1 1 0";
    input.addEventListener("input", () => (eventDraft[key] = input.value));
    return el("label", { className: "label", style: "display:flex;gap:4px;align-items:center;flex:1 1 0" }, label, input);
  };
  const add = el("button", { textContent: "Add at playhead", title: "Put the chosen event on this frame (with the payload below, or the rig's defaults when blank)" });
  add.addEventListener("click", () => addEventMarker(nameSel.value as EventName));
  const newName = el("input", { type: "text", placeholder: "new event name", id: "event-new-name", title: "A new event name for this rig (letters, digits, _ . -), for example footstep" });
  newName.style.flex = "1 1 0";
  newName.style.minWidth = "0";
  const create = el("button", { id: "event-create", textContent: "Create + add", title: "Define this event in the rig (undoable) and put it on the playhead frame" });
  create.addEventListener("click", () => {
    const name = newName.value.trim();
    if (!name) return status("Type a name for the new event first", "bad");
    void setup.api.setupRun(`Define event ${name}`, (raw) => planAddEvent(raw, name) as never).then((ok) => {
      if (!ok) return;
      eventDraft.name = name;
      addEventMarker(name);
    });
  });
  const del = el("button", { textContent: here.length ? `Delete here (${here.map((e) => e.name).join(", ")})` : "Delete here", title: "Remove the markers on this frame" });
  (del as HTMLButtonElement).disabled = !here.length;
  del.addEventListener("click", () => removeEventMarkers());
  const style = el("select", {});
  for (const id of PROFILE_STYLES) style.append(el("option", { value: id, textContent: id, selected: id === eventLink.style }));
  const step = el("select", {});
  for (let i = 0; i < profileStepCount(eventLink.style); i++) step.append(el("option", { value: String(i), textContent: `step ${i + 1}`, selected: i === eventLink.step }));
  style.addEventListener("change", () => {
    eventLink = { ...eventLink, style: style.value, step: 0 };
    renderEventPanel();
  });
  step.addEventListener("change", () => {
    eventLink = { ...eventLink, step: Number(step.value) };
    renderEventPanel();
  });
  const want = stepContactFrame(eventLink.style, eventLink.step, clipFps(clip));
  const lock = el("button", { textContent: want === null ? "Lock hit" : `Lock hit to frame ${want}`, title: "Move the hit marker onto the profile step's contact frame (windup ms x 30 / 1000) and link it" });
  lock.addEventListener("click", () => lockHitMarker());
  const linkBox = el("input", { type: "checkbox" });
  linkBox.checked = eventLink.link;
  linkBox.addEventListener("change", () => (eventLink = { ...eventLink, link: linkBox.checked }));
  const issues = eventIssues(clip);
  const info = el("div", { style: "margin-top: 8px" });
  for (const e of clip.events.filter((x) => x.name === "hit")) {
    const l = hitLink(e);
    const bad = issues.find((i) => Math.abs(i.time - e.time) < KEY_EPSILON);
    info.append(el("div", { className: `gate ${bad ? "warning" : ""}`, textContent: bad ? bad.message : l ? `hit on frame ${timeToFrame(clip, e.time)}: the contact frame of ${l.style} step ${l.step + 1}` : `hit on frame ${timeToFrame(clip, e.time)} (not linked to a profile)` }));
  }
  box.append(
    el("h2", { textContent: "Events" }),
    el("div", { className: "row", style: "margin-top: 0" }, nameSel, add, del),
    el("div", { className: "row" }, payloadField("int", "Int", "Int payload for this key (blank: the rig's default)"), payloadField("float", "Float", "Float payload for this key (blank: the rig's default)")),
    el("div", { className: "row" }, payloadField("string", "String", "String payload for this key (blank: the rig's default)"), payloadField("audio", "Audio", "Sound name for this key (blank: the rig's default)")),
    el("div", { className: "row" }, newName, create),
    el("div", { className: "row" }, el("span", { className: "label", textContent: "Profile" }), style, step),
    el("div", { className: "row" }, lock, el("label", { className: "label" }, linkBox, " link new hits")),
    info
  );
}

/** The event the panel adds, and the payload typed for it (blank = the rig's default). */
const eventDraft = { name: "hit", int: "", float: "", string: "", audio: "" };

/** The events a clip here can fire: the project's six first, then the rig's own, in order. */
function rigEventNames(): string[] {
  const own = rig ? Object.keys(rig.doc.events) : [];
  return [...new Set([...EVENT_NAMES, ...own])];
}

function addEventMarker(name: EventName): void {
  const payload: { int?: number; float?: number; string?: string; audio?: string } = {};
  const i = Number(eventDraft.int);
  const f = Number(eventDraft.float);
  if (eventDraft.int.trim() !== "" && Number.isFinite(i)) payload.int = i;
  if (eventDraft.float.trim() !== "" && Number.isFinite(f)) payload.float = f;
  if (eventDraft.string !== "") payload.string = eventDraft.string;
  if (eventDraft.audio.trim() !== "") payload.audio = eventDraft.audio.trim();
  commit(setEvent(clip, keyTime(), name, name === "hit" && eventLink.link ? { style: eventLink.style, step: eventLink.step } : undefined, payload), `Marker ${name} on frame ${timeToFrame(clip, time)}`);
}

function removeEventMarkers(name?: EventName): void {
  if (!eventsAt(clip, keyTime()).length) return;
  commit(deleteEvent(clip, keyTime(), name), `Removed the markers on frame ${timeToFrame(clip, time)}`);
}

function lockHitMarker(): void {
  const frame = stepContactFrame(eventLink.style, eventLink.step, clipFps(clip));
  if (frame === null) return;
  commit(lockHit(clip, eventLink.style, eventLink.step), `Hit locked to frame ${frame} (${eventLink.style} step ${eventLink.step + 1}: windup x 30 / 1000)`);
  setTime(frameTime(clip, frame));
}

function selectSlot(name: string | null): void {
  selectedSlot = name;
  renderSlotPanel();
  drawTimeline();
}

function setSlotAttachment(slot: string, name: string | null): void {
  selectedSlot = slot;
  commit(setAttachmentKey(clip, slot, keyTime(), name), `Slot ${slot}: ${name ?? "hidden"} from frame ${timeToFrame(clip, time)}`);
}

function removeSlotAttachment(slot: string): void {
  if (!attachmentKeyAt(clip, slot, keyTime())) return;
  commit(deleteAttachmentKey(clip, slot, keyTime()), `Removed the ${slot} swap key at frame ${timeToFrame(clip, time)}`);
}

function moveSlotOrder(slot: string, offset: number): void {
  selectedSlot = slot;
  commit(setDrawOrderOffset(clip, keyTime(), slot, offset), `Draw order: ${slot} ${offset > 0 ? "+" : ""}${offset} from frame ${timeToFrame(clip, time)}`);
}

/** Keys a named draw order state at the playhead (replacing the draw order key there). Returns false when the rig cannot show it. */
function setDrawPreset(id: DrawPresetId | "setup", frameNo?: number): boolean {
  if (!rig) return false;
  const t = frameNo === undefined ? keyTime() : frameTime(clip, frameNo);
  const names = rig.doc.slots.map((s) => s.name);
  const resolved = id === "setup" ? { applicable: true, reason: null, offsets: [] } : resolveDrawPreset(names, id);
  if (!resolved.applicable) {
    status(`Draw order ${id}: ${resolved.reason}`, "bad");
    return false;
  }
  commit(setDrawOrderKey(clip, t, resolved.offsets), `Draw order state ${id} from frame ${timeToFrame(clip, t)}`);
  return true;
}

function removeDrawOrderKey(): void {
  if (!drawOrderKeyAt(clip, keyTime())) return;
  commit(deleteDrawOrderKey(clip, keyTime()), `Removed the draw order key at frame ${timeToFrame(clip, time)}`);
}

function renderClipSelect(): void {
  const select = $<HTMLSelectElement>("clip");
  select.replaceChildren();
  if (!library.size) select.append(el("option", { value: "", textContent: "No clip", selected: true }));
  const rigGroup = el("optgroup", { label: "Clips" });
  for (const name of library.keys()) rigGroup.append(el("option", { value: `clip:${name}`, textContent: `${name}${dirty.has(name) ? " *" : ""}`, selected: name === clipName }));
  const fx = el("optgroup", { label: "Import fixtures/clips" });
  for (const f of CLIP_FIXTURES) fx.append(el("option", { value: `fx:${f.file}`, textContent: f.label }));
  select.append(rigGroup, fx);
  if (savedFiles.length) {
    const saved = el("optgroup", { label: `Saved (${SAVE_DIR})` });
    for (const f of savedFiles) saved.append(el("option", { value: `saved:${f}`, textContent: f }));
    select.append(saved);
  }
}

function renderClipControls(): void {
  $("loop").classList.toggle("on", clip.loop);
  const d = $<HTMLInputElement>("duration");
  if (document.activeElement !== d) d.value = clip.duration.toFixed(2);
  d.step = String(1 / clipFps(clip));
  const df = $<HTMLInputElement>("durframes");
  if (document.activeElement !== df) df.value = String(frameCount(clip));
  const fp = $<HTMLInputElement>("fps");
  if (document.activeElement !== fp) fp.value = String(clipFps(clip));
  $("returnstart").classList.toggle("on", returnToStart);
  $("held").textContent = "Snap to frames";
  $("held").classList.toggle("on", held);
  $("autokey").classList.toggle("on", autoKey);
  ($("undo") as HTMLButtonElement).disabled = !undoStack.length;
  ($("redo") as HTMLButtonElement).disabled = !redoStack.length;
  const firstKey = (a: HotkeyAction) => HOTKEYS.find((h) => h.action === a)?.keys.split(" / ")[0] ?? "";
  const undoTip = historyTip("Undo", undoStack.length ? undoStack[undoStack.length - 1]!.label : null, firstKey("undo"));
  const redoTip = historyTip("Redo", redoStack.length ? redoStack[redoStack.length - 1]!.label : null, firstKey("redo"));
  for (const id of ["undo"]) document.getElementById(id)?.setAttribute("title", undoTip);
  for (const id of ["redo"]) document.getElementById(id)?.setAttribute("title", redoTip);
  $("clipinfo").textContent = `${clipName}${dirty.has(clipName) ? " (unsaved)" : ""}`;
  setTransportEnabled(!!clipName);
  refreshStatusBar();
}

function updateReadout(): void {
  const f = timeToFrame(clip, displayTime());
  // The one frame readout (GL-16): length and fps are the fields beside it.
  $("readout").textContent = `Frame ${f} / ${frameCount(clip)}`;
  refreshStatusBar();
}

// ---------------------------------------------------------------------------------------------
// Clean up keys (keyReduce.ts) and Preview facing right (facing.ts)
// ---------------------------------------------------------------------------------------------

const reducePanel = createReducePanel({
  box: $("reducepanel"),
  clip: () => clip,
  selection: () => [...multi],
  commit: (next, message) => commit(next, message)
});

audioTrack = createAudioTrack({
  clipName: () => clipName,
  fps: () => clipFps(clip),
  frames: () => frameCount(clip),
  time: () => time,
  playing: () => playing,
  speed: () => playSpeed,
  frameX: (f, w) => frameX(f, w),
  labelWidth: () => LABEL_W,
  status: (m, k) => status(m, k)
});
keyInspector = createKeyInspector({
  clip: () => clip,
  time: () => time,
  playing: () => playing,
  selection: () => keySel,
  doc: () => rig?.doc ?? null,
  selectedSlot: () => selectedSlot,
  commit: (next, message) => {
    clearPending();
    commit(next, message);
  },
  select: (sel) => {
    editSelBefore = keySel;
    keySel = sel;
  },
  setTime: (t) => setTime(t),
  status: (text, kind) => status(text, kind)
});

/** Arc in-betweens (tween.ts): fills the frames between keys along a clean arc, only when the user presses Apply. */
const tweenPanel = createTweenPanel({
  box: $("tweenpanel"),
  doc: () => rig?.doc ?? null,
  clipName: () => clipName,
  clip: () => clip,
  playRange: () => (playRange ? { ...playRange } : null),
  commit: (next, message) => commit(next, message),
  status: (text, kind) => status(text, kind),
  redraw: () => drawOverlay(),
  pathsOn: () => {
    try {
      return (JSON.parse(localStorage.getItem("atlas-editor-paths") ?? "{}") as { on?: boolean }).on === true;
    } catch {
      return false;
    }
  }
});

/** Preview facing right: the left-facing character with its root flipped (scale.x = -1), as the runtime draws the right side. */
let facingRight = false;
let mirrorReport: { clip: string; issues: GateIssue[] } | null = null;

function computeMirrorReport(): void {
  if (!rig) return;
  try {
    mirrorReport = { clip: clipName, issues: mirrorGates(rig.doc, clipName, clip) };
  } catch (error) {
    mirrorReport = { clip: clipName, issues: [{ kind: "mirror", severity: "warning", message: `mirror check failed: ${error instanceof Error ? error.message : String(error)}` }] };
  }
}

function setFacing(facing: Facing): Facing {
  facingRight = facing === "right";
  if (character) applyFacing(character, facing);
  phone?.changed();
  $("facingbtn").classList.toggle("on", facingRight);
  if (facingRight) computeMirrorReport();
  drawOverlay();
  runGates();
  requestRender();
  return facing;
}

function renderAll(): void {
  renderStepsCard();
  renderSkinPanel();
  renderSmearPanel();
  renderArcPanel();
  renderLockPanel();
  reducePanel.render();
  tweenPanel.render();
  renderClipSelect();
  renderClipControls();
  renderBones();
  renderDetail();
  updateReadout();
  drawTimeline();
  drawOverlay();
  keyInspector?.render();
}

// ---------------------------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------------------------

let gateTimer: ReturnType<typeof setTimeout> | null = null;
let clipReport: { clip: string; issues: GateIssue[] } | null = null;

function scheduleGates(): void {
  if (gateTimer) clearTimeout(gateTimer);
  gateTimer = setTimeout(runGates, 140);
}

function gateRow(issue: GateIssue, jump: boolean): HTMLElement {
  const row = el(
    "div",
    { className: `gate ${issue.severity}${jump ? " jump" : ""}` },
    el("div", { className: "kind", textContent: `${issue.kind}${issue.time !== undefined ? `  f${timeToFrame(clip, issue.time)}` : ""}` }),
    issue.message
  );
  if (jump && issue.time !== undefined) row.addEventListener("click", () => setTime(issue.time!));
  return row;
}

function runGates(): void {
  if (!rig || !clipName) return;
  const list = $("gates");
  const pill = $("gatepill");
  let issues: GateIssue[];
  try {
    issues = poseGates(rig.doc, clipName, clip, displayTime(), pending, pendingMove, pendingScale, pendingShear);
  } catch (error) {
    issues = [{ kind: "format", severity: "error", message: `check failed: ${error instanceof Error ? error.message : String(error)}` }];
  }
  const errors = issues.filter((i) => i.severity === "error").length;
  pill.textContent = errors ? `${errors} issue${errors > 1 ? "s" : ""} at f${timeToFrame(clip, displayTime())}` : `clean at f${timeToFrame(clip, displayTime())}`;
  pill.className = `pill ${errors ? "bad" : "ok"}`;
  list.replaceChildren();
  list.append(el("div", { className: "label", textContent: "Current pose (format, pose rules, bone ranges; warnings only on non-loop clips)", style: "margin:4px 0 6px" }));
  if (!issues.length) list.append(el("div", { className: "gate", textContent: "No issues for this pose." }));
  for (const i of issues) list.append(gateRow(i, false));
  if (clipReport && clipReport.clip === clipName) {
    list.append(el("div", { className: "label", textContent: `Whole clip (${clipReport.issues.length} finding${clipReport.issues.length === 1 ? "" : "s"}, click to jump)`, style: "margin:10px 0 6px" }));
    if (!clipReport.issues.length) list.append(el("div", { className: "gate", textContent: "Every sampled pose passes." }));
    for (const i of clipReport.issues.slice(0, 80)) list.append(gateRow(i, true));
  }
  if (mirrorReport && mirrorReport.clip === clipName && (facingRight || clipReport?.clip === clipName)) {
    const m = mirrorReport.issues;
    list.append(el("div", { className: "label mirrorhead", textContent: `Facing right (mirror check, ${m.length} finding${m.length === 1 ? "" : "s"})`, style: "margin:10px 0 6px" }));
    if (!m.length) list.append(el("div", { className: "gate", textContent: "Nothing breaks when mirrored." }));
    for (const i of m.slice(0, 80)) list.append(gateRow(i, true));
  }
}

function checkWholeClip(): void {
  if (!rig) return;
  status("Checking every sampled pose of the clip...");
  setTimeout(() => {
    const t0 = performance.now();
    clipReport = { clip: clipName, issues: clipGates(rig!.doc, clipName, clip) };
    computeMirrorReport();
    runGates();
    status(`Clip check: ${clipReport.issues.length} finding(s) in ${Math.round(performance.now() - t0)} ms`, clipReport.issues.length ? "bad" : "ok");
  }, 10);
}

// ---------------------------------------------------------------------------------------------
// Timeline (canvas dopesheet)
// ---------------------------------------------------------------------------------------------

const tl = $<HTMLCanvasElement>("tl");
const LABEL_W = 184;
const RULER_H = 24;
const ROW_H = 20;
/** The "All keys" summary row is pinned under the ruler; every other row scrolls below it. */
const SCROLL_Y = RULER_H + ROW_H;
let rowScroll = 0;
/** A `curve` row is half of a two-row block: the mini value curve of one channel under an expanded bone (`part` 0 is the top half). */
type TlRow = { kind: "all" | "bone" | "chan" | "curve" | "ik" | "transform" | "path" | "physics" | "slot" | "color" | "seq" | "deform" | "draw" | "event"; name: string; type?: KeyType; ch?: GraphChannelId; part?: 0 | 1 };
let tlRows: TlRow[] = [];
/** Bones whose row is opened into per-channel rows (rotate, translate, scale / shear). */
const tlExpanded = new Set<string>();
/** The visible frame window. While `tlAutoFit` it always shows the whole clip; zooming or panning turns that off. */
let tlView: TlView = fitView(1);
let tlAutoFit = true;

function timelineRows(): TlRow[] {
  const rows: TlRow[] = [{ kind: "all", name: "All keys" }];
  for (const b of rig?.doc.bones ?? []) {
    if (!(clip.bones[b.name] || multi.has(b.name) || unkeyedBones(pending, pendingMove, pendingScale, pendingShear).includes(b.name))) continue;
    rows.push({ kind: "bone", name: b.name });
    if (tlExpanded.has(b.name)) {
      for (const g of boneChannelTimes(clip, b.name)) rows.push({ kind: "chan", name: b.name, type: g.type });
      for (const ch of curveChannelsOf(clip, b.name)) rows.push({ kind: "curve", name: b.name, ch, part: 0 }, { kind: "curve", name: b.name, ch, part: 1 });
    }
  }
  for (const name of Object.keys(clip.ik)) rows.push({ kind: "ik", name });
  for (const name of Object.keys(clip.transform)) rows.push({ kind: "transform", name });
  for (const name of Object.keys((clip as { path?: Record<string, unknown> }).path ?? {})) rows.push({ kind: "path", name });
  for (const name of Object.keys(clip.physics)) rows.push({ kind: "physics", name });
  for (const s of rig?.doc.slots ?? []) {
    if (clip.slots[s.name]?.attachment || s.name === selectedSlot) rows.push({ kind: "slot", name: s.name });
    if (clip.slots[s.name]?.color) rows.push({ kind: "color", name: s.name });
    if ((clip.slots[s.name] as { sequence?: unknown[] } | undefined)?.sequence?.length) rows.push({ kind: "seq", name: s.name });
    // The slot's shape keys (deform) sit right under it.
    for (const a of deformRowsOfSlot(clip, s.name)) rows.push({ kind: "deform", name: deformRowId(a).slice(7) });
  }
  if (clip.drawOrder.length || selectedSlot) rows.push({ kind: "draw", name: "draw order" });
  rows.push({ kind: "event", name: "events" });
  return rows;
}

let boxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
/** The selected curve segments (dopesheet curve rows) and the one under the pointer; they belong to the clip named in `segFor`. */
let segSel: SegRef[] = [];
let tlHoverSeg: SegRef | null = null;
let segFor = "";
let segPickerAt: { x: number; y: number; color: string } | null = null;
const segPicker: SegPicker = createSegPicker({
  pick: (spec, id) => applySegSelection(spec, id),
  addChannel: () => {
    const last = segSel[segSel.length - 1];
    if (!last) return;
    for (const s of segmentsOf(clip, last.bone, last.channel)) if (!hasSeg(segSel, s.ref)) segSel.push(s.ref);
    openSegPicker();
  },
  addKeys: () => {
    for (const r of segmentsOfKeys(clip, keySel)) if (!hasSeg(segSel, r)) segSel.push(r);
    openSegPicker();
  },
  clear: () => {
    segSel = [];
    drawTimeline();
  },
  closed: () => drawTimeline()
});

/** The selected segments that still exist in the open clip. */
function liveSegments(): SegRef[] {
  return segSel.filter((r) => segmentsOf(clip, r.bone, r.channel).some((s) => sameSeg(s.ref, r)));
}

/** Opens (or refreshes) the easing picker for the selected segments near where it was last anchored. */
function openSegPicker(): void {
  const segs = liveSegments();
  if (!segs.length || !segPickerAt) {
    segPicker.close();
    return;
  }
  const kinds = new Set(segs.map((r) => presetOf(segmentCurve(clip, r)) ?? "custom"));
  const only = kinds.size === 1 ? [...kinds][0]! : null;
  segPicker.open({ x: segPickerAt.x, y: segPickerAt.y, count: segs.length, current: kinds.size > 1 ? "mixed" : only === "custom" ? null : (only as SegPresetId), color: segPickerAt.color });
  drawTimeline();
}

function applySegSelection(spec: CurveSpec, id: SegPresetId): void {
  const segs = liveSegments();
  if (!segs.length) return;
  clearPending();
  const label = SEG_PRESETS.find((p) => p.id === id)?.label ?? id;
  commit(applySegmentPreset(clip, segs, spec), `${label} on ${segs.length} curve segment${segs.length === 1 ? "" : "s"}${segs.length === 1 ? ` of ${segs[0]!.bone} from frame ${timeToFrame(clip, segs[0]!.time)}` : ""}`);
}

/** What a pointer position on a curve row is over: a key dot, or a segment between two keys. */
function curveHit(p: { x: number; y: number; w: number }): { row: TlRow; seg: ReturnType<typeof segmentAt>; key: number | null } | null {
  if (p.y <= RULER_H || p.x < LABEL_W) return null;
  const row = rowAtY(p.y);
  if (!row || row.kind !== "curve") return null;
  const fps = clipFps(clip);
  const range = curveRange(clip, row.name, row.ch!);
  const top = rowTop(tlRows.indexOf(row)) - (row.part ?? 0) * ROW_H;
  const vy = (v: number) => top + ROW_H * 2 - 5 - ((v - range.lo) / (range.hi - range.lo)) * (ROW_H * 2 - 10);
  for (const k of channelKeys(clip, row.name, row.ch!)) {
    if (Math.hypot(frameX(k.time * fps, p.w) - p.x, vy(k.value) - p.y) <= 7) return { row, seg: null, key: k.time };
  }
  const t = xToFrameFloat(tlView, p.x, keyLeft(), keyWidth(p.w)) / fps;
  return { row, seg: segmentAt(clip, row.name, row.ch!, t), key: null };
}
/** The key under the pointer (P1-3): a row signature and the key time, drawn enlarged with a glow. */
let tlHover: { sig: string; time: number } | null = null;
/** The frame a Shift-drag snapped to, drawn as a dashed guide. */
let tlSnapFrame: number | null = null;
const rowSig = (row: { kind: string; name: string; type?: string }) => `${row.kind}:${row.name}:${row.type ?? ""}`;

function showTlTip(clientX: number, clientY: number, text: string): void {
  const tip = $("tlkeytip");
  tip.textContent = text;
  tip.style.display = "block";
  const wide = tip.offsetWidth;
  tip.style.left = `${Math.max(4, Math.min(clientX + 14, window.innerWidth - wide - 8))}px`;
  tip.style.top = `${clientY > 40 ? clientY - 32 : clientY + 20}px`;
}

function hideTlTip(): void {
  $("tlkeytip").style.display = "none";
}

function clearTlHover(): void {
  tlHover = null;
  hideTlTip();
}

/** The keyed property of a graph / curve-row channel (translateX -> translate). */
function graphProperty(c: GraphChannelId): "rotate" | "translate" | "scale" | "shear" {
  return c === "rotate" ? "rotate" : c.startsWith("translate") ? "translate" : c.startsWith("scale") ? "scale" : "shear";
}

function rowIdOf(row: TlRow): RowId | null {
  // A channel row is its own key identity (): selecting a rotate key there does not select the bone's other channels.
  if (row.kind === "chan") return boneChannelRow(row.name, row.type as BoneProperty);
  if (row.kind === "bone") return `bone:${row.name}`;
  if (row.kind === "ik") return `ik:${row.name}`;
  if (row.kind === "slot") return `slot:${row.name}`;
  if (row.kind === "color") return `color:${row.name}`;
  if (row.kind === "seq") return `seq:${row.name}`;
  if (row.kind === "transform") return `transform:${row.name}`;
  if (row.kind === "path") return `path:${row.name}`;
  if (row.kind === "physics") return `physics:${row.name}`;
  if (row.kind === "deform") return `deform:${row.name}`;
  if (row.kind === "draw") return "draw";
  if (row.kind === "event") return "event";
  return null;
}

/** Key times a timeline row shows. */
function tlRowTimes(row: TlRow): number[] {
  if (row.kind === "curve") return [];
  if (row.kind === "chan") return boneChannelTimes(clip, row.name).find((g) => g.type === row.type)?.times ?? [];
  const id = rowIdOf(row);
  if (id) return rowKeyTimes(clip, id);
  return [...new Set(allKeys(clip).map((k) => k.time))].sort((a, b) => a - b);
}

/** The key types a row has at `time` (one colour slice each in the diamond). */
function tlTypesAt(row: TlRow, time: number): KeyType[] {
  switch (row.kind) {
    case "bone":
      return boneKeyTypesAt(clip, row.name, time);
    case "chan":
      return [row.type!];
    case "ik":
      return ["ik"];
    case "slot":
      return ["attachment"];
    case "deform":
      return ["deform"];
    case "color":
      return ["color"];
    case "seq":
      return ["sequence"];
    case "transform":
      return ["transform"];
    case "path":
      return ["path"];
    case "physics":
      return ["physics"];
    case "draw":
      return ["drawOrder"];
    case "event":
      return ["event"];
    default: {
      const out = new Set<KeyType>();
      for (const k of keysAtTime(clip, time)) for (const t of tlTypesAt(rowOfId(k.row), time)) out.add(t);
      return KEY_TYPES.filter((t) => out.has(t));
    }
  }
}

function rowOfId(id: RowId): TlRow {
  if (id === "draw") return { kind: "draw", name: "draw order" };
  if (id === "event") return { kind: "event", name: "events" };
  const bone = rowBone(id);
  if (bone !== null && id.includes("#")) return { kind: "chan", name: bone, type: id.split("#")[1] as KeyType };
  const name = bone ?? id.slice(id.indexOf(":") + 1);
  return { kind: id.startsWith("bone:") ? "bone" : id.startsWith("ik:") ? "ik" : id.startsWith("deform:") ? "deform" : id.startsWith("color:") ? "color" : id.startsWith("seq:") ? "seq" : id.startsWith("transform:") ? "transform" : id.startsWith("path:") ? "path" : id.startsWith("physics:") ? "physics" : "slot", name };
}

/** The keys a click on a marker selects: the row's key, or every key at that time for the All keys row. */
function keysOfMarker(row: TlRow, time: number): KeySel[] {
  const id = rowIdOf(row);
  return id ? [{ row: id, time }] : keysAtTime(clip, time);
}

/** Where the frame ruler / key area starts and how wide it is, in canvas px. */
const keyLeft = () => LABEL_W + 10;
const keyWidth = (width: number) => Math.max(10, width - LABEL_W - 22);

function frameX(frame: number, width: number): number {
  return frameToX(tlView, frame, keyLeft(), keyWidth(width));
}

function xToFrame(x: number, width: number): number {
  return Math.round(xToFrameFloat(tlView, x, keyLeft(), keyWidth(width)));
}

/** Top y of a row on the canvas (the summary row is pinned, the rest scroll). */
function rowTop(index: number): number {
  return index === 0 ? RULER_H : SCROLL_Y + (index - 1 - rowScroll) * ROW_H;
}

/** The timeline row under canvas y, or undefined. */
function rowAtY(y: number): TlRow | undefined {
  if (y < RULER_H) return undefined;
  if (y < SCROLL_Y) return tlRows[0];
  return tlRows[1 + rowScroll + Math.floor((y - SCROLL_Y) / ROW_H)];
}

function setTlView(next: TlView, fit = false): void {
  tlAutoFit = fit;
  tlView = fit ? fitView(frameCount(clip)) : clampView(next, frameCount(clip));
  drawTimeline();
}

/** Keeps the zoom and pan sliders in step with the view. */
function syncTlControls(): void {
  const n = frameCount(clip);
  const zoom = document.getElementById("tlzoom") as HTMLInputElement | null;
  const pan = document.getElementById("tlpan") as HTMLInputElement | null;
  if (zoom) zoom.value = String(Math.round(zoomToSlider(tlView, n) * 1000));
  if (pan) {
    const room = Math.max(0, n - tlView.span);
    pan.disabled = room < 1e-6;
    pan.value = room < 1e-6 ? "0" : String(Math.round((tlView.start / room) * 1000));
  }
}

/** A key marker: diamond (linear), circle (eased) or square (stepped), split into one colour slice per key type. */
function drawKeyShape(g: CanvasRenderingContext2D, x: number, cy: number, r: number, ckind: CurveKind, types: readonly KeyType[], here: boolean): void {
  const path = () => {
    g.beginPath();
    if (ckind === "stepped") g.rect(x - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7);
    else if (ckind !== "linear") g.arc(x, cy, r * 0.95, 0, Math.PI * 2);
    else {
      g.moveTo(x, cy - r);
      g.lineTo(x + r, cy);
      g.lineTo(x, cy + r);
      g.lineTo(x - r, cy);
      g.closePath();
    }
  };
  g.save();
  path();
  g.clip();
  const n = Math.max(1, types.length);
  types.forEach((t, i) => {
    g.fillStyle = KEY_COLOR[t];
    g.fillRect(x - r + ((2 * r) / n) * i, cy - r, (2 * r) / n + 0.5, 2 * r);
  });
  g.restore();
  path();
  g.lineWidth = here ? 2 : 1;
  g.strokeStyle = here ? "#f0b84a" : "rgba(10,12,16,0.85)";
  g.stroke();
  g.lineWidth = 1;
}

/** The time of the event marker Rename / Delete act on: the one at the playhead, else the selected event key. */
function eventTargetTime(): number | null {
  const here = eventsAt(clip, keyTime());
  if (here.length) return here[0]!.time;
  const sel = liveSelection(clip, keySel).find((k) => k.row === "event");
  return sel ? sel.time : null;
}

/** Puts the "+ Event / Rename / Delete" buttons over the events row's label gutter (hidden when that row is scrolled out of view). */
function positionEventTools(visible: number): void {
  const box = document.getElementById("evtools");
  if (!box) return;
  const idx = tlRows.findIndex((r) => r.kind === "event");
  const i = idx - 1 - rowScroll;
  const show = idx > 0 && i >= 0 && i < visible && !!clipName;
  box.hidden = !show;
  if (!show) return;
  box.style.top = `${SCROLL_Y + i * ROW_H - 2}px`; // 24 px buttons centred on the 20 px row
  const target = eventTargetTime();
  ($("evrename") as HTMLButtonElement).disabled = target === null;
  ($("evdelete") as HTMLButtonElement).disabled = target === null;
}

function renameEventsAt(time: number, to: EventName): void {
  commit(renameEvent(clip, time, to), `Event on frame ${timeToFrame(clip, time)} is now ${to}`);
}

function openEventAdd(anchor: HTMLElement): void {
  if (!clipName) return status("Open or create a clip first", "bad");
  const items: MenuItem[] = [{ label: `Add an event at frame ${timeToFrame(clip, keyTime())}`, caption: true }, ...rigEventNames().map((n) => ({ label: n, run: () => addEventMarker(n) }))];
  const r = anchor.getBoundingClientRect();
  openContextMenu(r.left, r.top - 4 - items.length * 30, items, anchor);
}

function openEventRename(anchor: HTMLElement): void {
  const t0 = eventTargetTime();
  if (t0 === null) return status("Move the playhead onto an event (or click one) to rename it", "bad");
  const current = eventsAt(clip, t0).map((e) => e.name);
  const items: MenuItem[] = [{ label: `Change the event on frame ${timeToFrame(clip, t0)} to`, caption: true }, ...rigEventNames().map((n) => ({ label: n, checked: current.includes(n), run: () => renameEventsAt(t0, n) }))];
  const r = anchor.getBoundingClientRect();
  openContextMenu(r.left, r.top - 4 - items.length * 30, items, anchor);
}

function deleteEventHere(): void {
  const t0 = eventTargetTime();
  if (t0 === null) return status("Move the playhead onto an event (or click one) to delete it", "bad");
  commit(deleteEvent(clip, t0), `Removed the event on frame ${timeToFrame(clip, t0)}`);
}

function wireEventTools(): void {
  $("addevent").addEventListener("click", () => openEventAdd($("addevent")));
  $("evrename").addEventListener("click", () => openEventRename($("evrename")));
  $("evdelete").addEventListener("click", deleteEventHere);
  // The same three actions from a button that never scrolls away with the events row (Animate bar and Pro transport).
  $("evmenu-btn").addEventListener("click", () => {
    const anchor = $("key-menu-btn");
    if (!clipName) return status("Open or create a clip first", "bad");
    const here = eventTargetTime();
    const items: MenuItem[] = [
      { label: `Add an event at frame ${timeToFrame(clip, keyTime())}`, caption: true },
      ...rigEventNames().map((n) => ({ label: n, run: () => addEventMarker(n) })),
      { label: "Change the event here...", separator: true, disabled: here === null, run: () => openEventRename(anchor) },
      { label: "Delete the event here", disabled: here === null, run: deleteEventHere }
    ];
    const r = anchor.getBoundingClientRect();
    openContextMenu(r.left, r.top - 4 - items.length * 30, items, anchor);
  });
}

function drawTimeline(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = tl.clientWidth;
  const h = tl.clientHeight;
  if (!w || !h) return;
  if (tl.width !== Math.round(w * dpr) || tl.height !== Math.round(h * dpr)) {
    tl.width = Math.round(w * dpr);
    tl.height = Math.round(h * dpr);
  }
  const n = frameCount(clip);
  if (segFor !== clipName) {
    segFor = clipName;
    segSel = [];
    tlHoverSeg = null;
    segPicker.close();
  }
  tlView = tlAutoFit ? fitView(n) : clampView(tlView, n);
  // While playing at a zoom, keep the playhead on screen.
  if (!tlAutoFit && playing) {
    const pf = timeToFrame(clip, displayTime());
    if (pf < tlView.start || pf > tlView.start + tlView.span) tlView = clampView({ start: pf - tlView.span * 0.1, span: tlView.span }, n);
  }
  const g = tl.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.font = "12px Segoe UI, system-ui, sans-serif";
  tlRows = timelineRows();
  const visible = Math.max(1, Math.floor((h - SCROLL_Y) / ROW_H));
  rowScroll = Math.max(0, Math.min(rowScroll, tlRows.length - 1 - visible));
  const step = frameX(1, w) - frameX(0, w);
  const t = keyTime();
  const playFrame = timeToFrame(clip, displayTime());
  const playX = frameX(playFrame, w) + (playing && !held ? (displayTime() * clipFps(clip) - playFrame) * step : 0);
  const inKeys = (fn: () => void) => {
    g.save();
    g.beginPath();
    g.rect(LABEL_W + 1, 0, Math.max(0, w - LABEL_W - 1), h);
    g.clip();
    fn();
    g.restore();
  };
  const first = Math.max(0, Math.floor(tlView.start));
  const last = Math.min(n, Math.ceil(tlView.start + tlView.span));

  // Row backgrounds and labels (the summary row is drawn last, on top, so scrolled rows never show through it).
  const drawRowBase = (row: TlRow, y: number, i: number) => {
    if (row.kind === "curve") {
      const top = y - (row.part ?? 0) * ROW_H;
      const ch = channelById(row.ch!);
      g.save();
      g.beginPath();
      g.rect(0, y, w, ROW_H);
      g.clip();
      g.fillStyle = row.name === selected ? "#27261f" : "#171a21";
      g.fillRect(0, top, w, ROW_H * 2);
      g.fillStyle = ch.color;
      g.fillText(`${ch.label} curve`, 30, top + 15);
      const now = sampleChannel(channelKeys(clip, row.name, row.ch!), displayTime());
      if (now !== undefined) {
        g.fillStyle = "#8c96a8";
        g.font = "11px Segoe UI, system-ui, sans-serif";
        g.fillText(row.ch === "rotate" ? `${now.toFixed(1)}\u00b0` : now.toFixed(1), 30, top + 31);
        g.font = "12px Segoe UI, system-ui, sans-serif";
      }
      g.restore();
      return;
    }
    const sel = (row.kind === "bone" || row.kind === "chan") && row.name === selected;
    g.fillStyle = row.kind === "all" ? "#232a38" : sel ? "#2b2a22" : i % 2 ? "#1d212a" : "#1b1f27";
    g.fillRect(0, y, w, ROW_H);
    let label = row.name;
    let x = 10;
    if (row.kind === "bone") {
      const hasChannels = !!clip.bones[row.name];
      if (hasChannels) {
        g.fillStyle = "#8c96a8";
        g.beginPath();
        if (tlExpanded.has(row.name)) {
          g.moveTo(4, y + 7);
          g.lineTo(12, y + 7);
          g.lineTo(8, y + 13);
        } else {
          g.moveTo(5, y + 5);
          g.lineTo(11, y + 10);
          g.lineTo(5, y + 15);
        }
        g.closePath();
        g.fill();
      }
      x = 18;
    } else if (row.kind === "chan") {
      label = KEY_TYPE_LABEL[row.type!];
      x = 30;
    } else if (row.kind === "ik") label = `IK ${row.name} (mix)`;
    else if (row.kind === "slot") label = `slot ${row.name}`;
    else if (row.kind === "color") label = `colour ${row.name}`;
    else if (row.kind === "seq") label = `sequence ${row.name}`;
    else if (row.kind === "transform") label = `mix ${row.name}`;
    else if (row.kind === "path") label = `path ${row.name}`;
    else if (row.kind === "physics") label = `physics ${row.name}`;
    else if (row.kind === "deform") {
      label = `shape keys ${row.name.split("/").pop()}`;
      x = 24;
    }
    g.fillStyle = sel ? "#f0b84a" : row.kind === "all" ? "#d9dee8" : row.kind === "ik" ? KEY_COLOR.ik : row.kind === "seq" ? KEY_COLOR.sequence : row.kind === "color" || row.kind === "transform" || row.kind === "path" || row.kind === "physics" || row.kind === "deform" ? KEY_COLOR[row.kind] : row.kind === "chan" ? KEY_COLOR[row.type!] : "#b8c0cf";
    if (row.kind === "slot" || row.kind === "draw") g.fillStyle = row.name === selectedSlot || row.kind === "draw" ? "#9be3b0" : "#7fb592";
    g.save();
    g.beginPath();
    g.rect(0, y, LABEL_W, ROW_H);
    g.clip();
    g.fillText(label, x, y + 14);
    g.restore();
  };

  const drawCurveRow = (row: TlRow, y: number) => {
    const top = y - (row.part ?? 0) * ROW_H;
    const bh = ROW_H * 2;
    const ch = channelById(row.ch!);
    const range = curveRange(clip, row.name, row.ch!);
    const vy = (v: number) => top + bh - 5 - ((v - range.lo) / (range.hi - range.lo)) * (bh - 10);
    const fps = clipFps(clip);
    const tx = (t: number) => frameX(t * fps, w);
    g.save();
    g.beginPath();
    g.rect(LABEL_W + 1, y, Math.max(0, w - LABEL_W - 1), ROW_H);
    g.clip();
    if (range.lo < 0 && range.hi > 0) {
      g.strokeStyle = "rgba(140,150,168,0.22)";
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(LABEL_W + 1, Math.round(vy(0)) + 0.5);
      g.lineTo(w, Math.round(vy(0)) + 0.5);
      g.stroke();
      g.setLineDash([]);
    }
    const focus = graph?.focus();
    const keys = channelKeys(clip, row.name, row.ch!);
    for (const seg of segmentsOf(clip, row.name, row.ch!)) {
      const x0 = tx(seg.a.time);
      const x1 = tx(seg.b.time);
      if (x1 < LABEL_W || x0 > w) continue;
      const picked = hasSeg(segSel, seg.ref);
      const hover = tlHoverSeg !== null && sameSeg(tlHoverSeg, seg.ref);
      const inGraph = !!focus && focus.bone === row.name && focus.channel === row.ch && Math.abs(focus.time - seg.a.time) < KEY_EPSILON;
      if (picked || hover || inGraph) {
        g.fillStyle = picked ? "rgba(240,184,74,0.16)" : hover ? "rgba(255,255,255,0.08)" : "rgba(95,179,255,0.10)";
        g.fillRect(x0, top + 1, x1 - x0, bh - 2);
        if (picked) {
          g.fillStyle = "#f0b84a";
          g.fillRect(x0, top + bh - 2, x1 - x0, 2);
        }
      }
      const pts = segmentPoints(seg, Math.min(40, Math.max(6, (x1 - x0) / 4)));
      g.strokeStyle = picked ? "#ffd98a" : ch.color;
      g.lineWidth = picked || hover ? 2.25 : 1.75;
      g.lineJoin = "round";
      g.beginPath();
      pts.forEach((pt, k) => (k ? g.lineTo(tx(pt.t), vy(pt.v)) : g.moveTo(tx(pt.t), vy(pt.v))));
      g.stroke();
    }
    g.lineWidth = 1;
    const prop = graphProperty(row.ch!);
    for (const k of keys) {
      const x = tx(k.time);
      if (x < LABEL_W - 4 || x > w + 4) continue;
      const chosen = boneKeySelected(keySel, row.name, prop, k.time);
      g.fillStyle = chosen ? "#ffffff" : ch.color;
      g.strokeStyle = "rgba(10,12,16,0.85)";
      g.beginPath();
      g.arc(x, vy(k.value), chosen ? 3.6 : 3, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    g.restore();
  };

  const drawRowKeys = (row: TlRow, y: number) => {
    if (row.kind === "curve") {
      drawCurveRow(row, y);
      return;
    }
    const cy = y + ROW_H / 2;
    const r = Math.min(6, Math.max(3.5, step * 0.4));
    const bad = row.kind === "event" ? new Set(eventIssues(clip).map((i) => i.time)) : null;
    const drawn = new Set<number>();
    // Event names: sorted diamond positions, so each name can avoid the next diamond (placeEventLabel).
    const evXs = row.kind === "event" ? [...new Set(clip.events.map((k) => timeToFrame(clip, k.time)))].sort((a, b) => a - b).map((f2) => frameX(f2, w)) : [];
    for (const time of tlRowTimes(row)) {
      const f = timeToFrame(clip, time);
      if (drawn.has(f)) continue;
      drawn.add(f);
      const x = frameX(f, w);
      if (x < LABEL_W - r || x > w + r) continue;
      const here = Math.abs(time - t) < KEY_EPSILON;
      const curve = row.kind === "bone" || row.kind === "chan" ? keyCurveAt(clip, { kind: "bone", name: row.name, time }) : undefined;
      const hot = tlHover !== null && tlHover.sig === rowSig(row) && Math.abs(time - tlHover.time) < KEY_EPSILON;
      if (hot) {
        g.fillStyle = "rgba(95,179,255,0.30)";
        g.beginPath();
        g.arc(x, cy, r + 3.5, 0, Math.PI * 2);
        g.fill();
      }
      drawKeyShape(g, x, cy, hot ? r * 1.25 : r, curve === undefined ? "linear" : curveKind(curve), tlTypesAt(row, time), here);
      if ((row.kind === "bone" || (row.kind === "chan" && row.type === "rotate")) && isGeneratedKey(clipName, clip, row.name, time)) {
        // A key made by Arc in-betweens: a magenta core and ring, so it reads apart from the user's own keys.
        g.fillStyle = "#ff5ec8";
        g.beginPath();
        g.arc(x, cy, r * 0.6, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = "#ff5ec8";
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(x, cy, r + 2, 0, Math.PI * 2);
        g.stroke();
        g.lineWidth = 1;
      }
      if (row.kind === "event") {
        const names = eventsAt(clip, time).map((k) => k.name);
        const isBad = bad?.has(time);
        g.font = "10.5px Segoe UI, system-ui, sans-serif";
        const place = placeEventLabel(evXs, evXs.indexOf(x), `${names.join(", ")}${isBad ? " !" : ""}`, (str) => g.measureText(str).width, r, LABEL_W + 4, w - 4);
        if (place) {
          g.fillStyle = isBad ? "#ff6b6b" : "#c9d1e0";
          g.textAlign = place.align;
          g.fillText(place.text, place.x, cy + 3.5);
          g.textAlign = "left";
        }
        g.font = "12px Segoe UI, system-ui, sans-serif";
      }
      const rid = rowIdOf(row);
      const chosen = rid ? isSelected(keySel, rid, time) : keySel.some((s) => Math.abs(s.time - time) < KEY_EPSILON);
      if (chosen) {
        g.strokeStyle = "#ffffff";
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(x, cy, r + 3, 0, Math.PI * 2);
        g.stroke();
        g.lineWidth = 1;
      }
    }
    if (row.kind === "bone" && (pending[row.name] !== undefined || pendingMove[row.name] || pendingScale[row.name] || pendingShear[row.name])) {
      // A hollow orange diamond at the playhead: this bone moved and the move is not keyed (it snaps back on scrub).
      const ux = frameX(timeToFrame(clip, t), w);
      g.strokeStyle = "#ffc65c";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(ux, cy - r - 1);
      g.lineTo(ux + r + 1, cy);
      g.lineTo(ux, cy + r + 1);
      g.lineTo(ux - r - 1, cy);
      g.closePath();
      g.stroke();
      g.lineWidth = 1;
    }
  };

  const scrolled: { row: TlRow; y: number; i: number }[] = [];
  for (let i = 0; i < visible && i + 1 + rowScroll < tlRows.length; i++) scrolled.push({ row: tlRows[i + 1 + rowScroll]!, y: SCROLL_Y + i * ROW_H, i });
  g.save();
  g.beginPath();
  g.rect(0, SCROLL_Y, w, h - SCROLL_Y);
  g.clip();
  for (const s of scrolled) drawRowBase(s.row, s.y, s.i);
  g.restore();

  // Ruler
  g.fillStyle = "#222733";
  g.fillRect(0, 0, w, RULER_H);
  g.fillStyle = "#8c96a8";
  g.font = "11px Segoe UI, system-ui, sans-serif";
  // The frame readout lives in the transport (once); the gutter stays empty.
  g.font = "12px Segoe UI, system-ui, sans-serif";
  inKeys(() => {
    if (clip.loop) {
      g.fillStyle = "rgba(95,179,255,0.18)";
      g.fillRect(frameX(0, w), RULER_H - 5, frameX(n, w) - frameX(0, w), 5);
    }
    if (playRange) {
      const x0 = frameX(playRange.a, w);
      const x1 = frameX(playRange.b + 1 > n ? n : playRange.b + 1, w);
      g.fillStyle = "rgba(107,214,143,0.30)";
      g.fillRect(x0, 0, x1 - x0, RULER_H);
    }
    // Ticks and numbers: the label spacing follows the zoom so numbers never touch or overlap; the playhead flag hides its neighbours.
    const every = labelStep(Math.abs(step));
    for (let f = first; f <= last; f++) {
      const x = Math.round(frameX(f, w)) + 0.5;
      const major = f % every === 0;
      if (!major && step < 5) continue;
      g.strokeStyle = major ? "#4a5468" : "#323a4a";
      g.beginPath();
      g.moveTo(x, major ? 8 : 15);
      g.lineTo(x, RULER_H);
      g.stroke();
      if (major && Math.abs(x - playX) > 20) {
        g.fillStyle = "#9aa4b6";
        g.fillText(String(f), x + 3, 13);
      }
      g.strokeStyle = major ? "#262c38" : "#20252f";
      g.beginPath();
      g.moveTo(x, RULER_H);
      g.lineTo(x, h);
      g.stroke();
    }
    // Rows' keys
    g.save();
    g.beginPath();
    g.rect(LABEL_W + 1, SCROLL_Y, Math.max(0, w - LABEL_W - 1), h - SCROLL_Y);
    g.clip();
    for (const s of scrolled) drawRowKeys(s.row, s.y);
    g.restore();
    if (playRange) {
      g.fillStyle = "rgba(0,0,0,0.32)";
      const x0 = frameX(playRange.a, w);
      const x1 = frameX(playRange.b + 1 > n ? n : playRange.b + 1, w);
      g.fillRect(LABEL_W + 1, RULER_H, Math.max(0, x0 - LABEL_W - 1), h - RULER_H);
      g.fillRect(x1, RULER_H, Math.max(0, w - x1), h - RULER_H);
    }
  });

  // Pinned summary row: every key of the clip, one diamond per frame, sliced by key type.
  const summary = tlRows[0]!;
  drawRowBase(summary, RULER_H, 0);
  inKeys(() => {
    g.save();
    g.beginPath();
    g.rect(LABEL_W + 1, RULER_H, Math.max(0, w - LABEL_W - 1), ROW_H);
    g.clip();
    drawRowKeys(summary, RULER_H);
    g.restore();
  });
  g.fillStyle = "#34405a";
  g.fillRect(0, SCROLL_Y - 1, w, 1);

  positionEventTools(visible);
  if (boxRect) {
    g.fillStyle = "rgba(95,179,255,0.14)";
    g.strokeStyle = "#5fb3ff";
    g.fillRect(boxRect.x0, boxRect.y0, boxRect.x1 - boxRect.x0, boxRect.y1 - boxRect.y0);
    g.strokeRect(boxRect.x0, boxRect.y0, boxRect.x1 - boxRect.x0, boxRect.y1 - boxRect.y0);
  }
  if (tlSnapFrame !== null) {
    const sx = Math.round(frameX(tlSnapFrame, w)) + 0.5;
    g.save();
    g.strokeStyle = "#5fb3ff";
    g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(sx, RULER_H);
    g.lineTo(sx, h);
    g.stroke();
    g.restore();
  }
  g.fillStyle = "#2d3443";
  g.fillRect(LABEL_W, RULER_H, 1, h - RULER_H);
  const rest = tlRows.length - 1;
  if (rest > visible) {
    // A thin scrollbar replaces the old "rows a-b of n (wheel)" text.
    const trackH = h - SCROLL_Y - 4;
    const thumbH = Math.max(14, (trackH * visible) / rest);
    const thumbY = SCROLL_Y + 2 + ((trackH - thumbH) * rowScroll) / Math.max(1, rest - visible);
    g.fillStyle = "rgba(140,150,168,0.45)";
    g.fillRect(LABEL_W - 4, thumbY, 3, thumbH);
  }

  decorateTimeline(g, (f) => frameX(f, w), w, h, RULER_H);
  // Current frame: a line through every row and a numbered flag on the ruler, always readable.
  inKeys(() => {
    g.strokeStyle = "#f0b84a";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(playX, RULER_H);
    g.lineTo(playX, h);
    g.stroke();
    g.lineWidth = 1;
    const text = String(playFrame);
    g.font = "bold 11px Segoe UI, system-ui, sans-serif";
    const fw = Math.max(22, g.measureText(text).width + 10);
    const fx = Math.max(LABEL_W + 1, Math.min(w - fw - 1, playX - fw / 2));
    g.fillStyle = "#f0b84a";
    g.fillRect(fx, 1, fw, RULER_H - 5);
    g.beginPath();
    g.moveTo(playX - 5, RULER_H - 4);
    g.lineTo(playX + 5, RULER_H - 4);
    g.lineTo(playX, RULER_H);
    g.closePath();
    g.fill();
    g.fillStyle = "#14171d";
    g.textAlign = "center";
    g.fillText(text, fx + fw / 2, 14);
    g.textAlign = "start";
    g.font = "12px Segoe UI, system-ui, sans-serif";
  });
  syncTlControls();
  graph?.draw();
  audioTrack?.draw();
}

// ---------------------------------------------------------------------------------------------
// Graph editor (value-over-time curves; the panel is graphPanel.ts, the maths graphModel.ts)
// ---------------------------------------------------------------------------------------------

let graph: GraphPanel | null = null;

/** Bones the graph shows: the selected bone plus the bones of the selected dopesheet keys. */
function graphBones(): string[] {
  const names = new Set<string>();
  if (selected) names.add(selected);
  for (const k of keySel) if (k.row.startsWith("bone:")) names.add(rowBone(k.row)!);
  return [...names].filter((n) => boneChannels(clip, n).length);
}

function renderGraphBar(): void {
  if (!graph) return;
  const bar = $("graphbar");
  const g = graph;
  bar.replaceChildren();
  const on = new Set(g.channels());
  // Two groups: the channel chips in a scroller, then the frame / keys / value tools.
  const chans = el("div", { className: "gb-group gb-chans" });
  const tools = el("div", { className: "gb-group gb-tools" });
  bar.append(chans, tools);
  chans.append(el("span", { className: "label", textContent: "Graph" }));
  for (const c of GRAPH_CHANNELS) {
    const b = el("button", { className: `chip${on.has(c.id) ? " on" : ""}`, textContent: c.label, title: `Show or hide the ${c.label} curve` });
    b.style.borderColor = c.color;
    if (on.has(c.id)) b.style.background = c.color + "33";
    b.dataset.channel = c.id;
    b.addEventListener("click", () => g.toggleChannel(c.id));
    chans.append(b);
  }
  const btn = (text: string, title: string, fn: () => void, into: HTMLElement = tools) => {
    const b = el("button", { textContent: text, title });
    b.addEventListener("click", fn);
    into.append(b);
    return b;
  };
  btn("All", "Show every channel", () => g.setChannels(GRAPH_CHANNELS.map((c) => c.id)), chans);
  btn("Frame all", "Fit the window to every shown curve (double-click the graph)", () => g.frameAll()).id = "graphframeall";
  btn("Frame keys", "Fit the window to the selected keys", () => g.frameSelected());
  btn("+", "Zoom in", () => g.zoom(0.8));
  btn("-", "Zoom out", () => g.zoom(1.25));
  tools.append(el("span", { className: "label", textContent: "Keys", style: "margin-left: 6px" }));
  for (const k of ["linear", "stepped", "bezier"] as const) {
    btn(k[0]!.toUpperCase() + k.slice(1), `Make the selected keys' shown curves ${k} (bezier shows draggable handles)`, () => {
      if (!g.setInterp(k)) status("Select keys in the graph or dopesheet first");
    });
  }
  tools.append(el("span", { className: "label", textContent: "Tangent", style: "margin-left: 6px" }));
  for (const [mode, label, tip] of [["smooth", "Smooth", "Smooth tangent: the curve flows through the neighbouring keys"], ["flat", "Flat", "Flat tangent: the curve levels off at the key (ease in and out)"], ["auto", "Auto", "Auto tangent: smooth, but flat at peaks and never overshooting"]] as const) {
    btn(label, `${tip}. Applies to the selected keys' curves`, () => {
      if (!g.setTangentMode(mode)) status("Select keys with a curve segment in the graph or dopesheet first");
    }).id = `graphtan-${mode}`;
  }
  const link = btn(g.linked() ? "Linked" : "Broken", "Handles: Linked keeps both handles of a key in one line when you drag one; Broken lets each side move alone", () => g.setLinked(!g.linked()));
  link.id = "graphlinked";
  link.classList.toggle("on", g.linked());
  const f = g.focus();
  const val = el("input", { type: "number", step: "0.1", title: "Value of the focused key (click a key in the graph)" });
  val.id = "graphvalue";
  const fk = f ? channelKeys(clip, f.bone, f.channel).find((k) => Math.abs(k.time - f.time) < KEY_EPSILON) : undefined;
  val.disabled = !fk;
  val.value = fk ? String(fk.value) : "";
  val.addEventListener("change", () => {
    const v = Number(val.value);
    if (Number.isFinite(v)) g.setFocusValue(v);
  });
  tools.append(el("span", { className: "label", textContent: f ? `${f.bone} ${channelById(f.channel).label}` : "Value", style: "margin-left: 6px; max-width: 150px; overflow: hidden; text-overflow: ellipsis" }), val);
}

function setGraphOpen(on?: boolean): void {
  if (!graph) return;
  const open = on ?? !graph.open;
  graph.setOpen(open);
  $("app").classList.toggle("graphopen", open);
  $("graphbtn").classList.toggle("on", open);
  renderGraphBar();
  requestAnimationFrame(fit);
  drawTimeline();
}

function wireGraph(): void {
  graph = createGraphPanel({
    canvas: $<HTMLCanvasElement>("gr"),
    getClip: () => clip,
    bones: graphBones,
    selectedBone: () => selected,
    keySel: () => keySel,
    setKeySelection,
    time: () => displayTime(),
    setTime: (t) => setTime(t),
    selectBone: (name) => {
      if (name !== selected) select(name);
    },
    preview: (next, sel) => {
      if (sel) keySel = sel;
      previewClip(next);
    },
    commit: (origin, message) => {
      undoStack.push({ name: clipName, clip: origin, label: stepLabel(message) });
      if (undoStack.length > 200) undoStack.shift();
      redoStack.length = 0;
      dirty.add(clipName);
      clearPending();
      renderAll();
      status(message);
    },
    changed: renderGraphBar
  });
  $("graphbtn").addEventListener("click", () => setGraphOpen());
}

/** Applies a bone overlay view: derives showBones, lights the buttons, remembers the choice for the current workspace. */
function setBoneView(next: BoneView, remember = true): void {
  boneView = next;
  showBones = next !== "off";
  if (showBones) lastBoneView = next;
  const btn = document.getElementById("bonesvis");
  btn?.classList.toggle("on", showBones);
  const vb = document.getElementById("boneview");
  if (vb) {
    vb.dataset.view = next;
    vb.classList.toggle("on", next === "dim" || next === "chain");
    vb.setAttribute("aria-label", `Bone view: ${BONE_VIEW_LABEL[next]}`);
  }
  if (remember) writeBoneView(workspaceNow?.() ?? "animate", next);
  drawOverlay();
}

/** The view menu under the eye button (and in the canvas menu): all, dimmed, selected chain, hidden. */
function boneViewItems(): MenuItem[] {
  return BONE_VIEWS.map((v) => ({
    label: BONE_VIEW_LABEL[v],
    ...(v === "off" ? { hint: hkKey("bonesOverlay") } : {}),
    checked: boneView === v,
    run: () => {
      setBoneView(v);
      status(`Bones: ${BONE_VIEW_LABEL[v].toLowerCase()}`);
    }
  }));
}

const hkKey = (a: HotkeyAction): string => HOTKEYS.find((h) => h.action === a)?.keys.split(" / ")[0] ?? "";

/** Descendants of a bone (children, their children ...). */
function descendantsOf(name: string): string[] {
  const out: string[] = [];
  const bone = skeleton?.findBone(name);
  const walk = (b: Bone) => {
    for (const k of b.children) {
      out.push(k.data.name);
      walk(k);
    }
  };
  if (bone) walk(bone);
  return out;
}

/** Puts the bones back at their setup pose at the playhead (unkeyed; with Auto key on it is keyed in the same step). */
function resetBonePose(names: readonly string[]): void {
  if (!skeleton || noClipKeys()) return;
  for (const n of names) {
    pending = { ...pending, [n]: 0 };
    pendingMove = { ...pendingMove, [n]: { x: 0, y: 0 } };
    pendingScale = { ...pendingScale, [n]: { x: 1, y: 1 } };
    pendingShear = { ...pendingShear, [n]: { x: 0, y: 0 } };
  }
  markPose();
  if (autoKey) keyAllUnkeyed();
  else status(`Reset ${names.length > 3 ? `${names.length} bones` : names.join(", ")} to the setup pose: not keyed yet`);
  drawOverlay();
  renderDetail();
}

/** The canvas right-click menu (P1-4): a bone under the pointer gets the bone actions, empty space gets the view actions. */
function openCanvasMenu(clientX: number, clientY: number, x: number, y: number): void {
  if (!skeleton || facingRight) return;
  const target = setup.active() ? pickBone(x, y) : grabTargetAt(x, y, false);
  const items: MenuItem[] = [];
  if (target) {
    if (!multi.has(target)) select(target);
    const names = selectedBones();
    const what = names.length > 1 ? `${names.length} bones` : target;
    const noClip = !clipName;
    const clipWhy = "Open or create a clip first";
    if (setup.active()) {
      items.push(
        { label: what, caption: true },
        { label: "Select children", run: () => selectChildren(target) },
        { label: "Frame", hint: hkKey("frameSelection"), run: frameSelection },
        { label: "Hide bone", run: () => hideBoneOnCanvas(names) }
      );
    } else {
      items.push(
        { label: what, caption: true },
        { label: "Key", hint: hkKey("key"), disabled: noClip, why: clipWhy, run: setKey },
        { label: "Reset pose", disabled: noClip, why: clipWhy, run: () => resetBonePose(names) },
        { label: "Select children", separator: true, run: () => selectChildren(target) },
        { label: "Mirror to other side", hint: hkKey("mirror"), disabled: noClip, why: clipWhy, run: () => void mirrorSelection() },
        { label: "Copy pose", hint: hkKey("copy"), run: () => copyPose(true) },
        { label: "Paste pose", hint: hkKey("paste"), disabled: !poseClipboard || noClip, why: poseClipboard ? clipWhy : "Copy a pose first", run: pasteClipboard },
        { label: "Frame", hint: hkKey("frameSelection"), separator: true, run: frameSelection },
        { label: "Hide bone", run: () => hideBoneOnCanvas(names) }
      );
    }
  } else {
    const onion = aids?.info().onion.enabled ?? false;
    items.push(
      { label: "Fit view", hint: hkKey("fitAll"), run: fitSmooth },
      { label: "Frame selection", hint: hkKey("frameSelection"), disabled: !selected, why: "Select a bone first", run: frameSelection },
      { label: boneView === "off" ? "Show bones" : "Hide bones", hint: hkKey("bonesOverlay"), separator: true, run: () => setBoneView(boneView === "off" ? lastBoneView : "off") },
      { label: boneView === "dim" ? "Full-strength bones" : "Dim bones", run: () => setBoneView(boneView === "dim" ? "full" : "dim") },
      { label: "Selected chain only", checked: boneView === "chain", run: () => setBoneView(boneView === "chain" ? "full" : "chain") }
    );
    if (!setup.active()) {
      items.push(
        { label: onion ? "Onion skin off" : "Onion skin on", separator: true, run: () => setOnion({ enabled: !onion }) },
        { label: "Paste pose", hint: hkKey("paste"), disabled: !poseClipboard || !clipName, why: poseClipboard ? "Open or create a clip first" : "Copy a pose first", run: pasteClipboard }
      );
    }
  }
  openContextMenu(clientX, clientY, items, null);
}

/** Selects every bone of the rig (the HUD, the Bones list header and Ctrl+Shift+A). */
function selectAllBones(): void {
  if (!skeleton) return;
  const names = skeleton.bones.map((b) => b.data.name);
  if (!names.length) return;
  setSelection({ active: selected && names.includes(selected) ? selected : names[0]!, names });
  status(`Selected all ${names.length} bones`);
}

/** Selects the active bone and everything below it. */
function selectBranch(): void {
  if (!selected) return void status("Select a bone first", "bad");
  selectChildren(selected);
}

/** Selects a bone and everything below it. */
function selectChildren(name: string): void {
  const kids = descendantsOf(name);
  if (!kids.length) return void status(`${name} has no child bones`);
  setSelection({ active: name, names: [name, ...kids] });
  status(`Selected ${name} and its ${kids.length} child bone${kids.length === 1 ? "" : "s"}`);
}

/** Hides bones from the canvas the way the Tree's eye does (the eye shows them again). */
function hideBoneOnCanvas(names: readonly string[]): void {
  for (const n of names) hideOutlinerBone(n);
  setSelection({ active: null, names: [] });
  status(`Hid ${names.length > 3 ? `${names.length} bones` : names.join(", ")} (the Tree eye shows ${names.length === 1 ? "it" : "them"} again)`);
}

const MENU_CURVES = ["linear", "stepped", "ease-in", "ease-out", "ease-in-out"] as const;

/** The timeline's right-click menu (P1-4): key actions when keys are selected, else the frame under the pointer. */
function timelineMenuItems(frame: number): MenuItem[] {
  const hk = (a: HotkeyAction) => HOTKEYS.find((h) => h.action === a)?.keys.split(" / ")[0] ?? "";
  const live = liveSelection(clip, keySel);
  const items: MenuItem[] = [];
  const evKey = live.find((k) => k.row === "event");
  if (evKey) {
    const names = eventsAt(clip, evKey.time).map((e) => e.name);
    items.push({ label: "Change event to", caption: true });
    for (const n of rigEventNames()) items.push({ label: n, checked: names.includes(n), run: () => renameEventsAt(evKey.time, n) });
    items.push({ label: "Delete event", separator: true, run: () => commit(deleteEvent(clip, evKey.time), `Removed the event on frame ${timeToFrame(clip, evKey.time)}`) });
  }
  if (live.length) {
    const noun = `${live.length} key${live.length === 1 ? "" : "s"}`;
    const lowest = Math.min(...live.map((k) => timeToFrame(clip, k.time)));
    const playFrame = timeToFrame(clip, time);
    items.push(
      { label: `Copy ${noun}`, hint: hk("copy"), run: copySelectedKeys },
      { label: `Paste at frame ${frame}`, hint: hk("paste"), disabled: !keyBoard, why: "Copy some keys first", run: () => pasteKeyBoard(frame) },
      { label: `Delete ${noun}`, hint: hk("deleteKey"), run: deleteKey },
      { label: "Move to playhead", disabled: lowest === playFrame, why: "The first selected key is already at the playhead", run: () => moveSelectedKeys(playFrame - lowest) },
      { label: "Nudge 1 frame later", hint: hk("nudgeKeysForward"), run: () => moveSelectedKeys(1) },
      { label: "Nudge 1 frame earlier", hint: hk("nudgeKeysBack"), run: () => moveSelectedKeys(-1) },
      { label: "Mirror selected bones", hint: hk("mirror"), run: () => void mirrorSelection() }
    );
    const targets = easingTargets();
    const current = targets[0] ? keyCurveAt(clip, targets[0]) : undefined;
    items.push({ label: "Interpolation", caption: true, separator: true });
    for (const kind of MENU_CURVES) {
      items.push({
        label: CURVE_LABELS[kind],
        disabled: !targets.length,
        why: "Interpolation applies to bone and IK keys",
        checked: current !== undefined && curveKind(current) === kind,
        run: () => {
          clearPending();
          commit(setCurves(clip, targets, CURVE_PRESETS[kind]), `Set ${targets.length} key${targets.length === 1 ? "" : "s"} to ${CURVE_LABELS[kind]}`);
        }
      });
    }
  } else {
    items.push(
      { label: `Key the selected bones at frame ${frame}`, hint: hk("key"), disabled: !selected, why: "Select a bone first", run: () => {
        setTime(frameTime(clip, frame));
        setKey();
      } },
      { label: `Paste keys at frame ${frame}`, hint: hk("paste"), disabled: !keyBoard, why: "Copy some keys first", run: () => pasteKeyBoard(frame) },
      { label: "Go to this frame", run: () => setTime(frameTime(clip, frame)) },
      { label: "Select all keys", hint: hk("selectAllKeys"), separator: true, run: selectAllKeys },
      { label: "Fit the clip in the timeline", run: () => $("tlfit").click() }
    );
  }
  return items;
}

const TL_H_KEY = "atlas-animator-timeline-height";

/** The draggable edge on top of the dopesheet (P1-1): drag, arrow keys, double-click; the height is remembered. */
function wireTimelineSplit(): void {
  const bar = $("tlsplit");
  const app = $("app");
  const lower = $("lower");
  let wanted: number | null = null;
  try {
    wanted = parseTlHeight(localStorage.getItem(TL_H_KEY));
  } catch {
    wanted = null;
  }
  const current = () => lower.getBoundingClientRect().height;
  const paint = () => {
    if (wanted === null) {
      app.classList.remove("tlsized");
      app.style.removeProperty("--lower-h");
    } else {
      app.classList.add("tlsized");
      app.style.setProperty("--lower-h", `${clampTlHeight(wanted, window.innerHeight)}px`);
    }
    const h = Math.round(current());
    bar.setAttribute("aria-valuenow", String(h));
    bar.setAttribute("aria-valuemin", String(clampTlHeight(0, window.innerHeight)));
    bar.setAttribute("aria-valuemax", String(clampTlHeight(1e6, window.innerHeight)));
    drawTimeline();
  };
  const set = (h: number | null, persist: boolean) => {
    wanted = h === null ? null : clampTlHeight(h, window.innerHeight);
    paint();
    if (!persist) return;
    try {
      if (wanted === null) localStorage.removeItem(TL_H_KEY);
      else localStorage.setItem(TL_H_KEY, String(wanted));
    } catch {
      /* private window: the size just is not remembered */
    }
  };
  let drag: { y: number; h: number } | null = null;
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, h: current() };
    bar.classList.add("drag");
    document.body.classList.add("tlresizing");
  });
  bar.addEventListener("pointermove", (e) => {
    if (drag) set(drag.h + (drag.y - e.clientY), false);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    bar.classList.remove("drag");
    document.body.classList.remove("tlresizing");
    set(wanted ?? current(), true);
  };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
  bar.addEventListener("dblclick", () => {
    const top = clampTlHeight(1e6, window.innerHeight);
    set(current() >= top - 4 ? null : top, true);
  });
  bar.addEventListener("keydown", (e) => {
    const big = e.shiftKey ? 3 : 1;
    if (e.key === "ArrowUp") set(current() + TL_STEP_PX * big, true);
    else if (e.key === "ArrowDown") set(current() - TL_STEP_PX * big, true);
    else if (e.key === "Home") set(1e6, true);
    else if (e.key === "End") set(0, true);
    else if (e.key === "Enter") set(null, true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  window.addEventListener("resize", () => {
    closeContextMenu();
    if (wanted !== null) paint();
  });
  // Alt+Up / Alt+Down: taller / shorter dopesheet from anywhere (Shift = three steps), the keyboard twin of dragging the top edge.
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    if (!document.body.classList.contains("ws-animate") || document.body.classList.contains("setup") || $("app").classList.contains("graphopen")) return;
    e.preventDefault();
    const step = TL_STEP_PX * (e.shiftKey ? 3 : 1);
    set(current() + (e.key === "ArrowUp" ? step : -step), true);
    status(`Timeline ${Math.round(current())} px tall`);
  });
  if (wanted !== null) paint();
}

function wireTimeline(): void {
  type TlDrag =
    | { kind: "scrub" }
    | { kind: "pan"; x0: number; start0: number }
    | { kind: "range"; anchor: number }
    | { kind: "move"; origin: ClipData; sel: KeySel[]; startFrame: number; df: number }
    | { kind: "box"; x0: number; y0: number; shift: boolean; moved: boolean }
    | null;
  let tlDrag: TlDrag = null;
  const at = (e: PointerEvent | WheelEvent) => {
    const rect = tl.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width };
  };
  const clampFrame = (x: number, w: number) => Math.max(0, Math.min(frameCount(clip), xToFrame(x, w)));
  const markerAt = (p: { x: number; y: number; w: number }): { row: TlRow; time: number } | null => {
    if (p.y <= RULER_H || p.x < LABEL_W) return null;
    const row = rowAtY(p.y);
    if (!row) return null;
    const reach = Math.max(7, Math.abs(frameX(1, p.w) - frameX(0, p.w)) * 0.45);
    let best: { row: TlRow; time: number } | null = null;
    let bestD = reach;
    for (const time of tlRowTimes(row)) {
      const d = Math.abs(frameX(timeToFrame(clip, time), p.w) - p.x);
      if (d <= bestD) {
        bestD = d;
        best = { row, time };
      }
    }
    return best;
  };
  tl.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return; // the context menu owns the right button
    const p = at(e);
    hideTlTip();
    tl.setPointerCapture(e.pointerId);
    // Middle button (or Space) drags the view sideways.
    if (e.button === 1 || (e.button === 0 && spaceDown && p.x >= LABEL_W)) {
      e.preventDefault();
      tlDrag = { kind: "pan", x0: p.x, start0: tlView.start };
      return;
    }
    if (p.y > RULER_H) {
      const row = rowAtY(p.y);
      if (row?.kind === "bone" && p.x < 16 && clip.bones[row.name]) {
        if (tlExpanded.has(row.name)) tlExpanded.delete(row.name);
        else tlExpanded.add(row.name);
        drawTimeline();
        return;
      }
      if (row?.kind === "bone" || row?.kind === "chan" || row?.kind === "curve") select(row.name);
      if (row?.kind === "curve" && p.x >= LABEL_W) {
        if (playing) setPlaying(false);
        const hit = curveHit(p);
        if (hit?.key !== null && hit?.key !== undefined) {
          setKeySelection(selectKeys(keySel, [{ row: boneChannelRow(hit.row.name, graphProperty(hit.row.ch!)), time: hit.key }], e.shiftKey ? "add" : "replace"));
          setTime(hit.key);
        } else if (hit?.seg) {
          const ref = hit.seg.ref;
          if (e.shiftKey || e.ctrlKey || e.metaKey) segSel = hasSeg(segSel, ref) ? segSel.filter((r) => !sameSeg(r, ref)) : [...segSel, ref];
          else segSel = [ref];
          graph?.setFocus(ref.bone, ref.channel, ref.time);
          segPickerAt = { x: e.clientX, y: e.clientY, color: channelById(ref.channel).color };
          openSegPicker();
        } else {
          segSel = [];
          segPicker.close();
          drawTimeline();
        }
        return;
      }
      if (row?.kind === "slot") selectSlot(row.name);
      if (row?.kind === "deform") selectSlot(row.name.split("/")[1]!);
      if (p.x < LABEL_W) return;
      if (playing) setPlaying(false);
      const hit = markerAt(p);
      if (hit) {
        const keys = keysOfMarker(hit.row, hit.time);
        const already = keys.every((k) => isSelected(keySel, k.row, k.time));
        const toggle = e.ctrlKey || e.metaKey;
        if (toggle) setKeySelection(selectKeys(keySel, keys, "toggle"));
        else if (e.shiftKey) setKeySelection(selectKeys(keySel, keys, already ? "toggle" : "add"));
        else if (!already) setKeySelection(selectKeys(keySel, keys, "replace"));
        if (!e.shiftKey && !toggle) {
          if (hit.row.kind === "bone" || hit.row.kind === "chan") select(hit.row.name);
          setTime(hit.time);
        }
        if (toggle && already) return; // toggled off: nothing to drag
        tlDrag = { kind: "move", origin: clip, sel: [...keySel], startFrame: clampFrame(p.x, p.w), df: 0 };
        return;
      }
      tlDrag = { kind: "box", x0: p.x, y0: p.y, shift: e.shiftKey || e.ctrlKey || e.metaKey, moved: false };
      return;
    }
    if (p.x < LABEL_W) return;
    if (playing) setPlaying(false);
    if (e.shiftKey) {
      const f = clampFrame(p.x, p.w);
      tlDrag = { kind: "range", anchor: f };
      setPlayRange(f, f);
      return;
    }
    tlDrag = { kind: "scrub" };
    setTime(frameTime(clip, clampFrame(p.x, p.w)));
  });
  tl.addEventListener("pointermove", (e) => {
    if (!tlDrag) {
      hoverKey(e);
      return;
    }
    const p = at(e);
    if (tlDrag.kind === "pan") {
      const ppf = keyWidth(p.w) / tlView.span;
      setTlView({ start: tlDrag.start0 - (p.x - tlDrag.x0) / ppf, span: tlView.span });
    } else if (tlDrag.kind === "scrub") {
      const f = clampFrame(p.x, p.w);
      if (f !== timeToFrame(clip, time)) setTime(frameTime(clip, f));
    } else if (tlDrag.kind === "range") {
      setPlayRange(tlDrag.anchor, clampFrame(p.x, p.w));
    } else if (tlDrag.kind === "move") {
      let df = clampFrame(p.x, p.w) - tlDrag.startFrame;
      tlSnapFrame = null;
      if (e.shiftKey) {
        // Shift snaps the moved keys onto a neighbouring (unselected) key.
        const origin = tlDrag.origin;
        const moving = liveSelection(origin, tlDrag.sel);
        const others = new Set(allKeys(origin).filter((k) => !isSelected(moving, k.row, k.time)).map((k) => timeToFrame(origin, k.time)));
        const snap = snapDelta(moving.map((k) => timeToFrame(origin, k.time)), [...others], df);
        if (snap) {
          df = snap.delta;
          tlSnapFrame = snap.to;
        }
      }
      showTlTip(e.clientX, e.clientY, `${df > 0 ? "+" : ""}${df} frame${Math.abs(df) === 1 ? "" : "s"}`);
      if (df !== tlDrag.df) {
        tlDrag.df = df;
        const r = moveKeys(tlDrag.origin, tlDrag.sel, df);
        keySel = r.sel;
        previewClip(r.clip);
      } else drawTimeline();
    } else if (tlDrag.kind === "box") {
      if (!tlDrag.moved && Math.hypot(p.x - tlDrag.x0, p.y - tlDrag.y0) < 4) return;
      tlDrag.moved = true;
      boxRect = { x0: Math.min(tlDrag.x0, p.x), y0: Math.min(tlDrag.y0, p.y), x1: Math.max(tlDrag.x0, p.x), y1: Math.max(tlDrag.y0, p.y) };
      drawTimeline();
    }
  });
  /** Key hover (P1-3): enlarge + glow the key under the pointer and say what it is. */
  const hoverKey = (e: PointerEvent) => {
    const over = curveHit(at(e));
    if (over) {
      const seg = over.seg;
      const nextSeg = seg && over.key === null ? seg.ref : null;
      tl.style.cursor = over.key !== null || seg ? "pointer" : "";
      if (over.key !== null) showTlTip(e.clientX, e.clientY, `${channelById(over.row.ch!).label} key at frame ${timeToFrame(clip, over.key)}: click to select it`);
      else if (seg) {
        const spec = segmentCurve(clip, seg.ref);
        showTlTip(e.clientX, e.clientY, `${channelById(seg.ref.channel).label}, frames ${timeToFrame(clip, seg.a.time)} to ${timeToFrame(clip, seg.b.time)}: ${SEG_PRESETS.find((q) => q.id === presetOf(spec))?.label ?? "Custom curve"}. Click to change the easing`);
      } else hideTlTip();
      if ((nextSeg === null) !== (tlHoverSeg === null) || (nextSeg && tlHoverSeg && !sameSeg(nextSeg, tlHoverSeg))) {
        tlHoverSeg = nextSeg;
        drawTimeline();
      }
      return;
    }
    if (tlHoverSeg) {
      tlHoverSeg = null;
      drawTimeline();
    }
    const hit = markerAt(at(e));
    const next = hit ? { sig: rowSig(hit.row), time: hit.time } : null;
    tl.style.cursor = hit ? "pointer" : "";
    if (hit) {
      const frame = timeToFrame(clip, hit.time);
      const picked = isSelected(keySel, rowIdOf(hit.row) ?? "draw", hit.time);
      showTlTip(e.clientX, e.clientY, `${keyHoverText(clip, hit.row, hit.time, frame)}${picked ? " (selected)" : ""}`);
    } else hideTlTip();
    if (next?.sig !== tlHover?.sig || next?.time !== tlHover?.time) {
      tlHover = next;
      drawTimeline();
    }
  };
  tl.addEventListener("pointerleave", () => {
    if (tlDrag) return;
    tl.style.cursor = "";
    if (tlHover) {
      clearTlHover();
      drawTimeline();
    } else hideTlTip();
  });
  // Double-click a key: the value popover (type 12, Enter sets 12).
  tl.addEventListener("dblclick", (e) => {
    if (noClipKeys() || tlDrag) return;
    const rect = tl.getBoundingClientRect();
    const hit = markerAt({ x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width });
    if (!hit) return;
    const keys = keysOfMarker(hit.row, hit.time);
    const first = keys[0];
    if (!first) return;
    setKeySelection(selectKeys(keySel, keys, "replace"));
    keyInspector?.openPopover(first.row, first.time, e.clientX + 10, Math.max(8, e.clientY - 150));
  });
  tl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (noClipKeys() || tlDrag) return;
    const p = at(e);
    clearTlHover();
    if (p.x < LABEL_W) return;
    const hit = p.y > RULER_H ? markerAt(p) : null;
    if (hit) {
      const keys = keysOfMarker(hit.row, hit.time);
      if (!keys.every((k) => isSelected(keySel, k.row, k.time))) setKeySelection(selectKeys(keySel, keys, "replace"));
      if (hit.row.kind === "bone" || hit.row.kind === "chan") select(hit.row.name);
    }
    drawTimeline();
    openContextMenu(e.clientX, e.clientY, timelineMenuItems(clampFrame(p.x, p.w)), null);
  });
  const finish = (e: PointerEvent) => {
    const d = tlDrag;
    tlDrag = null;
    tlSnapFrame = null;
    hideTlTip();
    if (!d) return;
    const p = at(e);
    if (d.kind === "move") {
      if (clip !== d.origin) {
        const moved = nudgeLabel(keySel.length, d.df);
        selOf.set(d.origin, d.sel);
        undoStack.push({ name: clipName, clip: d.origin, label: moved });
        if (undoStack.length > 200) undoStack.shift();
        redoStack.length = 0;
        dirty.add(clipName);
        clearPending();
        renderAll();
        status(moved);
      }
    } else if (d.kind === "box") {
      if (!d.moved) {
        if (!d.shift) setKeySelection([]);
        setTime(frameTime(clip, clampFrame(p.x, p.w)));
      } else if (boxRect) {
        const box = boxRect;
        boxRect = null;
        setKeySelection(selectKeys(keySel, keysInBox(box, p.w), d.shift ? "add" : "replace"));
        status(`Selected ${keySel.length} keys`);
      }
    }
    boxRect = null;
    drawTimeline();
  };
  tl.addEventListener("pointerup", finish);
  tl.addEventListener("pointercancel", finish);
  // Wheel over the keys zooms about the cursor, Shift + wheel (or a sideways wheel) pans, wheel over the names scrolls the rows.
  tl.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = at(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
      if (p.x < LABEL_W || e.altKey) {
        rowScroll += dy > 0 ? 2 : -2;
        drawTimeline();
        return;
      }
      const n = frameCount(clip);
      if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        const d = e.shiftKey && Math.abs(dx) <= Math.abs(dy) ? dy : dx;
        setTlView(panView(tlView, d / (keyWidth(p.w) / tlView.span), n));
        return;
      }
      const anchor = xToFrameFloat(tlView, p.x, keyLeft(), keyWidth(p.w));
      setTlView(zoomView(tlView, Math.exp(-dy * 0.002), anchor, n));
    },
    { passive: false }
  );
  $("tlfit").addEventListener("click", () => setTlView(tlView, true));
  $("tlzoom").addEventListener("input", (e) => {
    const n = frameCount(clip);
    const span = sliderToSpan(Number((e.target as HTMLInputElement).value) / 1000, n);
    const mid = tlView.start + tlView.span / 2;
    setTlView(zoomView(tlView, tlView.span / span, mid, n));
  });
  $("tlpan").addEventListener("input", (e) => {
    const room = Math.max(0, frameCount(clip) - tlView.span);
    setTlView({ start: (Number((e.target as HTMLInputElement).value) / 1000) * room, span: tlView.span });
  });
  new ResizeObserver(() => drawTimeline()).observe(tl);
}

/** Keys whose markers lie inside a timeline-canvas rectangle. */
function keysInBox(box: { x0: number; y0: number; x1: number; y1: number }, width: number): KeySel[] {
  const out: KeySel[] = [];
  tlRows.forEach((row, i) => {
    const top = rowTop(i);
    if (i > 0 && top < SCROLL_Y - 1) return;
    if (top + ROW_H < box.y0 || top > box.y1) return;
    for (const time of tlRowTimes(row)) {
      const x = frameX(timeToFrame(clip, time), width);
      if (x >= box.x0 - 4 && x <= box.x1 + 4) out.push(...keysOfMarker(row, time));
    }
  });
  return out;
}

/** Shows an edited clip without an undo step (a drag in progress); the caller records undo at the end. */
function previewClip(next: ClipData): void {
  clip = next;
  library.set(clipName, clip);
  rebuildState();
  markPose();
  drawTimeline();
}

// ---------------------------------------------------------------------------------------------
// Controls and shortcuts
// ---------------------------------------------------------------------------------------------

function wireControls(): void {
  // The turned pro rig is the only player view and the default, so the header has no view switch; the older turned rigs live under "More".
  const outfitMenu = el("div");
  outfitMenu.id = "outfits-menu";
  const outfitMore = el("button", { textContent: "Rigs \u25BE", title: "Pick a rig: your own rigs, the default player (Player v2), and the old retired rigs" });
  outfitMore.id = "outfits-more";
  outfitMore.setAttribute("aria-haspopup", "true");
  const closeOutfitMenu = (): void => outfitMenu.classList.remove("open");
  // Groups: Your rigs (made with New rig), Player (Player v2, the default), then the retired rigs behind a visible toggle.
  const group = (title: string, id: string): HTMLElement => {
    const box = el("div", { className: "outfit-group" });
    box.id = id;
    return box;
  };
  const yoursBox = group("Your rigs", "outfits-yours");
  const yoursEmpty = el("div", { className: "label outfit-empty", textContent: "None yet: use New rig" });
  yoursBox.append(yoursEmpty);
  const playerBox = group("Player", "outfits-player");
  const oldBox = group("Old rigs (retired)", "outfits-old");
  oldBox.hidden = true;
  const oldToggle = el("button", { textContent: "Old rigs (retired) \u25B8", title: "Show or hide the retired rigs: the old Side (pro) rig (still used by the live game), the wide-face turned player and its axe view" });
  oldToggle.id = "outfits-old-toggle";
  oldToggle.setAttribute("aria-expanded", "false");
  oldToggle.addEventListener("click", () => {
    oldBox.hidden = !oldBox.hidden;
    oldToggle.setAttribute("aria-expanded", String(!oldBox.hidden));
    oldToggle.textContent = `Old rigs (retired) ${oldBox.hidden ? "\u25B8" : "\u25BE"}`;
  });
  const oldNote = el("div", { className: "label outfit-note", textContent: "Retired: the old Side (pro) rig and the wide-face player. The live game still uses these files, so they stay; do not start new work on them." });
  oldBox.append(oldNote);
  outfitMenu.append(el("div", { className: "label outfit-head", textContent: "Your rigs" }), yoursBox, el("div", { className: "label outfit-head", textContent: "Player" }), playerBox, oldToggle, oldBox);
  const addOutfitButton = (o: OutfitFixture): void => {
    const mine = DISCOVERED_IDS.has(o.id);
    const current = o.id === DEFAULT_OUTFIT;
    const b = el("button", { textContent: current ? "Player v2 (default)" : o.label, title: `${o.label}: ${o.document}` });
    b.dataset.id = o.id;
    b.addEventListener("click", () => {
      closeOutfitMenu();
      void mountOutfit(o.id);
    });
    if (current) playerBox.append(b);
    else if (mine) {
      yoursEmpty.remove();
      yoursBox.append(b);
    } else oldBox.append(b);
  };
  for (const o of OUTFITS) addOutfitButton(o);
  outfitAdder = addOutfitButton;
  const newRigBtn = el("button", { textContent: "New rig", title: "Make a new rig: blank or the player skeleton, then drop PNG parts or a PSD" });
  newRigBtn.id = "newrig-open";
  newRigBtn.dataset.ws = "rig pro";
  newRigBtn.addEventListener("click", () => openNewRig());
  const rigVersionsBtn = el("button", { textContent: "Versions\u2026", title: "Earlier versions of this rig document (one is kept on every rig write); restore one" });
  rigVersionsBtn.id = "rig-versions";
  rigVersionsBtn.dataset.ws = "rig pro";
  rigVersionsBtn.addEventListener("click", () => void openRigVersions());
  const rigRenameBtn = el("button", { textContent: "Rename rig", title: "Rename the open rig (only rigs made with New rig; the built-in rigs cannot be renamed)" });
  rigRenameBtn.id = "rig-rename";
  rigRenameBtn.dataset.ws = "rig pro";
  rigRenameBtn.addEventListener("click", () => void renameOpenRig());
  const rigDeleteBtn = el("button", { textContent: "Delete rig", title: "Delete the open rig after a confirmation; a copy of its document is kept in Versions (only rigs made with New rig; the built-in rigs cannot be deleted)" });
  rigDeleteBtn.id = "rig-delete";
  rigDeleteBtn.dataset.ws = "rig pro";
  rigDeleteBtn.addEventListener("click", () => void deleteOpenRig());
  const rigPartsBtn = el("button", { textContent: "Add parts", title: "Add parts: pick PNGs or a PSD to add to the open rig's atlas (only rigs made with New rig). Dropping files on the window does the same" });
  rigPartsBtn.id = "rig-add-parts";
  rigPartsBtn.dataset.ws = "rig pro";
  rigPartsBtn.addEventListener("click", () => {
    if (!rig || !DISCOVERED_IDS.has(rig.outfit.id)) return status("Parts can be added to rigs made with New rig; the built-in rigs cannot take them", "bad");
    if (setup.unsavedEdits()) return status("Save the rig first (Ctrl+S): adding parts reloads it", "bad");
    void pickPartFiles().then((f) => (f.length ? addPartsHere(f) : undefined));
  });
  // One "Rig file" menu holds the file-level commands (REDESIGN.md); Delete rig is last, in the danger colour.
  const rigRevertBtn = el("button", { textContent: "Revert to saved", title: "Revert the rig to its saved file: undoes every unsaved Setup edit (Redo brings them back; older file versions are under Versions...)" });
  rigRevertBtn.id = "rig-revert";
  rigRevertBtn.dataset.ws = "rig pro";
  rigRevertBtn.addEventListener("click", () => void setup.api.setupRevert());
  const rigFileMenu = el("div", { className: "menu" });
  rigFileMenu.id = "rig-file-menu";
  rigFileMenu.setAttribute("role", "menu");
  for (const b of [newRigBtn, rigPartsBtn, rigRenameBtn, rigVersionsBtn, rigRevertBtn, rigDeleteBtn]) {
    b.classList.add("menu-item");
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => {
      rigFileMenu.classList.remove("open");
      rigFileBtn.focus();
    }, true);
    rigFileMenu.append(b);
  }
  rigDeleteBtn.classList.add("danger");
  const rigFileBtn = el("button", { textContent: "Rig file ▾", className: "btn", title: "Rig file: New rig, Add parts, Rename rig, Versions, Revert to saved, Delete rig" });
  rigFileBtn.id = "rig-file";
  rigFileBtn.dataset.ws = "rig pro";
  rigFileBtn.setAttribute("aria-haspopup", "true");
  rigFileBtn.setAttribute("aria-controls", "rig-file-menu");
  rigFileBtn.addEventListener("click", () => {
    const r = rigFileBtn.getBoundingClientRect();
    rigFileMenu.style.left = `${Math.max(8, Math.min(window.innerWidth - 208, r.left))}px`;
    rigFileMenu.style.top = `${r.bottom + 4}px`;
    rigFileMenu.classList.toggle("open");
    rigFileBtn.setAttribute("aria-expanded", String(rigFileMenu.classList.contains("open")));
  });
  document.addEventListener("pointerdown", (e) => {
    if (rigFileMenu.classList.contains("open") && !rigFileMenu.contains(e.target as Node) && e.target !== rigFileBtn) rigFileMenu.classList.remove("open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && rigFileMenu.classList.contains("open")) {
      rigFileMenu.classList.remove("open");
      rigFileBtn.focus();
    }
  });
  $("outfits").append(outfitMore, outfitMenu, rigFileBtn, rigFileMenu);
  outfitMore.addEventListener("click", () => {
    const r = outfitMore.getBoundingClientRect();
    outfitMenu.style.left = `${Math.max(8, Math.min(window.innerWidth - 168, r.left))}px`;
    outfitMenu.style.top = `${r.bottom + 4}px`;
    outfitMenu.classList.toggle("open");
  });
  document.addEventListener("pointerdown", (e) => {
    if (outfitMenu.classList.contains("open") && !outfitMenu.contains(e.target as Node) && e.target !== outfitMore) closeOutfitMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeOutfitMenu();
  });
  for (const bg of BACKGROUNDS) {
    const b = el("button", { className: `swatch${bg.color === background ? " on" : ""}`, title: bg.name });
    b.style.background = `#${bg.color.toString(16).padStart(6, "0")}`;
    b.addEventListener("click", () => {
      background = bg.color;
      app.renderer.background.color = bg.color;
      requestRender();
      for (const s of $("bgs").querySelectorAll("button")) s.classList.toggle("on", s === b);
    });
    $("bgs").append(b);
  }
  $<HTMLSelectElement>("clip").addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    const [kind, ...rest] = v.split(":");
    const arg = rest.join(":");
    if (kind === "clip") switchClip(arg);
    else if (kind === "fx") void openFixture(arg).catch((err: unknown) => status(String(err), "bad"));
    else if (kind === "saved") void openSaved(arg);
  });
  $("newclip-open").addEventListener("click", () => {
    // A popover under the New button (fixed, so the header's overflow clip cannot cut it).
    const r = $("newclip-open").getBoundingClientRect();
    const nc = $("newclip");
    nc.classList.add("open");
    nc.style.left = `${Math.max(8, Math.min(window.innerWidth - nc.offsetWidth - 8, r.left))}px`;
    nc.style.top = `${r.bottom + 4}px`;
    $("newclip-name").focus();
  });
  $("newclip-name").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") $("newclip-make").click();
    else if ((e as KeyboardEvent).key === "Escape") $("newclip-cancel").click();
  });
  $("newclip-cancel").addEventListener("click", () => $("newclip").classList.remove("open"));
  $("newclip-make").addEventListener("click", () => {
    const name = $<HTMLInputElement>("newclip-name").value.trim();
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) return status("Clip names use letters, digits, _ . -", "bad");
    if (library.has(name)) return status(`A clip named ${name} exists`, "bad");
    library.set(name, emptyClip(1, false));
    clipOrigin.set(name, "new");
    dirty.add(name);
    $("newclip").classList.remove("open");
    switchClip(name);
  });
  $("save").addEventListener("click", () => void save());
  $("export").addEventListener("click", exportClip);
  $("apply").addEventListener("click", () => void applyToRig());
  $("render").addEventListener("click", () => void renderSheets());
  const spineInput = $<HTMLInputElement>("spine-file");
  $("spine-import").addEventListener("click", () => spineInput.click());
  spineInput.addEventListener("change", () => {
    const file = spineInput.files?.[0];
    spineInput.value = "";
    if (file) void importSpineFile(file);
  });
  $("spine-revert").addEventListener("click", () => void revertSpineImport());
  $("spine-export").addEventListener("click", () => void exportSpineFull());
  $("play").addEventListener("click", () => setPlaying(!playing));
  $("prev").addEventListener("click", () => stepFrame(-1));
  $("next").addEventListener("click", () => stepFrame(1));
  $("held").addEventListener("click", () => {
    held = !held;
    renderClipControls();
    markPose();
  });
  $("loop").addEventListener("click", () => {
    if (!clipName) return status("Open or create a clip first: Loop belongs to a clip", "bad");
    const next = !clip.loop;
    commit(setLoop(clip, next), loopMessage(next));
  });
  const setLength = async (seconds: number): Promise<void> => {
    if (!clipName || !(seconds > 0)) return;
    const { clip: next, dropped } = setDuration(clip, seconds);
    // Shortening can drop keys on any channel: say how many and let the artist cancel ().
    if (dropped > 0 && !(await confirmDialog(`Shorten to ${frameCount(next)} frames?`, `${dropped} key(s) past the new end are removed (bones, slot images and colours, IK, constraint mixes, physics, shape keys, draw order and events). Undo brings them back.`, "Shorten clip", false))) {
      renderClipControls();
      return;
    }
    commit(next, `Length ${next.duration.toFixed(2)} s (${frameCount(next)} frames)${dropped ? `; ${dropped} key(s) past the end removed` : ""}`);
    setTime(Math.min(time, next.duration));
  };
  $("duration").addEventListener("change", (e) => setLength(Number((e.target as HTMLInputElement).value)));
  $("durframes").addEventListener("change", (e) => setLength(Number((e.target as HTMLInputElement).value) / clipFps(clip)));
  $("fps").addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const v = Math.round(Number(input.value));
    if (!clipName || !(v >= 1 && v <= MAX_CLIP_FPS) || v === clipFps(clip)) {
      if (clipName && v > MAX_CLIP_FPS) status(`Frame rate must be 1 to ${MAX_CLIP_FPS} fps (the engine format's limit)`, "bad");
      renderClipControls();
      return;
    }
    // Preview the retime on every channel first: how many times move and which keys collide ().
    const pv = previewClipFps(clip, v);
    const next = pv.clip;
    if (pv.moved > 0 || pv.collisions.length) {
      const lines = pv.collisions.slice(0, 6).map((c) => `${c.channel}: frames ${c.fromFrames.join(" and ")} meet at ${c.frame} (the later key wins)`);
      if (pv.collisions.length > 6) lines.push(`and ${pv.collisions.length - 6} more`);
      const body = `The clip stays ${clip.duration.toFixed(2)} s long (${frameCount(next)} frames at ${v} fps). ${pv.moved} key time(s) move onto the nearest frame across ${pv.channels} channel(s).${pv.collisions.length ? ` ${pv.merged} key(s) collide and merge:
${lines.join("; ")}` : " No keys collide."} Undo brings everything back.`;
      if (!(await confirmDialog(`Change to ${v} fps?`, body, "Change fps", pv.collisions.length > 0))) {
        renderClipControls();
        return;
      }
    }
    commit(next, `Frame rate ${v} fps (${frameCount(next)} frames, ${next.duration.toFixed(2)} s)${pv.moved ? `; ${pv.moved} key time(s) moved onto the new frames` : ""}${pv.merged ? `; ${pv.merged} colliding key(s) merged` : ""}`);
    setTime(Math.min(time, next.duration));
  });
  // Playback speed (): preview only, the authored fps and key times are untouched.
  const speedInput = $("speed") as HTMLInputElement;
  speedInput.addEventListener("change", () => {
    const v = Number(speedInput.value);
    playSpeed = Number.isFinite(v) ? Math.max(0.1, Math.min(2, Math.round(v * 100) / 100)) : 1;
    speedInput.value = String(playSpeed);
    status(playSpeed === 1 ? "Playback at normal speed" : `Playback at ${playSpeed}x speed (preview only: the clip's fps and key times do not change)`);
  });
  // Frame operations ( family): insert / delete frames at the playhead, reverse the selected keys.
  const frameN = (): number => Math.max(1, Math.min(600, Math.round(Number(($("framecount") as HTMLInputElement).value) || 1)));
  $("insframes").addEventListener("click", () => {
    if (noClipKeys()) return;
    const n = frameN();
    const at = timeToFrame(clip, time);
    clearPending();
    commit(insertFrames(clip, at, n), `Inserted ${n} frame${n === 1 ? "" : "s"} at frame ${at}: every key from there on moved ${n} later (clip is ${frameCount(clip) + n} frames)`);
  });
  $("delframes").addEventListener("click", async () => {
    if (noClipKeys()) return;
    const n = frameN();
    const at = timeToFrame(clip, time);
    const r = deleteFrames(clip, at, n);
    if (r.clip === clip) {
      status("Nothing to delete: the clip must keep at least one frame", "bad");
      return;
    }
    if (r.removed > 0 && !(await confirmDialog(`Delete ${n} frame${n === 1 ? "" : "s"} at frame ${at}?`, `${r.removed} key(s) inside those frames are removed and every later key moves ${n} earlier. Undo brings them back.`, "Delete frames", true))) return;
    clearPending();
    commit(r.clip, `Deleted ${n} frame${n === 1 ? "" : "s"} at frame ${at}${r.removed ? `; ${r.removed} key(s) removed` : ""}`);
    setTime(Math.min(time, r.clip.duration));
  });
  $("revkeys").addEventListener("click", () => {
    if (noClipKeys()) return;
    const live = liveSelection(clip, keySel);
    if (live.length < 2) {
      status("Select at least two keys in a row to reverse them", "bad");
      return;
    }
    const r = reverseKeys(clip, keySel);
    clearPending();
    editSelBefore = keySel;
    keySel = r.sel;
    commit(r.clip, `Reversed ${live.length} selected keys (their curves mirror with them)`);
  });
  $("returnstart").addEventListener("click", () => {
    returnToStart = !returnToStart;
    try {
      localStorage.setItem(RETURN_KEY, returnToStart ? "1" : "0");
    } catch {
      // private mode: the choice lasts for this session
    }
    renderClipControls();
  });
  wireEventTools();
  $("autokey").addEventListener("click", toggleAutoKey);
  initHelpMenu({ keys: () => toggleHelp(true) });
  void loadKeymap();
  $("compensate").addEventListener("click", () => toggleCompensate());
  wireCollapsiblePanels();
  $("help").addEventListener("click", (e) => {
    if (e.target === $("help") || (e.target as HTMLElement).id === "helpclose") toggleHelp(false);
  });
  $("selall").addEventListener("click", selectAllKeys);
  wireGraph();
  $("selrange").addEventListener("click", selectRangeKeys);
  $("copykeys").addEventListener("click", copySelectedKeys);
  $("pastekeys").addEventListener("click", () => pasteKeyBoard());
  $("applyscale").addEventListener("click", () => scaleSelectedKeys(Number($<HTMLInputElement>("scalepct").value) / 100));
  $("rangein").addEventListener("click", () => rangeIn());
  $("rangeout").addEventListener("click", () => rangeOut());
  $("rangeclear").addEventListener("click", () => setPlayRange(null));
  $("setkey").addEventListener("click", setKey);
  $("keyall").addEventListener("click", () => {
    if (!selected) return status("Pick a bone first", "bad");
    getHost()?.xform.keyAll();
  });
  $("firstframe").addEventListener("click", () => setTime(0));
  $("lastframe").addEventListener("click", () => setTime(clip.duration));
  $("resetpose").addEventListener("click", () => {
    const names = selectedBones();
    resetBonePose(names.length ? names : (rig?.doc.bones.map((b) => b.name) ?? []));
  });
  $("delkey").addEventListener("click", deleteKey);
  $("copypose").addEventListener("click", () => copyPose());
  wireMirrorBreakdown();
  $("copyposesel").addEventListener("click", () => copyPose(true));
  $("pastepose").addEventListener("click", pasteClipboard);
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("checkclip").addEventListener("click", checkWholeClip);
  $("facingbtn").addEventListener("click", () => setFacing(facingRight ? "left" : "right"));
  $("fit").addEventListener("click", fitSmooth);
  $("zoomin").addEventListener("click", () => zoomAt(1.25, viewEl.clientWidth / 2, viewEl.clientHeight / 2));
  $("zoomout").addEventListener("click", () => zoomAt(1 / 1.25, viewEl.clientWidth / 2, viewEl.clientHeight / 2));
  $("previewbtn").addEventListener("click", () => togglePreview());
  $("gameviewbtn").addEventListener("click", () => toggleGameView());
  $("abpin").addEventListener("click", pinPose);
  $("abghost").addEventListener("click", togglePinGhost);
  $("abswap").addEventListener("click", () => setAbView(!abView));
  $("abclear").addEventListener("click", clearPin);
  updateAbUi();
  $("onionbtn").addEventListener("click", () => setOnion({ enabled: !$("onionbtn").classList.contains("on") }));
  const onionNum = (id: string, key: "before" | "after" | "step") =>
    $(id).addEventListener("change", (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) setOnion({ [key]: v });
    });
  onionNum("onionbefore", "before");
  onionNum("onionafter", "after");
  onionNum("onionstep", "step");
  $("onionopacity").addEventListener("input", (e) => setOnion({ opacity: Number((e.target as HTMLInputElement).value) / 100 }));
  $("onionfalloff").addEventListener("input", (e) => setOnion({ falloff: Number((e.target as HTMLInputElement).value) / 100 }));
  for (const b of document.querySelectorAll<HTMLButtonElement>("#onionmode button")) b.addEventListener("click", () => setOnion({ mode: b.dataset.v === "keys" ? "keys" : "frames", enabled: true }));
  for (const b of document.querySelectorAll<HTMLButtonElement>("#onionstyle button")) b.addEventListener("click", () => setOnion({ style: b.dataset.v === "outline" ? "outline" : "tint", enabled: true }));
  for (const b of document.querySelectorAll<HTMLButtonElement>("#onionscope button")) b.addEventListener("click", () => setOnion({ scope: b.dataset.v === "selected" ? "selected" : "all", enabled: true }));
  $("underinput").addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void loadUnderlay(f).catch((err: unknown) => status(String(err instanceof Error ? err.message : err), "bad"));
  });
  $("underframes").addEventListener("change", (e) => setUnderlay({ frames: Number((e.target as HTMLInputElement).value) }));
  $("underopacity").addEventListener("input", (e) => setUnderlay({ opacity: Number((e.target as HTMLInputElement).value) / 100 }));
  $("underscale").addEventListener("change", (e) => setUnderlay({ scale: Number((e.target as HTMLInputElement).value) / 100 }));
  $("underclear").addEventListener("click", () => {
    aids?.clearUnderlay();
    $<HTMLInputElement>("underinput").value = "";
    markPose();
  });
  renderIkPanel();
  $("silhouette").addEventListener("click", () => setSilhouette());
  $("bonesvis").addEventListener("click", () => setBoneView(boneView === "off" ? lastBoneView : "off"));
  $("boneview").addEventListener("click", (e) => {
    const r = ($("boneview") as HTMLElement).getBoundingClientRect();
    openContextMenu(Math.max(8, r.left - 150), r.bottom + 6, boneViewItems(), $("boneview"));
    e.stopPropagation();
  });
  $("helpersvis").addEventListener("click", () => {
    showHelpers = !showHelpers;
    $("helpersvis").classList.toggle("on", showHelpers);
    drawOverlay();
  });
  $("bonefilter").addEventListener("input", renderBones);
  $<HTMLInputElement>("bonesize").addEventListener("input", (e) => {
    boneSize = Number((e.target as HTMLInputElement).value) / 100;
    drawOverlay();
  });

  // Ctrl+S saves from anywhere, including a text field whose own handler stops the key from bubbling (the outliner search, the split box).
  window.addEventListener(
    "keydown",
    (e) => {
      const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      const setupOn = document.body.classList.contains("setup");
      if (!inField || !(e.ctrlKey || e.metaKey) || hotkeyAction(e, setupOn ? "setup" : "animate") !== "save") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (setupOn) setup.key(e);
      else runHotkey("save");
    },
    true
  );
  window.addEventListener("keydown", (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === " " && !typing) {
      e.preventDefault();
      if (!e.repeat) {
        spaceDown = true;
        spaceTapped = true;
      }
      return;
    }
    if (e.key === "Escape" && drag && cancelDrag()) {
      e.preventDefault();
      return;
    }
    if (drag && !typing && assistKey(e)) return;
    if (!typing && setup.key(e)) return;
    if (!typing && activeCanvasTool()?.onKey?.(e, getHost()!)) return;
    if (helpOpen() && (e.key === "Escape" || e.key === "?" || e.key === "F1")) {
      e.preventDefault();
      toggleHelp(false);
      return;
    }
    // In a number field only Ctrl+S and F1 act; every other key edits the field.
    const action = hotkeyAction(e, document.body.classList.contains("setup") ? "setup" : "animate");
    // A focused dropdown, checkbox, slider or button has no use for Ctrl+Z / Ctrl+Y, so undo and redo pass through them; only a text or number field keeps its own undo.
    const t = e.target;
    const textual = (t instanceof HTMLInputElement && !["checkbox", "radio", "range", "button", "submit", "color", "file"].includes(t.type)) || t instanceof HTMLTextAreaElement;
    const passes = action === "save" || action === "palette" || (action === "help" && e.key === "F1") || ((action === "undo" || action === "redo") && !textual);
    if (!action || (typing && !passes)) return;
    e.preventDefault();
    runHotkey(action);
  });
  // Buttons and dropdowns give the keyboard back to the editor as soon as they are used (a focused select or button swallows hotkeys, Space and Enter).
  document.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement | null)?.closest?.("button");
    if (b instanceof HTMLButtonElement && !b.closest("#help")) b.blur();
  });
  document.addEventListener("change", (e) => {
    if (e.target instanceof HTMLSelectElement) e.target.blur();
  });
  // Number fields: a click selects the text, Enter commits (and gives the keyboard back to the editor), Esc reverts.
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === "number") {
      t.dataset.orig = t.value;
      t.select();
    }
  });
  document.addEventListener(
    "keydown",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.id === "bonefilter" && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          t.value = "";
          renderBones();
        }
        t.blur();
        return;
      }
      if (!(t instanceof HTMLInputElement) || t.type !== "number") return;
      if (e.key === "Enter") {
        e.preventDefault();
        t.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        t.value = t.dataset.orig ?? t.value;
        t.blur();
      }
    },
    true
  );
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      spaceDown = false;
      // A Space tap (no drag in between) toggles playback; Space + drag pans.
      if (spaceTapped && !(e.target instanceof HTMLInputElement)) setPlaying(!playing);
    }
  });
  window.addEventListener("pointermove", () => {
    if (spaceDown && drag?.kind === "pan") spaceTapped = false;
  });
  window.addEventListener("resize", () => drawTimeline());
}

/** The actions that leave the swapped-in pose A on screen (looking around, comparing, help). */
const AB_KEEPS_VIEW: ReadonlySet<HotkeyAction> = new Set<HotkeyAction>(["swapPose", "onion", "onionStyle", "gateHud", "ghostPose", "unpinPose", "palette", "help", "prevFrame", "nextFrame", "prevFrame5", "nextFrame5", "firstFrame", "lastFrame", "frameSelection", "fitAll", "bonesOverlay", "boneView", "phoneSize", "home", "prevPose", "nextPose", "prevKey", "nextKey", "graph", "gameView", "clearSelection"]);

/** The command palette's rows beyond the hotkey table: workspaces, toggles, clips, skins, bones and export (the hotkey rows come from hotkeyActions). */
function registerPaletteActions(): void {
  const animateOnly = (a: HotkeyAction) => (document.body.classList.contains("setup") && !SETUP_SHARED.has(a) ? "Animate mode only" : undefined);
  registerActions("hotkeys", () => hotkeyActions(runHotkey, animateOnly));
  registerActions("workspaces", () =>
    WORKSPACES.map((w, i) => ({ id: `ws:${w.id}`, label: `Go to ${w.label}`, group: "Workspace", keys: `Alt+${i + 1}`, keywords: `workspace switch ${w.id}`, disabled: workspaceNow?.() === w.id ? "Here now" : undefined, run: () => workspaceGo?.(w.id) }))
  );
  registerActions("toggles", () => [
    { id: "toggle:onion-keys", label: aids?.onionOptions().mode === "keys" ? "Onion skin: every frame" : "Onion skin: keys only", group: "Toggle", keywords: "onion ghost neighbouring keys frames mode", run: () => setOnion({ mode: aids?.onionOptions().mode === "keys" ? "frames" : "keys", enabled: true }) },
    { id: "onion:tight", label: "Onion skin: 1 before, 1 after", group: "Toggle", keywords: "onion ghost counts tight", run: () => setOnion({ before: 1, after: 1, enabled: true }) },
    { id: "onion:wide", label: "Onion skin: 4 before, 4 after", group: "Toggle", keywords: "onion ghost counts wide", run: () => setOnion({ before: 4, after: 4, enabled: true }) },
    { id: "onion:past", label: "Onion skin: 3 before, none after", group: "Toggle", keywords: "onion ghost counts past only before", run: () => setOnion({ before: 3, after: 0, enabled: true }) },
    { id: "toggle:curves-open", label: "Dopesheet curves: show for every keyed bone", group: "Toggle", keywords: "dopesheet timeline curves expand graph easing", run: () => {
      for (const b of rig?.doc.bones ?? []) if (clip.bones[b.name]) tlExpanded.add(b.name);
      drawTimeline();
    } },
    { id: "toggle:curves-close", label: "Dopesheet curves: collapse all bones", group: "Toggle", keywords: "dopesheet timeline curves collapse hide", run: () => {
      tlExpanded.clear();
      drawTimeline();
    } },
    { id: "toggle:silhouette", label: "Silhouette on / off", group: "Toggle", keywords: "outline shape black", run: () => $("silhouette").click() },
    { id: "toggle:helpers", label: "Helper bones on / off", group: "Toggle", keywords: "helpers steer ik targets", run: () => $("helpersvis").click() }
  ]);
  registerActions("clips", () => [
    ...[...library.keys()].map((n) => ({ id: `clip:${n}`, label: `Open clip ${n}`, group: "Clip", keywords: "clip animation switch", disabled: n === clipName ? "Open now" : undefined, run: () => switchClip(n) })),
    { id: "clip:new", label: "New clip...", group: "Clip", keywords: "create animation", run: () => $("newclip-open").click() }
  ]);
  registerActions("skins", () => {
    if (!rig) return [];
    const base = baseSkin(rig.doc.skins);
    return Object.keys(rig.doc.skins).map((n) => ({
      id: `skin:${n}`,
      label: n === base ? `Wear the base skin (${n}) alone` : `Wear skin ${n}`,
      group: "Skin",
      keywords: "skin outfit garment wear",
      disabled: rig!.skinChoice === n || (n === base && !rig!.skinChoice) ? "Worn now" : undefined,
      run: () => setActiveSkin(n === base ? null : n)
    }));
  });
  registerActions("export", () => [
    { id: "export:json", label: "Export the clip as JSON", group: "Export", keywords: "download clip.json save file", disabled: clipName ? undefined : "No clip open", run: exportClip },
    { id: "export:apply", label: "Apply the clip to the rig", group: "Export", keywords: "ship rig document", disabled: clipName ? undefined : "No clip open", run: () => $("apply").click() },
    { id: "export:sheets", label: "Render contact sheets", group: "Export", keywords: "sheet frames png", disabled: clipName ? undefined : "No clip open", run: () => $("render").click() }
  ]);
  registerActions("bones", () => (skeleton ? skeleton.bones.map((b) => ({ id: `bone:${b.data.name}`, label: `Select bone ${b.data.name}`, group: "Bone", keywords: "bone joint select", run: () => select(b.data.name) })) : []));
}

/** Runs one keyboard action (see hotkeys.ts for the key map). */
function runHotkey(action: HotkeyAction): void {
  // Viewing pose A is look-only: anything but looking around (or swapping back) returns to the live pose B first.
  if (abView && !AB_KEEPS_VIEW.has(action)) setAbView(false);
  switch (action) {
    case "palette":
      openPalette();
      break;
    case "play":
      setPlaying(!playing);
      break;
    case "pinPose":
      pinPose();
      break;
    case "unpinPose":
      clearPin();
      break;
    case "ghostPose":
      togglePinGhost();
      break;
    case "swapPose":
      setAbView(!abView);
      break;
    case "onion":
      setOnion({ enabled: !aids?.onionOptions().enabled });
      status(aids?.onionOptions().enabled ? "Onion skin on" : "Onion skin off");
      break;
    case "onionStyle": {
      const next = aids?.onionOptions().style === "outline" ? "tint" : "outline";
      setOnion({ style: next, enabled: true });
      status(`Onion skin: ${next === "outline" ? "outline only" : "tinted ghosts"}`);
      break;
    }
    case "gateHud":
      window.atlasGateHud?.toggle();
      break;
    case "rotate":
    case "move":
    case "ik":
      setGizmoMode(action);
      break;
    case "scale":
      setGizmoMode("scale" as GizmoMode);
      break;
    case "graph":
      setGraphOpen();
      break;
    case "gameView":
      toggleGameView();
      break;
    case "key":
      setKey();
      break;
    case "mirror":
      mirrorSelection();
      break;
    case "flipPose":
      flipPose();
      break;
    case "breakdown":
      breakdown();
      break;
    case "deleteKey":
      deleteKey();
      break;
    case "undo":
      undo();
      break;
    case "redo":
      redo();
      break;
    case "prevFrame":
      stepFrame(-1);
      break;
    case "nextFrame":
      stepFrame(1);
      break;
    case "prevFrame5":
      stepFrame(-5);
      break;
    case "nextFrame5":
      stepFrame(5);
      break;
    case "prevKey":
    case "nextKey":
      jumpToKey(action === "nextKey" ? 1 : -1);
      break;
    case "nudgeKeysBack":
      moveSelectedKeys(-1);
      break;
    case "nudgeKeysForward":
      moveSelectedKeys(1);
      break;
    case "nudgeKeysBack5":
      moveSelectedKeys(-5);
      break;
    case "nudgeKeysForward5":
      moveSelectedKeys(5);
      break;
    case "firstFrame":
      setTime(0);
      break;
    case "lastFrame":
      setTime(clip.duration);
      break;
    case "selectRoot":
      selectRoot();
      break;
    case "selectAllBones":
      selectAllBones();
      break;
    case "frameSelection":
      frameSelection();
      break;
    case "fitAll":
      fitSmooth();
      break;
    case "save":
      void save();
      break;
    case "copy":
      if (liveSelection(clip, keySel).length) copySelectedKeys();
      else copyPose();
      break;
    case "paste":
      if (lastCopy === "keys" && keyBoard) pasteKeyBoard();
      else pasteClipboard();
      break;
    case "selectAllKeys":
      selectAllKeys();
      break;
    case "clearSelection":
      clearSelections();
      break;
    case "rangeIn":
      rangeIn();
      break;
    case "rangeOut":
      rangeOut();
      break;
    case "autoKey":
      toggleAutoKey();
      break;
    case "bonesOverlay":
      $("bonesvis").click();
      break;
    case "boneView": {
      const v = nextBoneView(boneView);
      setBoneView(v);
      status(`Bones: ${BONE_VIEW_LABEL[v].toLowerCase()}`);
      break;
    }
    case "phoneSize":
      window.atlasPhone?.toggle();
      break;
    case "facingRight":
      setFacing(facingRight ? "left" : "right");
      status(facingRight ? "Preview facing right (look-only)" : "Preview facing left");
      break;
    case "prevPose":
    case "nextPose":
      jumpToKey(action === "nextPose" ? 1 : -1, true);
      break;
    case "compensate":
      toggleCompensate();
      break;
    case "shapeKeys":
      setCanvasTool(canvasToolId === "shape-keys" ? null : "shape-keys");
      break;
    case "weightsTool":
      if (document.body.classList.contains("ws-animate")) {
        status("Weights are edited in the Rig or Pro workspace (the Animate workspace never edits the rig)");
        break;
      }
      void (async () => {
        await setup.setMode("setup");
        setup.api.setupTool("weights");
      })();
      break;
    case "help":
      toggleHelp();
      break;
    default:
      break;
  }
}

// The right pane is a long stack of panels: a click on a panel heading folds it, and the choice is remembered.
const COLLAPSE_KEY = "atlas-editor-collapsed";
const COLLAPSED_BY_DEFAULT = ["arcpanel", "reducepanel", "lockpanel", "smearpanel", "refpanel"];

function wireCollapsiblePanels(): void {
  let saved: Record<string, boolean> = {};
  try {
    saved = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    saved = {};
  }
  for (const section of $("right").querySelectorAll<HTMLElement>("section.detail[id]")) {
    if (section.id === "detail" || section.id === "ikpanel") continue;
    section.classList.toggle("collapsed", saved[section.id] ?? COLLAPSED_BY_DEFAULT.includes(section.id));
  }
  $("right").addEventListener("click", (e) => {
    const h = (e.target as HTMLElement).closest("h2");
    const section = h?.closest<HTMLElement>("section.detail[id]");
    if (!h || !section || section.id === "detail" || section.id === "ikpanel" || (e.target as HTMLElement).closest("button, input, select")) return;
    const folded = section.classList.toggle("collapsed");
    saved[section.id] = folded;
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(saved));
    } catch {
      // storage can be unavailable (private window); the panel still folds
    }
  });
}

function toggleCompensate(on = !compensate): void {
  compensate = on;
  $("compensate").classList.toggle("on", on);
  refreshStatusBar();
  hostBus.emit("pose");
  status(on ? "Compensate on: moving or rotating a bone keeps its children in place (keyed on them too)" : "Compensate off: children follow their parent");
}

function toggleAutoKey(): void {
  autoKey = !autoKey;
  renderClipControls();
  status(`Auto key ${autoKey ? "on" : "off"}`);
}

/** Drops every unkeyed pose edit (Esc): the bones go back to the clip's pose at the playhead. */
function discardUnkeyed(): void {
  const n = unkeyedNow().length;
  if (!n) return;
  clearPending();
  markPose();
  renderDetail();
  drawOverlay();
  drawTimeline();
  status(discardedMessage(n), "ok");
}

/** Escape: the dopesheet key selection first, then the extra bones of a bone selection, then the bone itself. */
function clearSelections(): void {
  if (keySel.length) setKeySelection([]);
  else if (unkeyedNow().length) discardUnkeyed();
  else if (multi.size > 1 && selected) setSelection({ active: selected, names: [selected] });
  else if (selected) select(null);
}

/** Moves the playhead to the previous / next key of the selected bone (any bone with a key when none is selected). */
function jumpToKey(dir: 1 | -1, anyBone = false): void {
  if (playing) setPlaying(false);
  const times = selected && !anyBone ? boneKeyTimes(clip, selected) : [...new Set(skeleton?.bones.flatMap((b) => boneKeyTimes(clip, b.data.name)) ?? [])];
  const f = timeToFrame(clip, time);
  const frames = [...new Set(times.map((t) => timeToFrame(clip, t)))].sort((a, b) => a - b);
  const target = dir > 0 ? frames.find((k) => k > f) : [...frames].reverse().find((k) => k < f);
  if (target === undefined) return void status(`No ${dir > 0 ? "next" : "previous"} key${selected && !anyBone ? ` on ${selected}` : ""}`);
  setTime(frameTime(clip, target));
}

/** Zooms to the selected bones (the whole character when none is selected). */
/** Shift+R / the Root button: select the master bone (shows the root-motion note in Animate). */
function selectRoot(): void {
  if (!skeleton?.findBone("root")) return status("This rig has no root bone", "bad");
  select("root");
  status(setup.active() ? "Root selected: move, rotate or scale it to place the whole character" : `Root selected: ${ROOT_WARNING}`);
}

function frameSelection(): void {
  if (!skeleton) return;
  const hidden = hiddenNow();
  const pts: { x: number; y: number }[] = [];
  for (const n of multi) {
    const b = skeleton.findBone(n);
    if (!b || hidden.has(n)) continue;
    const { ox, oy, tx, ty } = boneEnds(b);
    pts.push({ x: ox, y: oy }, { x: tx, y: ty });
  }
  if (!pts.length) return fitSmooth();
  frameBounds({ x0: Math.min(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), x1: Math.max(...pts.map((q) => q.x)), y1: Math.max(...pts.map((q) => q.y)) });
}

// ---------------------------------------------------------------------------------------------
// Hotkey cheat sheet
// ---------------------------------------------------------------------------------------------

function helpOpen(): boolean {
  return $("help").classList.contains("open");
}

function toggleHelp(open = !helpOpen()): void {
  const box = $("help");
  box.classList.toggle("open", open);
  if (!open) return;
  const body = $("helpbody");
  body.replaceChildren();
  const keymapBtn = el("button", { type: "button", id: "helpkeymap", textContent: "Edit shortcuts", title: "Rebind any hotkey (Help > Edit keyboard shortcuts)" });
  keymapBtn.addEventListener("click", () => {
    toggleHelp(false);
    openKeymapEditor();
  });
  const tipBtn = el("button", { type: "button", textContent: "Show the canvas tip again", title: "Brings back the one-line tip under the posing canvas" });
  tipBtn.id = "tipshow";
  tipBtn.addEventListener("click", () => setTipHidden(false));
  const filter = el("input", { type: "search", placeholder: "Filter keys and controls", title: "Type to narrow the list (a key, a tool or a control name)" });
  filter.setAttribute("aria-label", "Filter keys and controls");
  filter.id = "helpfilter";
  filter.addEventListener("input", () => filterHelp(body, filter.value));
  body.append(el("div", { className: "help-top" }, filter, keymapBtn, tipBtn), guideBlock(workspaceNow?.() ?? "animate", "wg-sec help-guide"));
  const groups = new Map<string, HotkeyDef[]>();
  for (const h of HOTKEYS) groups.set(h.group, [...(groups.get(h.group) ?? []), h]);
  for (const [group, items] of groups) {
    body.append(el("h3", { textContent: group }));
    for (const h of items) body.append(el("div", { className: "hk" }, el("kbd", { textContent: h.keys }), el("span", { textContent: h.label })));
  }
  body.append(el("h3", { textContent: "Setup mode (these keys replace the Animate ones of the same letter)" }));
  for (const k of SETUP_KEYS) body.append(el("div", { className: "hk" }, el("kbd", { textContent: k.keys }), el("span", { textContent: k.label })));
  body.append(el("h3", { textContent: "Mouse" }));
  for (const g of GESTURES) body.append(el("div", { className: "hk" }, el("kbd", { textContent: g.keys }), el("span", { textContent: g.label })));
  // The right-panel tabs and every control's tooltip come from tooltips.ts, the table the tooltips are drawn from.
  body.append(el("h3", { textContent: "Right panel tabs" }));
  for (const t of TABS) body.append(el("div", { className: "hk" }, el("kbd", { textContent: t.label }), el("span", { textContent: t.tip })));
  body.append(el("h3", { textContent: "Buttons (hover any control for its tip)" }));
  for (const t of TIPS) {
    const target = document.querySelector(t.sel);
    const name = (target?.textContent ?? "").trim() || target?.getAttribute("aria-label") || "";
    if (!target || !name || /^#(newclip|help)/.test(t.sel)) continue;
    body.append(el("div", { className: "hk" }, el("kbd", { textContent: name }), el("span", { textContent: tipText(t) })));
  }
}

/** Hides the cheat-sheet rows that do not match the filter text, and the headings left with nothing under them. */
function filterHelp(body: HTMLElement, text: string): void {
  const q = text.trim().toLowerCase();
  let heading: HTMLElement | null = null;
  let shown = 0;
  const close = () => {
    if (heading) heading.hidden = !!q && shown === 0;
  };
  for (const n of Array.from(body.children) as HTMLElement[]) {
    if (n.tagName === "H3") {
      close();
      heading = n;
      shown = 0;
    } else if (n.classList.contains("hk")) {
      n.hidden = !!q && !(n.textContent ?? "").toLowerCase().includes(q);
      if (!n.hidden) shown++;
    }
  }
  close();
}

let spaceTapped = false;

const ONION_STORE = "atlasEditor.onion";

function setOnion(o: Partial<OnionOptions> & { count?: number }): void {
  aids?.setOnion(o);
  syncOnionControls();
  try {
    const { enabled: _on, ...rest } = aids?.onionOptions() ?? ONION_DEFAULTS;
    localStorage.setItem(ONION_STORE, JSON.stringify(rest));
  } catch {
    // not remembered
  }
  markPose();
}

/** The remembered onion settings (never the on / off switch: a session starts with the onion skin off). */
function loadOnionSettings(): void {
  try {
    const raw = localStorage.getItem(ONION_STORE);
    if (raw) aids?.setOnion({ ...(JSON.parse(raw) as Partial<OnionOptions>), enabled: false });
  } catch {
    // defaults
  }
  syncOnionControls();
}

function syncOnionControls(): void {
  const o = aids?.onionOptions();
  if (!o) return;
  $("onionbtn").classList.toggle("on", o.enabled);
  $("onionbtn").setAttribute("aria-pressed", String(o.enabled));
  $<HTMLInputElement>("onionbefore").value = String(o.before);
  $<HTMLInputElement>("onionafter").value = String(o.after);
  $<HTMLInputElement>("onionstep").value = String(o.step);
  $<HTMLInputElement>("onionstep").disabled = o.mode === "keys";
  $<HTMLInputElement>("onionopacity").value = String(Math.round(o.opacity * 100));
  $<HTMLInputElement>("onionfalloff").value = String(Math.round(o.falloff * 100));
  for (const b of document.querySelectorAll<HTMLButtonElement>("#onionmode button")) b.classList.toggle("on", b.dataset.v === o.mode);
  for (const b of document.querySelectorAll<HTMLButtonElement>("#onionstyle button")) b.classList.toggle("on", b.dataset.v === o.style);
  for (const b of document.querySelectorAll<HTMLButtonElement>("#onionscope button")) b.classList.toggle("on", b.dataset.v === o.scope);
  $("onionfoot").textContent = o.enabled ? `${o.before} before (cool), ${o.after} after (warm), ${o.mode === "keys" ? "neighbouring keys" : o.step > 1 ? `every ${o.step} frames` : "every frame"}` : "Off. Alt+O turns it on.";
}

async function loadUnderlay(file: File): Promise<void> {
  const frames = Math.max(1, Math.round(Number($<HTMLInputElement>("underframes").value)) || 1);
  await aids?.loadUnderlay(file);
  aids?.setUnderlay({ frames, opacity: Number($<HTMLInputElement>("underopacity").value) / 100, scale: Number($<HTMLInputElement>("underscale").value) / 100 });
  markPose();
}

function setUnderlay(o: { opacity?: number; scale?: number; x?: number; y?: number; frames?: number }): void {
  aids?.setUnderlay(o);
  markPose();
}

function setGizmoMode(mode: GizmoMode): void {
  gizmoMode = mode;
  announceTools({ gizmo: mode });
  clearPending();
  drawOverlay();
  renderIkPanel();
  refreshStatusBar();
  status(mode === "scale" ? "Scale gizmo: drag the red / green square handles (x / y) or the centre square (both). Squash and stretch the torso, chest and head; limbs never stretch (warning)" : mode === "shear" ? "Shear gizmo: drag the red / green round handles to skew the bone's x / y axis" : mode === "move" ? "Move gizmo: drag a bone to translate it in its parent's space" : mode === "ik" ? "Hand IK: drag a fist and the arm follows" : "Rotate gizmo: drag a bone to rotate it");
}

function togglePreview(open?: boolean): void {
  if (!preview) return;
  preview.toggle(open);
  $("previewbtn").classList.toggle("on", preview.isOpen());
  markPose();
}

function toggleGameView(open?: boolean): void {
  if (!gameView) return;
  gameView.toggle(open);
  $("gameviewbtn").classList.toggle("on", gameView.isOpen());
  if (gameView.isOpen()) gameView.refresh();
}

function rangeIn(): void {
  const f = timeToFrame(clip, time);
  setPlayRange(f, playRange ? Math.max(f, playRange.b) : frameCount(clip));
}

function rangeOut(): void {
  const f = timeToFrame(clip, time);
  setPlayRange(playRange ? Math.min(f, playRange.a) : 0, f);
}

function stepFrame(d: number): void {
  if (playing) setPlaying(false);
  const n = frameCount(clip);
  let f = timeToFrame(clip, time) + d;
  if (clip.loop) f = ((f % n) + n) % n;
  setTime(frameTime(clip, Math.max(0, Math.min(n, f))));
}

// ---------------------------------------------------------------------------------------------
// Setup mode (rig building): src/setupMode.ts
// ---------------------------------------------------------------------------------------------

/** Rebuilds the shown rig from a changed raw document (Setup mode edits). */
let imagesAdded = false;

async function setRigRaw(raw: JsonObject, parsed?: AnimDocument): Promise<void> {
  if (!rig) return;
  // A Setup edit is now the newest step: Ctrl+Z in the Rig workspace goes back to undoing Setup edits.
  skinTurn = false;
  const outfit = rig.outfit;
  const doc = withEventDefs(parsed ?? loadAnimDocument(raw, { source: outfit.document }));
  rigCache.set(outfit.id, Promise.resolve({ ...rig, raw, doc }));
  reuseAtlas = !imagesAdded;
  imagesAdded = false;
  await mountOutfit(outfit.id);
}

const setup = createSetup({
  drawBones: (px, hide) => drawBones(px, hide),
  rig: () =>
    rig
      ? { outfitId: rig.outfit.id, label: rig.outfit.label, document: rig.outfit.document, atlas: rig.outfit.atlas, name: rigFileName(rig.outfit).replace(/\.anim\.json$/, ""), raw: rig.raw, regions: rig.regions, image: (path) => rig?.images.get(path), skin: Object.keys(rig.doc.skins)[0] ?? "body", standIn: !!rig.outfit.standInWeapon }
      : null,
  skeleton: () => skeleton,
  library: () => library,
  replaceRig: setRigRaw,
  clipsChanged: (changed) => {
    for (const [name, data] of changed) library.set(name, data);
    undoStack.length = 0;
    redoStack.length = 0;
  },
  addImage: (path, image) => {
    imagesAdded = true;
    void rig?.extra.set(path, image);
  },
  selected: () => selected,
  select,
  zoom,
  toSkeleton,
  toClient: (x, y) => {
    const rect = app.canvas.getBoundingClientRect();
    return { x: rect.left + world.x + x * zoom(), y: rect.top + world.y + y * zoom() };
  },
  redraw: drawOverlay,
  repose: markPose,
  status,
  renderBones,
  stopPlayback: () => {
    if (playing) setPlaying(false);
  },
  reloadRig: () => void preserveAndReload("rig-conflict")
});

// ---------------------------------------------------------------------------------------------
// Autosave, History and crash recovery
// ---------------------------------------------------------------------------------------------

/** An autosave version shown read-only in place of the working clip (History panel > Preview). */
let previewState: { clip: string; id: string; backup: ClipData; backupTime: number } | null = null;

const autosaver = createAutosaver(
  {
    snapshot: (reason) => autosaveSnapshot(reason),
    written: () => {
      void history.load();
    },
    failed: (message) => status(`Autosave failed: ${message}`, "bad"),
    busy: (on) => setAutosaving(on)
  },
  AUTOSAVE_INTERVAL_MS
);

/** The working clip plus any unsaved skin and Setup edits, or null when nothing is unsaved (or an old version is being previewed). */
function autosaveSnapshot(reason: string): AutosavePayload | null {
  if (!rig || previewState) return null;
  // A rig with no clip yet (a New rig) is still protected (): its Setup / skin edits and working pose go under a setup session.
  if (!clipName) return setupSessionPayload(reason);
  return clipPayload(clipName, reason, true);
}

/** The unsaved Setup / skin edits of the open rig as an autosave rig part, or undefined when there are none. */
function rigPartNow(): AutosavePayload["rig"] {
  if (!rig) return undefined;
  const skins = rig.skinsDirty ? { skins: rig.doc.skins, setup: { ...rig.setupEdits } } : undefined;
  const edits = setup.unsavedEdits();
  return skins || edits ? { document: rig.outfit.document, ...(skins ? { skins } : {}), ...(edits ? { setup: edits } : {}) } : undefined;
}

/** One clip's autosave (its drafts included; the rig part when asked), or null when nothing of it is unsaved. */
function clipPayload(name: string, reason: string, withRig: boolean): AutosavePayload | null {
  const data = library.get(name);
  if (!rig || !data || !AUTOSAVE_CLIP.test(name)) return null;
  const part = withRig ? rigPartNow() : undefined;
  const ds = draftsOf(name);
  if (!dirty.has(name) && !part && !ds.length) return null;
  return {
    format: AUTOSAVE_FORMAT,
    clip: name,
    outfit: rig.outfit.id,
    reason,
    savedAt: new Date().toISOString(),
    clipData: writeClip(data),
    ...(part ? { rig: part } : {}),
    ...(ds.length ? { drafts: ds } : {})
  };
}

/** The open rig's setup session (Setup / skin edits, the no-clip working pose), or null when nothing is unsaved. */
function setupSessionPayload(reason: string): AutosavePayload | null {
  if (!rig) return null;
  const part = rigPartNow();
  const ds = draftsOf("");
  if (!part && !ds.length) return null;
  return { format: AUTOSAVE_FORMAT, clip: setupSessionId(rig.outfit.id), outfit: rig.outfit.id, reason, savedAt: new Date().toISOString(), clipData: writeClip(emptyClip()), ...(part ? { rig: part } : {}), ...(ds.length ? { drafts: ds } : {}) };
}

/**
 * Writes a recovery autosave of EVERYTHING unsaved in this tab for the open rig (): every dirty clip, every parked or
 * live unkeyed pose, and the Setup / skin edits (as the setup session). Each write is checked; `ok` is false when any did not land, and
 * the caller then keeps the session instead of clearing or reloading it.
 */
async function preserveSession(reason: string): Promise<{ ok: boolean; kept: string[]; error?: string }> {
  if (!rig || previewState) return { ok: true, kept: [] };
  const names = new Set<string>(dirty);
  for (const d of drafts.values()) if (d.outfit === rig.outfit.id && d.clip) names.add(d.clip);
  if (clipName && unkeyedNow().length) names.add(clipName);
  const payloads = [...names].map((n) => clipPayload(n, reason, false)).filter((p): p is AutosavePayload => !!p);
  const session = setupSessionPayload(reason);
  if (session) payloads.push(session);
  const kept: string[] = [];
  for (const p of payloads) {
    try {
      const res = await fetch("/api/autosave", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
      if (!res.ok) return { ok: false, kept, error: `${p.clip}: ${await apiError(res)}` };
      kept.push(isSetupSession(p.clip) ? "Setup / skin edits" : p.clip);
    } catch (error) {
      return { ok: false, kept, error: `${p.clip}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  void history.load();
  return { ok: true, kept };
}

/** Plain words for what preserveSession would keep (the restore / new-rig warnings). */
function unsavedSummary(): string {
  const parts: string[] = [];
  if (dirty.size) parts.push(`${dirty.size} unsaved clip${dirty.size === 1 ? "" : "s"} (${[...dirty].slice(0, 4).join(", ")}${dirty.size > 4 ? ", ..." : ""})`);
  const poses = drafts.size + (unkeyedNow().length ? 1 : 0);
  if (poses) parts.push(`${poses} unkeyed pose${poses === 1 ? "" : "s"}`);
  if (setup.unsavedEdits()) parts.push("unsaved Setup edits");
  if (rig?.skinsDirty) parts.push("unsaved skin edits");
  return parts.join(", ");
}

/** Loads the drafts an autosave carried back into the parked set (the one at the current frame comes back at once). */
function adoptDrafts(clipId: string, list: unknown[] | undefined): number {
  if (!rig || !list?.length) return 0;
  let n = 0;
  for (const raw of list) {
    const d = raw as Partial<PoseDraft>;
    if (typeof d.frame !== "number") continue;
    drafts.set(draftKey(rig.outfit.id, clipId, d.frame), { outfit: rig.outfit.id, clip: clipId, frame: d.frame, rotate: d.rotate ?? {}, move: d.move ?? {}, scale: d.scale ?? {}, shear: d.shear ?? {} });
    n++;
  }
  if (clipId === clipName) unparkDraft();
  return n;
}

async function fetchVersion(clipId: string, id: string): Promise<AutosavePayload> {
  const res = await fetch(`/api/autosave/${encodeURIComponent(clipId)}/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`autosave ${id}: HTTP ${res.status}`);
  return (await res.json()) as AutosavePayload;
}

async function previewVersion(name: string, id: string): Promise<void> {
  try {
    const payload = await fetchVersion(name, id);
    const data = parseClip(payload.clipData);
    if (name !== clipName) switchClip(name);
    if (previewState) exitPreview(false);
    previewState = { clip: name, id, backup: clip, backupTime: time };
    clip = data;
    clearPending();
    keySel = [];
    time = Math.min(time, clip.duration);
    setPlaying(false);
    rebuildState();
    markPose();
    renderAll();
    history.render();
    status(`Previewing the autosave of ${name} from ${whenLabel(Date.parse(payload.savedAt))} (${describeFlags(payload.rig ? "cs" : "c")}); editing is paused`, "ok");
  } catch (error) {
    status(`Preview failed: ${error instanceof Error ? error.message : String(error)}`, "bad");
  }
}

function exitPreview(report = true): void {
  if (!previewState) return;
  clip = previewState.backup;
  time = Math.min(previewState.backupTime, clip.duration);
  previewState = null;
  rebuildState();
  markPose();
  renderAll();
  history.render();
  if (report) status(`Back to the working ${clipName}`);
}

/** Brings the unsaved skin and Setup edits of a version back (the rig must be the one the version was made on). */
async function restoreRigPart(part: NonNullable<AutosavePayload["rig"]>): Promise<string[]> {
  const done: string[] = [];
  if (part.skins) {
    const wanted = part.skins.setup ?? {};
    if (await editSkins(() => part.skins!.skins as Skins, "Skins restored from the autosave")) {
      for (const [slot, placeholder] of Object.entries(wanted)) await setSetup(slot, placeholder);
      done.push("skins");
    }
  }
  if (part.setup) {
    const n = await setup.replayEdits(part.setup.batches as Parameters<typeof setup.replayEdits>[0]);
    done.push(`${n} Setup edit${n === 1 ? "" : "s"}`);
  }
  return done;
}

/** Makes `id` of clip `name` the working clip (one undo step), after autosaving the state it replaces. */
async function restoreVersion(name: string, id: string, withRig: boolean): Promise<boolean> {
  try {
    const payload = await fetchVersion(name, id);
    const data = parseClip(payload.clipData);
    exitPreview(false);
    await autosaver.now("before-restore");
    if (isSetupSession(name)) {
      // A setup session (): the rig's Setup / skin edits and its no-clip working pose, never a clip.
      if (payload.outfit !== rig?.outfit.id) await mountOutfit(payload.outfit);
      const rigDone = payload.rig && payload.rig.document === rig?.outfit.document ? await restoreRigPart(payload.rig) : [];
      const poses = adoptDrafts("", payload.drafts);
      if (poses) rigDone.push(`${poses} unkeyed pose${poses === 1 ? "" : "s"}`);
      autosaver.reset(name);
      markPose();
      renderAll();
      status(`Restored the unsaved work of rig ${payload.outfit} from ${whenLabel(Date.parse(payload.savedAt))}${rigDone.length ? `: ${rigDone.join(", ")}` : ""}`, "ok");
      return true;
    }
    // A clip belongs to the rig it was autosaved on: open that rig first, so its clips never land in another rig's library.
    if (payload.outfit && payload.outfit !== rig?.outfit.id && OUTFITS.some((o) => o.id === payload.outfit)) await mountOutfit(payload.outfit);
    if (!library.has(name)) {
      library.set(name, emptyClip());
      clipOrigin.set(name, "restored from an autosave");
    }
    if (name !== clipName) switchClip(name);
    commit(data, `Restored ${name} from the autosave of ${whenLabel(Date.parse(payload.savedAt))}`);
    const rigDone = withRig && payload.rig && payload.rig.document === rig?.outfit.document ? await restoreRigPart(payload.rig) : [];
    const poses = adoptDrafts(name, payload.drafts);
    if (poses) rigDone.push(`${poses} unkeyed pose${poses === 1 ? "" : "s"}`);
    autosaver.reset(name);
    status(`Restored ${name} from the autosave of ${whenLabel(Date.parse(payload.savedAt))}${rigDone.length ? ` and ${rigDone.join(", ")}` : ""}; Undo steps back`, "ok");
    return true;
  } catch (error) {
    status(`Restore failed: ${error instanceof Error ? error.message : String(error)}`, "bad");
    return false;
  }
}

const history = createHistoryPanel($("historypanel"), {
  clipName: () => clipName,
  previewing: () => (previewState ? { clip: previewState.clip, id: previewState.id } : null),
  autosaveInfo: () => autosaver.info(),
  preview: previewVersion,
  exitPreview: () => exitPreview(),
  restore: async (name, id, withRig) => void (await restoreVersion(name, id, withRig)),
  saveNow: () => autosaver.now("manual")
});

const DISMISS_KEY = "atlasEditor.autosaveDismissed";
function dismissedVersions(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function dismissVersions(ids: string[]): void {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissedVersions(), ...ids].slice(-200)));
  } catch {
    /* private window: the offer simply returns next start */
  }
}

/** The startup check: autosaves newer than the saved files are offered back through the Restore bar. Returns the offers. */
async function offerRestore(): Promise<OfferItem[]> {
  const bar = $("restorebar");
  try {
    const listing = await fetchListing();
    const rigDocument = (outfit: string): string | null => OUTFITS.find((o) => o.id === outfit)?.document ?? null;
    // An autosave of what is already loaded is nothing to restore.
    const items: OfferItem[] = [];
    for (const item of offersFrom(listing, rigDocument, dismissedVersions())) {
      const have = library.get(item.clip);
      const payload = await fetchVersion(item.clip, item.version.id);
      const same = have && JSON.stringify(writeClip(have)) === JSON.stringify(payload.clipData) && !item.rigNewer;
      if (!same) items.push(item);
    }
    showRestoreBar(bar, items, {
      restore: async (list) => {
        for (const item of list) await restoreVersion(item.clip, item.version.id, item.rigNewer);
        dismissVersions(list.map((i) => `${i.clip}/${i.version.id}`));
        bar.hidden = true;
      },
      dismiss: (list) => {
        dismissVersions(list.map((i) => `${i.clip}/${i.version.id}`));
        bar.hidden = true;
        status("Autosave offer dismissed; the versions stay in the History panel");
      },
      history: () => {
        const first = items[0];
        if (first && first.clip !== clipName && library.has(first.clip)) switchClip(first.clip);
        $("historypanel").scrollIntoView({ block: "nearest" });
      }
    });
    return items;
  } catch {
    bar.hidden = true;
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

declare global {
  interface Window {
    /** Debug handle for scripted screenshots and smoke checks. */
    atlasEditor?: Record<string, unknown>;
  }
}

/** The seam the project-UI modules use (host.ts): live reads, the editor's actions, and change events. */
function makeHost(): EditorHost {
  return {
    get rig() {
      return rig;
    },
    get doc() {
      return rig?.doc ?? null;
    },
    get skeleton() {
      return skeleton;
    },
    get clip() {
      return clip;
    },
    get clipName() {
      return clipName;
    },
    get time() {
      return time;
    },
    get playing() {
      return playing;
    },
    get facing() {
      return facingRight ? "right" : "left";
    },
    selectedBones: () => [...multi],
    poseAt: (t) => applyPoseAt(t, false),
    restorePose: () => applyPoseAt(displayTime(), true),
    get autoKey() {
      return autoKey;
    },
    get aids() {
      return aids;
    },
    redraw: () => markPose(),
    poseOffsets: () => currentPoseCopy(),
    capturePose: (name, include, only) => capturePose(name, undefined, {}, include, only),
    previewOffsets: (copy) => {
      for (const [n, o] of Object.entries(copy)) ((pending[n] = o.rotate), (pendingMove[n] = { ...o.translate }), (pendingScale[n] = { ...o.scale }));
      applyPoseAt(displayTime(), true);
      markPose();
    },
    app,
    world,
    get character() {
      return character;
    },
    zoom,
    clips: () => [...library.keys()].map((name) => ({ name, dirty: dirty.has(name), origin: clipOrigin.get(name) ?? "new" })),
    switchClip,
    openSaved, saved: () => savedFiles.map((f) => f.replace(/\.clip\.json$/, "")),
    newClip(name, data) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) return "Clip names use letters, digits, _ . -";
      if (library.has(name)) return `A clip named ${name} exists`;
      library.set(name, data);
      clipOrigin.set(name, "new");
      dirty.add(name);
      switchClip(name);
      return null;
    },
    mountOutfit,
    reloadOutfit: async (id) => {
      rigCache.delete(id);
      await mountOutfit(id);
    },
    setFacing,
    setTime,
    commit,
    setKey,
    xform: {
      read: xformRead,
      set: (ch, x, y, live) => void (selected && applyChannel(selected, ch, x, y, live)),
      finish: (ch) => void (selected && autoKeyChannel(selected, ch)),
      key: (ch) => void (selected && keyChannels(selected, [ch])),
      keyAll: () => void (selected && keyChannels(selected, ["rotate", "translate", "scale", "shear"]))
    },
    view: {
      state: () => ({ x: world.x, y: world.y, zoom: zoom(), w: viewEl.clientWidth, h: viewEl.clientHeight }),
      zoomTo: (z) => zoomAt(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) / (viewGoal?.z ?? zoom()), viewEl.clientWidth / 2, viewEl.clientHeight / 2),
      zoomBy: (f) => zoomAt(f, viewEl.clientWidth / 2, viewEl.clientHeight / 2),
      fit: fitSmooth,
      setLayerVisible,
      layerVisible: (layer) => (layer === "bones" ? showBones : layer === "others" ? showHelpers : (character?.visible ?? layerFlag("images", "visible")))
    },
    compensate: {
      get setupMode() {
        return setup.active();
      },
      get bones() {
        return setup.active() ? setup.api.setupKeep({}).bones : compensate;
      },
      get images() {
        return setup.active() ? setup.api.setupKeep({}).images : false;
      },
      setBones(on) {
        if (setup.active()) setup.api.setupKeep({ bones: on });
        else toggleCompensate(on);
        hostBus.emit("pose");
      },
      setImages(on) {
        if (setup.active()) setup.api.setupKeep({ images: on });
        hostBus.emit("pose");
      }
    },
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    mirrorSelection: () => void mirrorSelection(),
    flipPose: () => void flipPose(),
    get unkeyed() {
      return unkeyedNow();
    },
    keyUnkeyed: keyAllUnkeyed,
    discardUnkeyed,
    keyPose() {
      // The whole standard pose (not the IK targets), whatever is selected; the selection comes back afterwards.
      if (!skeleton || !rig || setup.active()) return 0;
      const names = keyPoseBones(rig.doc.bones.map((b) => b.name)).filter((n) => skeleton!.findBone(n));
      if (!names.length) return 0;
      const prev = { active: selected, names: selectedBones() };
      setSelection({ active: names[0]!, names });
      setKey();
      setSelection(prev);
      return names.length;
    },
    undo,
    redo,
    get canUndo() {
      return undoStack.length > 0;
    },
    breakdown: () => void breakdown(),
    jumpToKey,
    refreshBones: renderBones,
    wornSkins: () => {
      if (!rig) return [];
      const base = baseSkin(rig.doc.skins);
      return activeSkinNames().filter((n) => n !== base);
    },
    pushHistory(label, undoFn, redoFn) {
      undoStack.push({ name: clipName, clip, label, swap: { undo: undoFn, redo: redoFn } });
      if (undoStack.length > 200) undoStack.shift();
      redoStack.length = 0;
      renderClipControls();
    },
    setActiveSkins(list) {
      if (!rig) return;
      const base = baseSkin(rig.doc.skins);
      const names = list.filter((n) => n !== base && n in rig!.doc.skins);
      rig.skinChoice = names.length ? names[names.length - 1]! : null;
      rig.skinMix = names.slice(0, -1);
      applyActiveSkins();
    },
    status,
    checkWholeClip,
    selectBone: (name) => select(name),
    inspectorNode: () => setup.api.setupNode(),
    selectNode: (node) => setup.api.setupSelectNode(node),
    boneSelection: () => ({ active: selected, names: [...multi] }),
    selectBones: (names, mode, active) => setSelection(selectBones(currentSelection(), names, mode, active)),
    selectAllBones,
    selectBranch,
    frameSelection,
    selectSlot,
    swapAttachment: (slot, name) => {
      if (setup.active()) {
        void setup.api.setupDefaultImage(slot, name);
        return "setup";
      }
      if (autoKey) {
        setSlotAttachment(slot, name);
        return "keyed";
      }
      selectSlot(slot);
      return "blocked";
    },
    get canvasTool() {
      return canvasToolId;
    },
    setCanvasTool,
    setSlotHidden,
    meshes: listMeshes,
    patchMeshGeometry: () => false,
    get setupActive() {
      return setup.active();
    },
    setupRun: (label, make) => setup.api.setupRun(label, make as never),
    setupRaw: () => setup.api.setupRaw() as never,
    repose: markPose,
    redrawTimeline: drawTimeline,
    renderSheets,
    shipState: () => ({
      rig: rig?.outfit.id ?? null,
      rigUnsaved: !!setup.unsavedEdits() || !!rig?.skinsDirty,
      clip: clipName,
      clipDirty: !!clipName && dirty.has(clipName),
      clipApplied: !!clipName && appliedRev.get(clipName) === library.get(clipName),
      clipJson: clipName && library.get(clipName) ? JSON.stringify(library.get(clipName)) : ""
    }),
    applyToRig: (allViews) => applyToRig(allViews),
    saveClip: async () => (await save()).ok,
    on: hostBus.on
  };
}

/** Anything that would be lost by closing the tab: unsaved clips, skins or Setup edits. */
function hasUnsavedWork(): boolean {
  // Unkeyed poses (live or parked) count too (): closing the tab would lose them.
  return dirty.size > 0 || !!rig?.skinsDirty || !!setup.unsavedEdits() || drafts.size > 0 || unkeyedNow().length > 0;
}

/** Autosaves everything unsaved (preserveSession), then reloads the page; stays (and says why) when the autosave fails. */
async function preserveAndReload(reason: string): Promise<boolean> {
  const kept = await preserveSession(reason);
  if (!kept.ok) {
    status(`Not reloaded: this tab's unsaved work could not be autosaved (${kept.error}). Save it first, then reload.`, "bad");
    return false;
  }
  skipUnloadGuard = true;
  location.reload();
  return true;
}

/** Rig "Versions…": the snapshots of the open rig document; a restore reloads the page (the rig is re-read from disk). */
async function openRigVersions(): Promise<void> {
  if (!rig) return status("No rig open", "bad");
  await versionsDialog({
    kind: "rig",
    file: rig.outfit.document,
    // : the warning names every unsaved context the reload affects, and all of it is autosaved to History BEFORE the restore;
    // when that autosave fails nothing is restored or reloaded.
    restoreNote: () => {
      const what = unsavedSummary();
      return what ? `This tab has ${what}: they are autosaved to History first (restore them from there), then the page reloads to read the restored rig.` : "The page reloads to read the restored rig.";
    },
    beforeRestore: async () => {
      const kept = await preserveSession("before-rig-restore");
      if (!kept.ok) status(`Not restored: this tab's unsaved work could not be autosaved first (${kept.error})`, "bad");
      return kept.ok;
    },
    onRestored: () => {
      skipUnloadGuard = true;
      location.reload();
    }
  });
}

/** Clip "Versions…" (Clip board menu): the snapshots of a saved clip file; a restore reloads that clip if it is in the session. */
async function openClipVersions(name: string): Promise<void> {
  await versionsDialog({
    kind: "clip",
    file: `${name}.clip.json`,
    restoreNote: () => (dirty.has(name) ? `Your unsaved edits to ${name} in this tab are replaced.` : ""),
    onRestored: async () => {
      await refreshSaved();
      if (library.has(name)) await reloadFromDisk(name);
      status(`Restored an earlier version of ${name}`, "ok");
    }
  });
}

let skipUnloadGuard = false;

async function boot(): Promise<void> {
  installErrorToasts();
  installUnloadGuard(() => !skipUnloadGuard && hasUnsavedWork());
  chrome = createChrome(statusInfo);
  setHost(makeHost());
  // Home opens first; a script can start in a workspace with ?ws=pro or window.__atlasWorkspace.
  const startWs = parseWorkspace(new URLSearchParams(location.search).get("ws") ?? (window as { __atlasWorkspace?: string }).__atlasWorkspace) ?? "home";
  const workspaces = createWorkspaces(chrome, startWs);
  workspaceNow = () => workspaces.current();
  goWorkspace = (id) => workspaces.go(id);
  workspaceGo = (id) => workspaces.go(id);
  registerPaletteActions();
  workspaces.onChange(() => offerFirstClip());
  workspaces.onChange((ws) => setBoneView(boneViewFor(ws), false));
  setBoneView(boneViewFor(workspaces.current()), false);
  workspaces.onChange(() => renderBones());
  installLayout(workspaces);
  // The strip shows the transform rows in Animate and Pro, so the Pose panel drops its copy there; the layout also changes: frame the character again.
  workspaces.onChange(() => {
    renderDetailNow();
    requestAnimationFrame(() => requestAnimationFrame(fit));
  });
  installViewHud();
  installTransport(workspaces);
  whenHost((h) => {
    installTransformStrip(h);
    installCanvasEdge(h);
    installToolPalette(h);
  });
  createHome(workspaces).render();
  void import("./clipBoard.js").then((m) => m.createClipBoard(workspaces));
  createPhoneDock(workspaces);
  createSwagWorkshop(workspaces);
  whenHost(installPhoneSize);
  installTooltips();
  wireControls();
  guide = installWorkspaceGuide(workspaces, () => toggleHelp(true));
  await initPixi();
  whenHost(installRuleOverlay);
  whenHost(installShapeKeysApi);
  whenHost(installGateOverlay);
  whenHost(installLiveGateHud);
  whenHost(installRefUnderlay);
  whenHost(installHitLock);
  whenHost(installPoseLibrary);
  whenHost(installOutliner);
  whenHost((h) => {
    installMotionPaths(h);
    installPins(h);
  });
  wireViewport();
  wireTimeline();
  wireTimelineSplit();
  tracksPreview = createTracksPreview({
    panel: $("trackpanel"),
    doc: () => rig?.doc ?? null,
    clips: () => Object.fromEntries(library),
    editedClip: () => clipName,
    changed: markPose,
    fps: () => clipFps(clip),
    beforeActivate: () => transitionsPreview?.setActive(false),
    adoptClip: (name, baked) => {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}$/.test(name)) return "Clip names use letters, digits, _, - and . (up to 96 characters)";
      if (library.has(name) || savedFiles.includes(`${name}.clip.json`)) return `A clip called ${name} already exists: pick another name`;
      exitMixPreview("Baked the mix");
      library.set(name, baked);
      clipOrigin.set(name, "new");
      dirty.add(name);
      switchClip(name);
      status(`Baked the mix preview into the new clip ${name} (${frameCount(baked)} frames, unsaved: Save keeps it)`, "ok");
      return null;
    }
  });
  transitionsPreview = createTransitionsPreview({
    panel: $("transpanel"),
    doc: () => rig?.doc ?? null,
    clips: () => Object.fromEntries(library),
    rigId: () => rig?.outfit.id ?? "",
    editedClip: () => clipName,
    changed: markPose,
    beforeActivate: () => tracksPreview?.setActive(false),
    status: (text, kind) => status(text, kind)
  });
  $("transitionsbtn").addEventListener("click", () => {
    // Transitions live in Pro's tab bar: Animate's button goes there and turns the graph on.
    if (workspaces.current() !== "pro") workspaces.go("pro");
    document.getElementById("app")?.classList.remove("rcol");
    chrome?.showTab("transitions");
    transitionsPreview?.setActive(true);
  });
  for (const o of await discoverRigs()) outfitAdder?.(o);
  stepsCard = mountStepsCard(viewEl, { facts: rigFacts, run: runStep });
  setNewRigOpener(openNewRig);
  workspaces.onChange(() => renderStepsCard());
  // : the Tracks panel lives in Pro; any workspace switch suspends a mix preview so a hidden panel cannot keep driving the stage.
  workspaces.onChange((ws, from) => {
    if (from !== null && ws !== from && mixPreview()) exitMixPreview(`Switched to ${ws}`);
  });
  viewEl.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  viewEl.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    void addPartsHere(files);
  });
  registerActions("newrig", () => [
    { id: "rig:new", label: "New rig...", group: "Rig", keywords: "create rig blank player skeleton import png psd parts", run: openNewRig },
    ...(rig && DISCOVERED_IDS.has(rig.outfit.id) ? [{ id: "rig:add-parts", label: "Add parts to this rig...", group: "Rig", keywords: "import png psd drop", run: () => void pickPartFiles().then((f) => (f.length ? addPartsHere(f) : undefined)) }] : [])
  ]);
  // Opens on Player v2; a script can start on another rig with ?rig=<id> or window.__atlasOutfit (an unknown id falls back to the default).
  await mountOutfit(new URLSearchParams(location.search).get("rig") ?? (window as { __atlasOutfit?: string }).__atlasOutfit ?? defaultOutfitId());
  fit();
  await refreshSaved();
  await refreshPoses();
  autosaver.start();
  await history.load();
  window.atlasEditor = {
    dropClip,
    /** Clip board: re-reads the saved clip list after it deleted or renamed a file. */
    refreshSaved,
    /** Clip board menu "Versions…": the saved versions of a clip file. */
    clipVersions: (name: string) => openClipVersions(name),
    /** True while the tab holds unsaved clips, skins or Setup edits (the leave-page guard). */
    hasUnsavedWork,
    /** Batch 0 data-safety probes (qa-persistence / qa-undo): parked unkeyed poses, save outcomes, session preservation, skin undo. */
    drafts: () => [...drafts.values()].map((d) => ({ clip: d.clip, frame: d.frame, bones: draftBones(d) })),
    setAutoKey: (on: boolean) => {
      if (autoKey !== on) toggleAutoKey();
    },
    saveOutcome: async () => {
      const o = await save();
      return o.ok ? { ok: true, name: o.name } : o;
    },
    preserveSession: (reason = "qa") => preserveSession(reason),
    /** The open rig's clip library: names, unsaved flag and the bones each clip animates (rig-switch probes). */
    clipSession: () => [...library].map(([name, c]) => ({ name, dirty: dirty.has(name), bones: Object.keys(c.bones) })),
    discardUnkeyed,
    undoStep: () => undo(),
    redoStep: () => redo(),
    mixActive: () => !!mixPreview(),
    rigDocument: () => rig?.outfit.document ?? null,
    /** Batch 9 probes (qa-pipeline): the mounted rig's atlas manifest path and a copy of its document as the editor holds it. */
    rigAtlas: () => rig?.outfit.atlas ?? null,
    setupRaw: () => (rig ? (JSON.parse(JSON.stringify(rig.raw)) as unknown) : null),
    setupBase: () => setup.baseHash(),
    skinsDirty: () => !!rig?.skinsDirty,
    /** The first-run key card for a workspace (it shows by itself once per workspace, never under automation). */
    showGuide: (id?: string) => guide?.show(parseWorkspace(id) ?? undefined),
    hideGuide: () => guide?.hide(),
    /** Right-panel tabs: opens one, or the tab that holds a selector (scripted demos use this before clicking a control). */
    showTab: (id: TabId) => {
      document.getElementById("app")?.classList.remove("rcol");
      chrome?.showTab(id);
    },
    /** Workspaces (Home, Animate, Swag, Rig, Ship, Pro): switch or read the current one. */
    workspace: (id?: string) => {
      const w = parseWorkspace(id);
      if (w) workspaces.go(w);
      return workspaces.current();
    },
    currentTab: () => chrome?.currentTab(),
    reveal: (target: string) => chrome?.reveal(target) ?? false,
    /** The autosave feature reports an autosave in flight here (the status bar shows "Autosaving"). */
    setAutosaving,
    saveState,
    select,
    selectBones: (names: string[], mode: SelectMode = "replace", active?: string) => setSelection(selectBones(currentSelection(), names, mode, active)),
    boneSelection: () => ({ active: selected, names: [...multi] }),
    pickAt: (x: number, y: number) => pickBone(x, y),
    boxSelect: (x0: number, y0: number, x1: number, y1: number, mode: SelectMode = "replace") => {
      setSelection(selectBones(currentSelection(), bonesInBox(pickCandidates(), { x0, y0, x1, y1 }), mode));
      return [...multi];
    },
    hiddenHelpers: () => [...hiddenNow()],
    /** Handles on the canvas: helper toggle, hovered bone, live IK squares and key dots, for scripted checks. */
    setShowHelpers: (on: boolean) => {
      showHelpers = on;
      $("helpersvis").classList.toggle("on", on);
      drawOverlay();
    },
    setShowBones: (on: boolean) => setBoneView(on ? lastBoneView : "off", false),
    setBoneView: (v: BoneView) => setBoneView(v, false),
    boneView: () => boneView,
    overlayState: () => ({ wedges: lastWedges, showBones, boneView, showHelpers, hover: hoverBone, hidden: [...overlayHiddenNow()], ikHandles: liveIkTargets().map((t) => { const r = app.canvas.getBoundingClientRect(); return { name: t.data.name, x: r.left + t.world.x * zoom() + world.x, y: r.top + t.world.y * zoom() + world.y }; }), keyDots: skeleton ? skeleton.bones.map((b) => ({ bone: b.data.name, types: boneKeyTypesAt(clip, b.data.name, frameTime(clip, timeToFrame(clip, time))) })).filter((k) => k.types.length) : [] }),
    hoverAt: (sx: number, sy: number) => {
      const x = (sx - world.x) / zoom();
      const y = (sy - world.y) / zoom();
      setHover(showBones ? grabTargetAt(x, y) : null, sx, sy);
      return hoverBone;
    },
    ikHandleFor,
    setCompensate: (on?: boolean) => {
      toggleCompensate(on);
      return compensate;
    },
    setTime,
    /** Batch 6 probes: the open clip, the key selection, the preview speed and the key inspector. */
    getClip: () => clip,
    keySelection: () => keySel,
    setKeySelection,
    playSpeed: () => playSpeed,
    audioTrack: () => audioTrack?.state() ?? null,
    keyInspector: () => keyInspector,
    switchClip,
    mountOutfit,
    rotate: (bone: string, value: number) => applyRotate(value, bone),
    key: setKey,
    state: () => ({ clipName, time, selected, selection: [...multi], compensate, pending: { ...pending }, pendingMove: { ...pendingMove }, pendingScale: { ...pendingScale }, pendingShear: { ...pendingShear }, gizmoMode, clip: writeClip(clip), outfit: rig?.outfit.id }),
    fit,
    artBox,
    fitSmooth,
    frameSelection,
    zoomAt,
    /** The view now and where it is heading (null when at rest). */
    view: () => ({ zoom: zoom(), x: world.x, y: world.y, goal: viewGoal ? { ...viewGoal } : null }),
    checkWholeClip,
    /** Clean up keys: the options are { tolerances?, bones? } of keyReduce.ts (bones omitted = the whole clip). */
    reduceKeys: (options?: { tolerances?: Partial<Record<"rotate" | "translate" | "scale" | "shear" | "ik", number>>; bones?: string[] }) => {
      const r = reduceKeysPure(clip, options ?? {});
      return { removed: r.removed, keysBefore: r.keysBefore, keysAfter: r.keysAfter, perChannel: r.perChannel, keys: r.keys };
    },
    applyReduceKeys: (options?: { tolerances?: Partial<Record<"rotate" | "translate" | "scale" | "shear" | "ik", number>>; bones?: string[] }) => {
      const r = reduceKeysPure(clip, options ?? {});
      if (r.removed) commit(r.clip, `Cleaned up keys: removed ${r.removed} of ${r.keysBefore}`);
      return { removed: r.removed, keysBefore: r.keysBefore, keysAfter: r.keysAfter, perChannel: r.perChannel };
    },
    reducePanel,
    tweenPanel,
    undo,
    /** Preview facing right: "left" | "right" (the root flip). Returns the facing now shown. */
    setFacing,
    facing: () => ({ facing: (facingRight ? "right" : "left") as Facing, scaleX: character?.scale.x ?? null }),
    mirrorCheck: () => {
      computeMirrorReport();
      return mirrorReport?.issues ?? [];
    },
    debug: () => ({ app, skeleton, character, world }),
    selectSlot,
    applyToRig,
    renderSheets,
    addEvent: (name: EventName, frame?: number) => {
      if (frame !== undefined) setTime(frameTime(clip, frame));
      addEventMarker(name);
    },
    deleteEvents: (frame: number, name?: EventName) => {
      setTime(frameTime(clip, frame));
      removeEventMarkers(name);
    },
    lockHit: (style: string, step: number) => {
      eventLink = { ...eventLink, style, step };
      lockHitMarker();
    },
    setEventLink: (style: string, step: number, link = true) => {
      eventLink = { style, step, link };
      renderEventPanel();
    },
    events: () => clip.events.map((e) => ({ name: e.name, frame: timeToFrame(clip, e.time), string: e.string ?? null })),
    contactFrame,
    togglePreview,
    setGizmo: setGizmoMode,
    ikTo: (side: Side, x: number, y: number) => ikTo(side, x, y),
    keyIk,
    snapGrip: (side?: Side) => snapGrip(side),
    setGrip: (g: { on?: boolean; along?: number; across?: number }) => {
      grip = { ...grip, ...g };
      renderIkPanel();
      drawOverlay();
    },
    gripInfo: () => {
      const p = skeleton ? gripPoint(skeleton, lastIkSide, grip.along, grip.across) : null;
      return { ...grip, lead: lastIkSide, point: p };
    },
    handPos: (side: Side) => {
      const h = skeleton?.findBone(sn("hand", side));
      if (!h) return null;
      const rect = app.canvas.getBoundingClientRect();
      return { x: h.world.x, y: h.world.y, screen: { x: rect.left + world.x + h.world.x * zoom(), y: rect.top + world.y + h.world.y * zoom() } };
    },
    otherSide,
    setOnion,
    onionInfo: () => aids?.info().onion ?? null,
    abInfo: () => ({ pinned: pin ? { clipName: pin.clipName, frame: pin.frame, outfit: pin.outfit } : null, ghost: pinGhost, view: abView, layer: aids?.info().pin ?? null }),
    assistInfo: () => ({ snap: assistState?.snap ?? null, guides: assistState?.guides.length ?? 0, typed: typedBuf, moveTyped, dragging: drag?.kind ?? null }),
    paletteOpen,
    boneLimits: () => (skeleton?.bones ?? []).flatMap((b) => (b.data.limits ? [{ name: b.data.name, ...b.data.limits }] : [])),
    boneRot: (name: string) => { const b = skeleton?.findBone(name); return b ? currentOffset(b) : null; },
    loadUnderlay,
    setUnderlay,
    underlayInfo: () => aids?.info().underlay ?? null,
    clearUnderlay: () => aids?.clearUnderlay(),
    move: (bone: string, x: number, y: number) => applyMove(bone, x, y),
    scale: (bone: string, x: number, y: number = x) => applyScale(bone, x, y),
    keyScale,
    /** Screen positions of the selected-bone scale / shear handles (x along the bone, y across it). */
    handlePos: (bone: string) => {
      const b = skeleton?.findBone(bone);
      if (!b) return null;
      const f = handleFrame(b);
      const rect = app.canvas.getBoundingClientRect();
      const toScreen = (p: [number, number]) => ({ x: rect.left + world.x + p[0] * zoom(), y: rect.top + world.y + p[1] * zoom() });
      return { origin: toScreen([f.ox, f.oy]), x: toScreen(f.hx), y: toScreen(f.hy) };
    },
    scaleOf: (bone: string) => {
      const b = skeleton?.findBone(bone);
      return b ? currentScale(b) : null;
    },
    shear: (bone: string, x: number, y: number = 0) => applyShear(bone, x, y),
    keyShear,
    shearOf: (bone: string) => {
      const b = skeleton?.findBone(bone);
      return b ? currentShear(b) : null;
    },
    keyMove,
    moveOf: (bone: string) => {
      const b = skeleton?.findBone(bone);
      return b ? currentMove(b) : null;
    },
    /** A point in a bone's local space (x, y) in page pixels (for real mouse input and pixel checks). */
    localToScreen: (name: string, x: number, y: number) => {
      const b = skeleton?.findBone(name);
      if (!b) return null;
      const w = b.localToWorld(x, y, { x: 0, y: 0 });
      const rect = app.canvas.getBoundingClientRect();
      return { x: rect.left + world.x + w.x * zoom(), y: rect.top + world.y + w.y * zoom() };
    },
    boneScreenPos: (name: string) => {
      const b = skeleton?.findBone(name);
      if (!b) return null;
      const rect = app.canvas.getBoundingClientRect();
      return { x: rect.left + world.x + b.world.x * zoom(), y: rect.top + world.y + b.world.y * zoom() };
    },
    /** The bone's origin, tip and midpoint in page pixels (for real mouse input). */
    boneScreenEnds: (name: string) => {
      const b = skeleton?.findBone(name);
      if (!b) return null;
      const rect = app.canvas.getBoundingClientRect();
      const { ox, oy, tx, ty } = boneEnds(b);
      const at = (x: number, y: number) => ({ x: rect.left + world.x + x * zoom(), y: rect.top + world.y + y * zoom() });
      return { origin: at(ox, oy), tip: at(tx, ty), mid: at((ox + tx) / 2, (oy + ty) / 2) };
    },
    previewInfo: () => preview?.info() ?? null,
    /** Game view (gameView.ts): the clip as the project shows it. Open it, set options, seek the project clock, read what it drew. */
    gameView: (open?: boolean) => {
      toggleGameView(open);
      return gameView?.info() ?? null;
    },
    gameViewOptions: (patch: Record<string, unknown> = {}) => gameView?.setOptions(patch) ?? null,
    gameViewPlay: (on?: boolean) => gameView?.play(on) ?? false,
    gameViewReplay: () => gameView?.replay(),
    gameViewSeek: (seconds: number) => {
      gameView?.seek(seconds);
      return gameView?.info() ?? null;
    },
    gameViewInfo: () => gameView?.info() ?? null,
    loadReference: async (file: File) => {
      await preview?.loadReference(file);
      markPose();
    },
    clearReference: () => preview?.clearReference(),
    selectKeys: (items: { row: RowId; frame: number }[], mode: "replace" | "add" | "toggle" = "replace") =>
      setKeySelection(selectKeys(keySel, items.map((i) => ({ row: i.row, time: frameTime(clip, i.frame) })), mode)),
    selectAllKeys,
    mirrorSelection: (options?: { limb?: boolean; from?: BodySide }) => mirrorSelection(options),
    mirrorLimb: (limb: Limb, from: BodySide) => mirrorLimb(limb, from),
    flipPose,
    mirrorPartners: () => Object.fromEntries(mirrorRig()?.partner ?? []),
    breakdown: (percent?: number) => breakdown(percent),
    copyPose: (onlySelected = false) => copyPose(onlySelected),
    pastePose: pasteClipboard,
    selectBox: (fromFrame: number, toFrame: number, rows?: RowId[]) =>
      setKeySelection(keysInRange(clip, frameTime(clip, Math.min(fromFrame, toFrame)), frameTime(clip, Math.max(fromFrame, toFrame)), rows)),
    clearSelection: () => setKeySelection([]),
    selection: () => keySel.map((k) => ({ row: k.row, frame: timeToFrame(clip, k.time) })),
    moveSelected: moveSelectedKeys,
    scaleSelected: (factor: number, pivotFrame?: number) => scaleSelectedKeys(factor, pivotFrame),
    copyKeys: copySelectedKeys,
    pasteKeys: (frame?: number) => pasteKeyBoard(frame),
    deleteSelected: deleteKey,
    setPlayRange: (a: number | null, b?: number) => setPlayRange(a, b),
    playRange: () => (playRange ? { ...playRange } : null),
    keyScreenPos: (row: RowId | "all", frame: number) => {
      const rect = tl.getBoundingClientRect();
      const idx = tlRows.findIndex((r) => (row === "all" ? r.kind === "all" : rowIdOf(r) === row));
      if (idx < 0) return null;
      return { x: rect.left + frameX(frame, rect.width), y: rect.top + rowTop(idx) + ROW_H / 2, rowIndex: idx };
    },
    /** Timeline view: visible frame window, zoom / pan / fit, and which bone rows are opened into channel rows. */
    timelineView: () => ({ ...tlView, fit: tlAutoFit, frames: frameCount(clip) }),
    setTimelineView: (start: number, span: number) => {
      setTlView({ start, span });
      return { ...tlView };
    },
    zoomTimeline: (factor: number, aroundFrame?: number) => {
      setTlView(zoomView(tlView, factor, aroundFrame ?? timeToFrame(clip, time), frameCount(clip)));
      return { ...tlView };
    },
    panTimeline: (frames: number) => {
      setTlView(panView(tlView, frames, frameCount(clip)));
      return { ...tlView };
    },
    fitTimeline: () => {
      setTlView(tlView, true);
      return { ...tlView };
    },
    expandBone: (name: string, open = true) => {
      if (open) tlExpanded.add(name);
      else tlExpanded.delete(name);
      drawTimeline();
    },
    expandAllBones: (open = true) => {
      tlExpanded.clear();
      if (open) for (const b of Object.keys(clip.bones)) tlExpanded.add(b);
      drawTimeline();
    },
    /** Playback check: `frameTimes(true)` starts recording the main-thread ms of each editor frame, `frameTimes(false)` stops and returns them. */
    frameTimes: (on: boolean) => {
      if (on) {
        frameTimes = [];
        return null;
      }
      const got = frameTimes;
      frameTimes = null;
      return got;
    },
    /** Dopesheet curve segments: the selected ones, the picker, and where a segment sits on screen (middle of its top row). */
    segInfo: () => ({ selected: liveSegments(), picker: segPicker.isOpen(), hover: tlHoverSeg }),
    curveSegScreenPos: (bone: string, channel: GraphChannelId, frame: number) => {
      const rect = tl.getBoundingClientRect();
      const idx = tlRows.findIndex((r) => r.kind === "curve" && r.name === bone && r.ch === channel && r.part === 0);
      const seg = segmentsOf(clip, bone, channel).find((q) => timeToFrame(clip, q.a.time) === frame);
      if (idx < 0 || !seg) return null;
      const fps = clipFps(clip);
      const mid = frameX((seg.a.time + seg.b.time) * 0.5 * fps, rect.width);
      return { x: rect.left + mid, y: rect.top + rowTop(idx) + ROW_H - 2 };
    },
    timelineRows: () => tlRows.map((r, i) => ({ kind: r.kind, name: r.name, type: r.type ?? null, y: rowTop(i) })),
    rulerScreenPos: (frame: number) => {
      const rect = tl.getBoundingClientRect();
      return { x: rect.left + frameX(frame, rect.width), y: rect.top + RULER_H / 2 };
    },
    setCurve: (spec: CurveSpec | CurveKind, bone?: string, frame?: number) => {
      const resolved = typeof spec === "string" && spec in CURVE_PRESETS ? CURVE_PRESETS[spec as Exclude<CurveKind, "bezier">] : (spec as CurveSpec);
      const name = bone ?? selected;
      if (!name) return;
      applyCurve(resolved, [{ kind: "bone", name, time: frame === undefined ? keyTime() : frameTime(clip, frame) }]);
    },
    curveOf: (bone: string, frame: number) => keyCurveAt(clip, { kind: "bone", name: bone, time: frameTime(clip, frame) }) ?? null,
    setAttachment: (slot: string, name: string | null) => setSlotAttachment(slot, name),
    removeAttachment: (slot: string) => removeSlotAttachment(slot),
    setDrawPreset,
    drawPresets: () => DRAW_PRESETS.map((p) => ({ label: p.label, ...resolveDrawPreset(rig?.doc.slots.map((s) => s.name) ?? [], p.id) })),
    drawOrderState: (frameNo?: number) => drawOrderState(rig?.doc.slots.map((s) => s.name) ?? [], drawOrderAt(clip, frameNo === undefined ? keyTime() : frameTime(clip, frameNo))),
    slotOrder: () => skeleton?.drawOrder.map((s) => s.data.name) ?? [],
    setDrawOrder: (slot: string, offset: number) => moveSlotOrder(slot, offset),
    removeDrawOrder: removeDrawOrderKey,
    makeSmear,
    deleteSmear: (name: string) => deleteSmear(name, false),
    smearInfo: () => (lastSmear ? { ...lastSmear.meta, hullPx: lastSmear.hullPx, inkPx: lastSmear.inkPx } : null),
    lockFoot: lockFootRange,
    unlockFoot: unlockFootRange,
    lockRoot: lockRootRange,
    footAt,
    footDrift,
    footLocks: () => (["l", "r"] as const).flatMap((side) => {
      const l = footIk(side);
      return l ? footLockRanges(clip, l.ik).map((q) => ({ side, ...q })) : [];
    }),
    setSilhouette,
    silhouetteReport,
    autosaveNow: (reason = "manual") => autosaver.now(reason),
    autosaveInfo: () => autosaver.info(),
    setAutosaveInterval: (ms: number) => autosaver.setInterval(ms),
    autosaveVersions: async (name?: string) => (await fetchListing()).clips[name ?? clipName] ?? [],
    historyRefresh: () => history.load(),
    previewVersion,
    exitPreview: () => exitPreview(),
    previewing: () => (previewState ? { clip: previewState.clip, id: previewState.id } : null),
    restoreVersion,
    offerRestore,
    savePose,
    capturePose,
    applyPose: applyLibraryPose,
    deletePose: (name: string) => deletePose(name, false),
    poses: () => poseLib.map((p) => ({ name: p.pose.name, builtin: !!p.pose.builtin, rig: p.pose.rig ?? null, note: p.pose.note ?? null, summary: poseSummary(p.pose), bones: Object.keys(p.pose.bones).length, attachments: p.pose.attachments, drawOrder: p.pose.drawOrder })),
    refreshPoses,
    poseThumb: captureThumb,
    setArc,
    arcInfo,
    applyEasing: (id: EasingId, targets?: { bone: string; frame: number }[]) =>
      applyEasingPreset(id, targets?.map((t) => ({ kind: "bone" as const, name: t.bone, time: frameTime(clip, t.frame) }))),
    tracksOpen: (on = true) => tracksPreview?.setActive(on),
    tracksBake: (name: string, options?: { step?: number; slots?: boolean }) => tracksPreview?.bake(name, options),
    tracksInfo: () => tracksPreview?.info() ?? null,
    trackSet: (index: number, patch: Record<string, unknown>) => tracksPreview?.setTrack(index, patch),
    trackAdd: (config?: Record<string, unknown>) => tracksPreview?.addTrack(config),
    trackRemove: (index: number) => tracksPreview?.removeTrack(index),
    tracksPlay: (on: boolean) => tracksPreview?.play(on),
    tracksSeek: (seconds: number) => tracksPreview?.seek(seconds),
    tracksReset: () => tracksPreview?.reset(),
    /** Batch 12c: the clip transition graph (Transitions tab). */
    transInfo: () => transitionsPreview?.info() ?? null,
    transOpen: (on = true) => transitionsPreview?.setActive(on),
    transFire: (to: string) => (transitionsPreview ? transitionsPreview.fire(to) : "no panel"),
    transStart: (clip?: string) => transitionsPreview?.start(clip),
    transPlay: (on: boolean) => transitionsPreview?.play(on),
    transCycle: (on: boolean) => transitionsPreview?.setCycle(on),
    transAddNode: (clip: string) => transitionsPreview?.addNode(clip),
    transRemoveNode: (clip: string) => transitionsPreview?.removeNode(clip),
    transAddEdge: (from: string, to: string, blend: number, condition = "") => (transitionsPreview ? transitionsPreview.addEdge(from, to, blend, condition) : "no panel"),
    transRemoveEdge: (id: string) => transitionsPreview?.removeEdge(id),
    transPrefill: () => transitionsPreview?.prefill(),
    transSetPath: (path: string[]) => transitionsPreview?.setPath(path),
    transSave: () => transitionsPreview?.save() ?? Promise.resolve(false),
    graphOpen: (on?: boolean) => {
      setGraphOpen(on);
      return !!graph?.open;
    },
    graphChannels: (ids?: GraphChannelId[]) => {
      if (ids) graph?.setChannels(ids);
      return graph?.channels() ?? [];
    },
    graphFrameAll: () => {
      graph?.frameAll();
      return graph?.view() ?? null;
    },
    graphFrameKeys: () => {
      graph?.frameSelected();
      return graph?.view() ?? null;
    },
    graphZoom: (factor: number, axis?: "t" | "v" | "both") => {
      graph?.zoom(factor, axis);
      return graph?.view() ?? null;
    },
    graphView: () => graph?.view() ?? null,
    graphState: () => ({
      open: !!graph?.open,
      channels: graph?.channels() ?? [],
      view: graph?.view() ?? null,
      bones: graphBones(),
      focus: graph?.focus() ?? null,
      curves: (graph?.curves() ?? []).map((c) => ({ bone: c.bone, channel: c.channel, keys: c.keys.map((k) => ({ frame: timeToFrame(clip, k.time), value: k.value, curve: k.curve })) }))
    }),
    graphPoint: (bone: string, channel: GraphChannelId, frame: number, what?: "key" | "h1" | "h2") => graph?.pointOf(bone, channel, frame, what) ?? null,
    graphSetValue: (bone: string, channel: GraphChannelId, frame: number, value: number) => {
      graph?.setFocus(bone, channel, frameTime(clip, frame));
      return graph?.setFocusValue(value) ?? false;
    },
    graphSelect: (keys: { bone: string; frame: number }[]) => setKeySelection(keys.map((k) => ({ row: `bone:${k.bone}` as const, time: frameTime(clip, k.frame) }))),
    graphInterp: (kind: "linear" | "stepped" | "bezier") => graph?.setInterp(kind) ?? 0,
    skins: () => skinState(),
    createSkin: (name: string) => editSkins((s) => createSkin(s, name), `Skin ${name} created`),
    renameSkin: (name: string, to: string) => renameSkin(name, to),
    duplicateSkin: (name: string, copyName?: string) => editSkins((s) => duplicateSkin(s, name, copyName ?? uniqueSkinName(s, `${name}-copy`)), `Skin ${name} duplicated`),
    deleteSkin: (name: string) => editSkins((s) => deleteSkin(s, name), `Skin ${name} deleted`),
    setActiveSkin,
    mixSkin,
    addSkinAttachment,
    removeSkinAttachment: (skin: string, slot: string, placeholder: string) => editSkins((s) => removeSkinAttachment(s, skin, slot, placeholder), `${skin}: removed ${slot}/${placeholder}`),
    setSkinHide: (skin: string, slot: string, hidden: boolean) => editSkins((s) => setSkinHide(s, skin, slot, hidden), `${skin}: ${slot} ${hidden ? "hidden" : "shown"}`),
    setSetupPlaceholder: (slot: string, placeholder: string | null) => setSetup(slot, placeholder),
    skinPlaceholders: (slot: string) => [...slotPlaceholderSkins(rig?.doc.skins ?? {}, slot)].map(([placeholder, from]) => ({ placeholder, skins: from })),
    exportSkins: () => (rig ? skinsToSpine(rig.doc) : null),
    setIkLive,
    ikLive: () => ikLive,
    handIk: (side: Side) => handIk(side),
    gatesNow: () => (rig ? poseGates(rig.doc, clipName, clip, displayTime(), pending, pendingMove, pendingScale, pendingShear) : null)
  };
  Object.assign(window.atlasEditor, setup.api, { canvasTool: () => canvasToolId, setCanvasTool, meshes: listMeshes, hiddenSlots: () => [...hiddenSlots] });
  void offerRestore();
}

void boot();
