/*
 * Atlas Animator editor: original implementation.
 *
 * One table of tooltips for every control. The key text comes from the hotkey table (hotkeys.ts), the same table the "?" cheat
 * sheet is drawn from, so a rebound key changes the tooltip and the cheat sheet together. A control the table does not name
 * (the panels build many of their own) still gets a title: its own, or one derived from its label, so nothing is bare.
 */

import { HOTKEYS, type HotkeyAction } from "./hotkeys.js";

export interface TipDef {
  /** CSS selector of the control(s). The first matching entry wins. */
  sel: string;
  /** A short plain description. */
  tip: string;
  /** The hotkey, looked up in the hotkey table. */
  action?: HotkeyAction;
  /** A key or gesture that is not a hotkey (Wheel, Ctrl+C on keys ...). */
  keys?: string;
}

/** The right panel's tabs; also listed in the cheat sheet. */
export const TABS = [
  { id: "pose", label: "Pose", tip: "The selected bone: numbers, hand IK, compensate" },
  { id: "keys", label: "Keys", tip: "Image swap and draw order keys, curves and easing presets, events, the arc overlay, root and foot lock, smear" },
  { id: "rig", label: "Rig", tip: "Setup-mode tools and constraints, slots and the setup draw order" },
  { id: "skins", label: "Skins", tip: "Skins: worn, mixed, placeholders" },
  { id: "preview", label: "Preview", short: "View", tip: "Layered preview, game-size preview, silhouette, onion skin and underlay" },
  { id: "transitions", label: "Transitions", short: "Graph", tip: "A state graph of the rig's clips: transitions with blend times, previewed on the stage" },
  { id: "library", label: "Library", short: "Poses", tip: "Pose library and copy / paste pose" },
  { id: "export", label: "Export", tip: "Save, apply to the rig, render sheets, live gates" }
] as const;

export type TabId = (typeof TABS)[number]["id"];

export const TIPS: readonly TipDef[] = [
  // Header: logo and workspaces
  { sel: "#logo", tip: "Back to the Home screen", action: "home" },
  { sel: "#wsbar [data-go=home]", tip: "Home: pick what to work on" },
  { sel: "#wsbar [data-go=animate]", tip: "Animate: pose and key clips (Pose, Keys and Library tabs)" },
  { sel: "#wsbar [data-go=swag]", tip: "Swag: make a cosmetic item (Skins and Preview tabs)" },
  { sel: "#wsbar [data-go=rig]", tip: "Rig: build the bones, slots and skins (Setup mode)" },
  { sel: "#wsbar [data-go=ship]", tip: "Ship: check everything and send it to your project" },
  { sel: "#wsbar [data-go=pro]", tip: "Pro: every tab and tool in one place" },
  // Rule checker strip above the canvas
  { sel: "#rules-toggle", tip: "Rule checker: show or hide the red warnings on the canvas, the chips and the timeline ticks" },
  { sel: "#rules-pill", tip: "Rule check summary: click to list the broken rules" },
  { sel: "#rulechips .rule-chip.bad", tip: "This pose rule is broken. Click to jump to the first bad frame and select the bone" },
  { sel: "#rulechips .rule-chip", tip: "This pose rule holds on every frame of the clip" },
  // Motion paths and pins (bottom-left of the canvas)
  { sel: "#paths-toggle", tip: "Motion paths: draw the trail of the selected bones, the weapon tip or a fist across the clip. One dot per frame, big dots are keys, colour shows speed (blue slow, red fast). Click a dot to jump to its frame" },
  { sel: "#paths-sel", tip: "Draw a path for each selected bone" },
  { sel: "#paths-tip", tip: "Draw the weapon tip's path (on by default in attack clips)" },
  { sel: "#paths-fist", tip: "Draw the path of the fist centre (the middle of the weapon hand)" },
  { sel: "#paths-range", tip: "How much of each path to show: the whole clip, or a few frames each side of the playhead" },
  { sel: "#pins-toggle", tip: "Pins: plant a hand or foot at its current spot over a frame range so the body can move without it sliding" },
  { sel: "#pins-from", tip: "First frame of the pin" },
  { sel: "#pins-to", tip: "Last frame of the pin" },
  { sel: "#pinsbar .pin-add[data-kind=grip]", tip: "Keep the far hand on the weapon grip over the frame range (two-handed hold)" },
  { sel: "#pinsbar .pin-add", tip: "Pin this hand or foot where it stands now over the frame range (IK on, target held)" },
  { sel: "#pinsbar .pin-chip", tip: "A pin in this clip. Click to jump to its first frame" },
  { sel: "#pinsbar .pin-unpin", tip: "Remove this pin; the limb goes back to its FK keys" },
  // Home
  { sel: "#home .home-card[data-go=animate]", tip: "Animate a clip: pose the player and key a project clip" },
  { sel: "#home .home-card[data-go=swag]", tip: "Make a swag item: drop in art and see it on every clip" },
  { sel: "#home .home-card[data-go=rig]", tip: "Rig: bones, slots and skins for the player" },
  { sel: "#home .home-card[data-go=ship]", tip: "Ship: check everything and send it to your project" },
  { sel: "#home .home-continue-btn", tip: "Open the clip you were last working on" },
  { sel: "#home .home-clip", tip: "Open this clip in the Animate workspace" },
  { sel: "#soon .soon-home", tip: "Back to the Home screen" },
  { sel: "#soon .soon-pro", tip: "Open the Pro workspace with every tab" },
  // Phone dock
  { sel: "#dock-collapse", tip: "Collapse the phone dock to a thin rail" },
  { sel: "#dock-open", tip: "Open the phone dock: the character at true game size on a phone" },
  { sel: "#dock-z471", tip: "Phone (large): the player at the larger phone scale, 0.471, as the runtime draws it" },
  { sel: "#dock-z400", tip: "Phone (small): the player at the smaller phone scale, 0.4, as the runtime draws it" },
  { sel: "#dock-silhouette", tip: "Silhouette: the character flat black on a light ground, to judge the read at game size" },
  { sel: "#dock-mirror", tip: "Mirror: preview the mirrored right-facing side in the dock (the runtime flips the left view)" },
  // Animate bar and bone list
  { sel: "#ab-key", tip: "Key character pose: key every standard pose bone (not IK targets or helpers) at this frame, each bone's changed channels or its rotate. K is Key selected bones" },
  { sel: "#ab-prevkey", tip: "Jump to the previous key", action: "prevKey" },
  { sel: "#ab-nextkey", tip: "Jump to the next key", action: "nextKey" },
  { sel: "#key-menu-btn", tip: "Key menu: Key character pose, Key all channels, Delete key here, Breakdown, select / copy / paste keys, Scale timing, Play range, Events and Reset pose" },
  { sel: "#mirror-menu-btn", tip: "Mirror menu: Mirror selected bones (M), Flip pose (Shift+M) and copy one arm or leg to the other side" },
  { sel: "#mm-mirror", tip: "Mirror: copy the selected bones onto their other side and key them (spine and head mirror in place)", action: "mirror" },
  { sel: "#mm-flip", tip: "Flip pose: swap near and far for every bone, mirror the spine and head and key it all, then show the right-facing side in the phone dock", action: "flipPose" },
  { sel: "#mm-arm-nf", tip: "Copy the near arm onto the far arm and key it" },
  { sel: "#mm-arm-fn", tip: "Copy the far arm onto the near arm and key it" },
  { sel: "#mm-leg-nf", tip: "Copy the near leg onto the far leg and key it" },
  { sel: "#mm-leg-fn", tip: "Copy the far leg onto the near leg and key it" },
  { sel: "#scale-open", tip: "Scale timing: stretch or squeeze the timing of the selected keys (the whole clip when none)" },
  { sel: "#ab-breakdown", tip: "Breakdown: key the selected bones part of the way between their previous and next keys", action: "breakdown" },
  { sel: "#xs-keyit", tip: "Key changes: key every unkeyed edit (all channels) at this frame in one step. Scrubbing away keeps them parked on this frame" },
  { sel: "#ship-spine-export", tip: "Export Spine: write the whole rig as a Spine project (JSON, atlas, images, every clip) and show where it went" },
  { sel: "#ab-done", tip: "Mark done: save this clip and tick it off on the clip board" },
  // Transform strip (docked at the bottom of the canvas) and the canvas edge controls
  { sel: "#sk-mesh", tip: "Shape keys: the mesh to deform (the meshes showing on this frame)" },
  { sel: "#sk-soft", tip: "Soft selection: vertices near the selection follow, fading out to the radius" },
  { sel: "#sk-clear-sel", tip: "Clear deform: zero the selected vertices on this frame (the key stays)" },
  { sel: "#sk-clear-key", tip: "Clear deform: delete the shape key on this frame" },
  { sel: "#sk-clear-all", tip: "Clear deform: remove this mesh's whole shape-key timeline" },
  { sel: "#sw-phone", tip: "Phone size: show the character at the zoom a phone shows it (0.42). Click again to fit the view", action: "phoneSize" },
  { sel: "#sw-facing", tip: "Facing right: see the item mirrored, as the runtime draws the right side (look-only)", action: "facingRight" },
  { sel: "#sw-prevpose", tip: "Previous pose: jump to the previous key of any bone", action: "prevPose" },
  { sel: "#sw-nextpose", tip: "Next pose: jump to the next key of any bone", action: "nextPose" },
  { sel: "#swagsheet [data-act=close-sheet]", tip: "Back to the workshop" },
  { sel: "#swagsheet [data-act=download]", tip: "Download this sheet as one PNG: every page, the same grid as the screen" },
  { sel: "#swagsheet [data-mode=clips]", tip: "One row per project clip: first, contact, middle and last frame" },
  { sel: "#swagsheet [data-mode=sweep]", tip: "One row per stress pose: the same item through four angles of a joint" },
  { sel: "#gate-toggle", tip: "Outline gate: show red marks where a garment piece's ink outline is broken on this pose" },
  { sel: "#gate-check", tip: "Render every frame of the clip and mark the ones with a broken outline on the timeline" },
  { sel: "#xs-space-local", tip: "Local axes: the gizmo and Translate / Rotate numbers follow the bone's own axes" },
  { sel: "#xs-space-parent", tip: "Parent axes: the gizmo and numbers follow the parent bone's axes (how offsets are stored)" },
  { sel: "#xs-space-world", tip: "World axes: the gizmo and numbers follow the screen axes; Rotate shows the bone's world angle" },
  { sel: "#xs-comp-bones", tip: "Compensate bones: moving or rotating a bone keeps its child bones where they were" },
  { sel: "#xs-comp-images", tip: "Compensate images: moving a bone keeps the images on its slots where they were (Setup mode only)" },
  { sel: "#xs-grid-bones-selectable", tip: "Bones selectable: allow picking bones on the canvas (editor only)" },
  { sel: "#xs-grid-bones-visible", tip: "Bones visible: show the bone overlay on the canvas (editor only)" },
  { sel: "#xs-grid-images-selectable", tip: "Images selectable: allow picking images in Setup mode (editor only)" },
  { sel: "#xs-grid-images-visible", tip: "Images visible: show the character's art (editor only; the rig is not changed)" },
  { sel: "#xs-grid-others-selectable", tip: "Others selectable: allow picking helper bones such as IK targets (editor only)" },
  { sel: "#xs-grid-others-visible", tip: "Others visible: show helper bones such as IK targets (editor only)" },
  { sel: ".xf-in[data-ch=rotate]", tip: "Rotate in degrees. Type a value, scroll over it, or drag the label (Shift fine, Ctrl coarse)" },
  { sel: ".xf-in[data-ch=translate]", tip: "Translate in rig units. Type a value, scroll over it, or drag the label (Shift fine, Ctrl coarse)" },
  { sel: ".xf-in[data-ch=scale]", tip: "Scale as a multiple of setup. Type a value, scroll over it, or drag the label (Shift fine, Ctrl coarse)" },
  { sel: ".xf-in[data-ch=shear]", tip: "Shear in degrees. Type a value, scroll over it, or drag the label (Shift fine, Ctrl coarse)" },
  { sel: ".xf-key", tip: "Key this channel at the frame. Shift-click keys every channel" },
  { sel: "#xs-ruler", tip: "Rulers: show pixel rulers on the top and left edges, in rig units" },
  { sel: "#xs-zoom", tip: "Zoom: drag to zoom the view" },
  { sel: "#xs-mag", tip: "Zoom to 100%" },
  { sel: "#bones-more", tip: "Show or hide the shoulders, spine and arm and leg bones" },
  { sel: "#bones-showall", tip: "Open the Pro workspace to list every bone" },
  // Header
  { sel: "#modeseg [data-mode=animate]", tip: "Animate mode: pose and key clips on the rig" },
  { sel: "#modeseg [data-mode=setup]", tip: "Setup mode: build the rig (bones, images, constraints)" },
  { sel: "#clip", tip: "Choose the clip to edit" },
  { sel: "#newclip-open", tip: "New clip: create an empty clip" },
  { sel: "#newclip-name", tip: "Name of the new clip" },
  { sel: "#newclip-make", tip: "Create the clip" },
  { sel: "#newclip-cancel", tip: "Cancel, no clip is made" },
  { sel: "#helpbtn", tip: "Help menu: user guide, keyboard shortcuts, troubleshooting, data folder path, about (the ? key or F1 opens the key sheet directly)" },
  { sel: "#helpclose", tip: "Close the cheat sheet", keys: "Esc" },
  // Clip board
  { sel: "#clips-open", tip: "Clip board: the sample clip list, and how far along each one is" },
  { sel: "#clip-manage", tip: "Manage this clip: rename, duplicate, delete (asks first), set length and fps. Length and fps can be undone with Ctrl+Z" },
  { sel: "#rig-add-parts", tip: "Add parts: pick PNGs or a PSD to add to the open rig (rigs made with New rig). Save the rig first" },
  { sel: "#cb-standin", tip: "This weapon is not drawn in the rig yet, so poses are made with a stand-in" },
  { sel: "#cb-close", tip: "Back to the editor", keys: "Esc" },
  { sel: "#cb-dup-src", tip: "The clip whose poses and events are copied" },
  { sel: "#clipboard [data-filter=all]", tip: "Show every clip" },
  { sel: "#clipboard [data-filter=missing]", tip: "Show only clips that are not made yet" },
  { sel: "#clipboard [data-filter=draft]", tip: "Show only clips that are made but not marked done" },
  { sel: "#clipboard [data-filter=problems]", tip: "Show only clips that need a re-check or fail a check" },
  { sel: "#clipboard .cb-menu-item[data-act=done]", tip: "Save the clip and mark it done (or take it off the done list)" },
  { sel: "#clipboard .cb-menu-item[data-act=duplicate]", tip: "Copy the poses and events of another clip into this one" },
  { sel: "#clipboard .cb-menu-item[data-act=reset]", tip: "Replace this clip with a fresh template" },
  { sel: "#cb-new-clip", tip: "New clip: name it, start blank, from a game template or from a copy, set length and fps, then it opens in Animate" },
  { sel: "#cb-new-clip-sec", tip: "New clip: make a clip of your own, saved under My clips" },
  { sel: "#cb-add-slot", tip: "Add slot: add a new required clip (an emote, a combo step, a move) to the board. Saved in clips/board-config.json and removable" },
  { sel: "#cb-deleted", tip: "Recently deleted: restore a clip you deleted from its saved versions (the newest 50 of each clip are kept)" },
  { sel: "#cb-new-name", tip: "Clip name: letters, digits, _ . - (it becomes <name>.clip.json)" },
  { sel: "#cb-new-from", tip: "What the new clip starts as: empty, a game template (length and events filled in), or a copy of a clip you made" },
  { sel: "#cb-new-length", tip: "Length in seconds (rounded to whole frames)" },
  { sel: "#cb-new-fps", tip: "Frames per second (30 matches the project)" },
  { sel: "#cb-new-loop", tip: "Loop: a looping clip repeats, a one-shot plays once" },
  { sel: "#cb-dup-name", tip: "Name for the copy" },
  { sel: "#cb-rename-name", tip: "New name; the file is renamed too" },
  { sel: "#cb-len-length", tip: "New length in seconds (rounded to whole frames)" },
  { sel: "#cb-len-fps", tip: "New frames per second; keys snap onto the new frames" },
  { sel: "#cb-path", tip: "The clip file on disk" },
  { sel: "#cb-path-copy", tip: "Copy the full file path to the clipboard" },
  { sel: "#cb-slot-category", tip: "Which list on the board the new required clip goes in" },
  { sel: "#cb-slot-label", tip: "What the clip is called on the board, for example Emote: dance" },
  { sel: "#cb-slot-id", tip: "The clip file name; the project looks the clip up by it" },
  { sel: "#cb-slot-row", tip: "Which class row of the attack matrix; Generic lets you pick the weapon" },
  { sel: "#cb-slot-weapon", tip: "Which weapon column of the attack matrix" },
  { sel: "#cb-slot-length", tip: "How long the clip should be, in seconds" },
  { sel: "#cb-slot-loop", tip: "Loop: a looping clip repeats, a one-shot plays once" },
  { sel: "#clipboard .cb-menu-item[data-act=open]", tip: "Open the clip in Animate, or create it from its template if it is not made yet" },
  { sel: "#clipboard .cb-menu-item[data-act=rename]", tip: "Rename the clip and its file (your own clips only)" },
  { sel: "#clipboard .cb-menu-item[data-act=duplicate-copy]", tip: "Save a copy of this clip under a new name in My clips" },
  { sel: "#clipboard .cb-menu-item[data-act=delete]", tip: "Delete the clip file from disk (asks first)" },
  { sel: "#clipboard .cb-menu-item[data-act=length]", tip: "Change the clip length and frame rate" },
  { sel: "#clipboard .cb-menu-item[data-act=reveal]", tip: "Show where the clip file lives on disk, with a Copy path button" },
  { sel: "#clipboard .cb-menu-item[data-act=removeslot]", tip: "Take this slot off the board; the clip file stays" },
  { sel: "#clipboard .cb-go", tip: "Do it" },
  { sel: "#clipboard .cb-cancel", tip: "Cancel, nothing changes" },
  // Bones list
  { sel: "#bonefilter", tip: "Filter the bone list by name" },
  // Viewport toolbar
  { sel: "#bgs button", tip: "Canvas background colour" },
  { sel: "#gizmo [data-mode=rotate]", tip: "Rotate: drag a bone to rotate it", action: "rotate" },
  { sel: "#gizmo [data-mode=move]", tip: "Move: drag a bone to translate it in its parent's space", action: "move" },
  { sel: "#gizmo [data-mode=scale]", tip: "Scale: squash and stretch the selected bone (limbs never stretch)", action: "scale" },
  { sel: "#gizmo [data-mode=shear]", tip: "Shear: skew the selected bone's axes" },
  { sel: "#gizmo [data-mode=ik]", tip: "Hand IK: drag a fist and the arm follows (written as rotate keys)", action: "ik" },
  { sel: "#compensate", tip: "Compensate: moving or rotating a bone keeps its children where they are", action: "compensate" },
  { sel: "#zoomout", tip: "Zoom out", keys: "Wheel" },
  { sel: "#zoomin", tip: "Zoom in", keys: "Wheel" },
  { sel: "#fit", tip: "Fit the whole character in the view", action: "fitAll" },
  { sel: "#bonesvis", tip: "Show or hide the bone overlay", action: "bonesOverlay" },
  { sel: "#boneview", tip: "Bone view: show all bones, dim them so the art reads through, show only the selected chain, or hide them (remembered per workspace)", action: "boneView" },
  { sel: "#bonesize", tip: "Bone size: how big the bones draw on the canvas (the same on screen at any zoom)" },
  { sel: "#bonecrumb", tip: "The selected bone and its parents: click a name to select that bone" },
  { sel: "#helpersvis", tip: "Show helper bones too (IK targets that are off, weapon markers); a live IK target always shows as a pink square" },
  { sel: "#silhouette", tip: "Silhouette only: flat black on a light ground, to judge readability" },
  { sel: "#gameviewbtn", tip: "Game view: the clip as the runtime draws it, on ground with a shadow, a target, the slash trail and hit feel", action: "gameView" },
  { sel: "#facingbtn", tip: "Preview facing right: the whole character flipped at the root, as the runtime draws the right side (look-only)" },
  { sel: "#previewbtn", tip: "Game-size preview at 0.4 and 0.471, with an optional reference beside it" },
  // Preview tab
  { sel: "#abpin", tip: "Pin the current pose (this frame of this clip, with unkeyed edits) as pose A to compare against", action: "pinPose" },
  { sel: "#abghost", tip: "Show pinned pose A as a violet ghost over the live pose B", action: "ghostPose" },
  { sel: "#abswap", tip: "Swap A and B: show pose A in place of the live pose, press again to return (look-only)", action: "swapPose" },
  { sel: "#abclear", tip: "Forget pinned pose A" },
  { sel: "#gatehud-outline", tip: "Outline gate on this pose: click to jump to the next frame with a broken ink outline (Shift: previous)", action: "gateHud" },
  { sel: "#gatehud-rules", tip: "Pose rules on this pose: click to jump to the next frame that breaks one (Shift: previous)" },
  { sel: "#gatehud-ik", tip: "IK reach: click to jump to the next frame where an arm or leg is at full stretch (Shift: previous)" },
  { sel: "#onionbtn", tip: "Onion skin: ghosts of the frames before (cool blue) and after (warm orange) behind the rig", action: "onion" },
  { sel: "#onionmode [data-v=frames]", tip: "Onion skin: ghost the frames around this one (every N frames)" },
  { sel: "#onionmode [data-v=keys]", tip: "Onion skin: ghost the neighbouring keys of the clip, however far apart they are" },
  { sel: "#onionstyle [data-v=tint]", tip: "Onion skin: whole ghosts, tinted cool before and warm after" },
  { sel: "#onionstyle [data-v=outline]", tip: "Onion skin: only the silhouette edge of each ghost", action: "onionStyle" },
  { sel: "#onionbefore", tip: "Onion skin: ghosts before the frame (0 to 6)" },
  { sel: "#onionafter", tip: "Onion skin: ghosts after the frame (0 to 6)" },
  { sel: "#onionstep", tip: "Onion skin: frames between ghosts (frames mode)" },
  { sel: "#onionopacity", tip: "Onion skin: opacity of the nearest ghost" },
  { sel: "#onionfalloff", tip: "Onion skin: how fast the ghosts fade the further they are from this frame" },
  { sel: "#underinput", tip: "Underlay: a faded reference image or sprite strip behind the rig" },
  { sel: "#underframes", tip: "Underlay: frames in the strip (1 = a single image)" },
  { sel: "#underopacity", tip: "Underlay opacity" },
  { sel: "#underscale", tip: "Underlay size, percent of a 1120 px figure" },
  { sel: "#underclear", tip: "Remove the underlay" },
  { sel: "#tracktoggle", tip: "Layered preview on or off: combined clips play on the stage, the edited clip is untouched" },
  { sel: "#trackplay", tip: "Play or pause the layered preview" },
  { sel: "#trackadd", tip: "Add a clip track to the layered preview" },
  { sel: "#trackscrub", tip: "Scrub the layered preview" },
  // Pose tab: mirror and breakdown
  { sel: "#mirrorsel", tip: "Mirror: copy the selected bones onto their other side and key them (spine and head mirror in place)", action: "mirror" },
  { sel: "#mirrorlimb", tip: "Bring everything below the selected bones too (a shoulder brings the whole arm)" },
  { sel: "#flippose", tip: "Flip pose: swap near and far for every bone, mirror the spine and head, and key it all", action: "flipPose" },
  { sel: "#mirror-arm-nf", tip: "Copy the near arm (and its hand target) onto the far arm" },
  { sel: "#mirror-arm-fn", tip: "Copy the far arm (and its hand target) onto the near arm" },
  { sel: "#mirror-leg-nf", tip: "Copy the near leg (foot target included) onto the far leg" },
  { sel: "#mirror-leg-fn", tip: "Copy the far leg (foot target included) onto the near leg" },
  { sel: "#bdslider", tip: "Breakdown: key the selected bones at this % between their previous and next keys (0 previous, 100 next, beyond overshoots)", action: "breakdown" },
  { sel: "#bdvalue", tip: "Breakdown percentage (0 = previous key, 100 = next key)", action: "breakdown" },
  // Library: history and autosave
  { sel: "#autosavenow", tip: "Write a version of the working clip and unsaved rig edits now (also written every minute and on a clip switch)" },
  { sel: "#exitpreview", tip: "Leave the autosave version preview and go back to the working clip" },
  { sel: "#restorebtn", tip: "Bring back the clip and unsaved rig edits from the newer autosave" },
  { sel: "#restorehistory", tip: "Open the History panel to pick a version" },
  { sel: "#restoredismiss", tip: "Stop asking about these autosave versions" },
  // Library / pose
  { sel: "#copypose", tip: "Copy every bone's pose at the playhead", action: "copy" },
  { sel: "#copyposesel", tip: "Copy only the selected bones' pose at the playhead" },
  { sel: "#pastepose", tip: "Key the copied pose at the playhead", action: "paste" },
  { sel: "#posename", tip: "Name for the pose to save (letters, digits, underscores)" },
  { sel: "#savepose", tip: "Save the current pose into the pose library" },
  // Setup > Weights
  { sel: "#wt-bind", tip: "Bind the mesh to the chain from its slot bone to the selected bone, then auto-weight it" },
  { sel: "#wt-apply", tip: "Compute weights with the chosen method (Heat, Distance or Sleeve profile) and save them" },
  { sel: "#wt-bones .wt-lock", tip: "Lock this bone so painting never changes its weights" },
  { sel: "#wt-bend", tip: "Bend the active bone on a scratch skeleton to check the weights; your pose is untouched" },
  { sel: "#wt-swing", tip: "Swing the active bone back and forth while you paint" },
  { sel: "#wt-setsel", tip: "Set the active bone to this value on every selected vertex" },
  { sel: "#wt-normalise", tip: "Make every vertex sum to 1" },
  { sel: "#mesh-action-select", tip: "Points mode: click or drag a box to select points; empty space adds nothing", keys: "1" },
  { sel: "#mesh-action-add", tip: "Points mode: click empty space to add a point", keys: "2" },
  { sel: "#mesh-action-delete", tip: "Points mode: click a point to delete it (a selected group goes together)", keys: "3" },
  { sel: "#mesh-hint-trace", tip: "Outline the picture's opaque pixels and fill it with a mesh" },
  { sel: "#setup-attach-filter", tip: "Search the atlas images by name or folder" },
  { sel: "#setup-attach-variants", tip: "Show the crease (c###) and generated (g####) variants of each image" },
  { sel: "#setup-name", tip: "Rename the bone (Enter keeps it, Esc undoes the edit)" },
  { sel: "#wt-prune", tip: "Drop weights below the minimum, then renormalise" },
  { sel: "#wt-cap-go", tip: "Keep only the strongest influences per vertex (1 to 4) and show the weight dropped" },
  { sel: "#wt-restore", tip: "Put back the weights the rig's build scripts gave this mesh (carried over by UV position if the vertices changed)" },
  { sel: "#wt-mirror-far", tip: "Copy this near-side mesh's weights onto the far-side mesh (and its variants) in one step" },
  { sel: "#wt-mirror-near", tip: "Copy this far-side mesh's weights onto the near-side mesh (and its variants) in one step" },
  // Export
  { sel: "#save", tip: "Save the clip file", action: "save" },
  { sel: "#save-export", tip: "Save the clip file (the same as Save in the transport)", action: "save" },
  { sel: "#export", tip: "Download the clip as JSON" },
  { sel: "#apply", tip: "Save, then write the clip into the shown rig document" },
  { sel: "#applyall", tip: "Write the clip into every rig file (Side, Turned L, Turned R)" },
  { sel: "#render", tip: "Apply, then render the contact sheet and phone-size previews through the CLI" },
  { sel: "#checkclip", tip: "Run the limit, IK and contour check over the whole clip" },
  // Transport
  { sel: "#play", tip: "Play or pause the clip", keys: "Space" },
  { sel: "#prev", tip: "Previous frame", action: "prevFrame" },
  { sel: "#next", tip: "Next frame", action: "nextFrame" },
  { sel: "#speed", tip: "Playback speed, 0.1x to 2x: slows or speeds up how fast the playhead moves while you play. Preview only: the clip's fps and key times never change" },
  { sel: "#framecount", tip: "How many frames Insert and Delete act on" },
  { sel: "#insframes", tip: "Insert frames at the playhead: every key from this frame on moves later by the number of frames, and the clip grows. Undo puts it back" },
  { sel: "#delframes", tip: "Delete frames at the playhead: keys inside those frames are removed (you are asked first), later keys move earlier and the clip shrinks. Undo puts it back" },
  { sel: "#revkeys", tip: "Reverse the selected keys in time: the first selected key and the last trade places, so the motion between them plays backwards. Select two or more keys first" },
  { sel: "#keyinspector", tip: "Key inspector: what the selected key holds. Type a value, change the interpolation, or add a key on a slot colour or constraint mix" },
  { sel: "#ki-target", tip: "The channel to key: slot colour / alpha, transform constraint mix, physics mix or reset, IK mix" },
  { sel: "#ki-addkey", tip: "Adds a key for the chosen channel at the playhead frame, starting from the previous key or the rig's setup values" },
  { sel: "#held", tip: "Snap to frames: show held frames at the clip's fps, as the runtime draws them (off: smooth in-between time)" },
  { sel: "#loop", tip: "Clip loops" },
  { sel: "#duration", tip: "Clip length in seconds (snapped to whole frames). Editing it also updates the frames box" },
  { sel: "#durframes", tip: "Clip length in frames at the clip's fps. Editing it also updates the seconds box" },
  { sel: "#fps", tip: "Frame rate of this clip (24, 30, 60 or any whole number). The length in seconds stays; keys move onto the nearest new frame, and Undo brings them back" },
  { sel: "#returnstart", tip: "Return to start: when a clip that does not loop finishes playing, the playhead jumps back to where playback started" },
  { sel: "#addevent", tip: "Add an event marker (windup, hit, trailOn ...) at the playhead frame. Pick its name from the menu" },
  { sel: "#evrename", tip: "Rename the event marker at the playhead (or the selected one): pick a new name from the menu" },
  { sel: "#evdelete", tip: "Delete the event marker at the playhead (or the selected one)" },
  { sel: "#resetpose", tip: "Reset pose: put the selected bones (all bones when none is selected) back to their setup pose at the playhead" },
  { sel: "#autokey", tip: "Auto key: rotating a bone keys it at the playhead", action: "autoKey" },
  { sel: "#setkey", tip: "Key selected bones: key every changed channel (rotate, move, scale, shear) of each selected bone at the playhead, or its rotate when nothing changed. Key character pose keys every pose bone", action: "key" },
  { sel: "#delkey", tip: "Delete the selected bones' keys at the playhead", action: "deleteKey" },
  { sel: "#undo", tip: "Undo the last change (the tip names it)", action: "undo" },
  { sel: "#redo", tip: "Redo the last undone change (the tip names it)", action: "redo" },
  { sel: "#selall", tip: "Select every key in the dopesheet", action: "selectAllKeys" },
  { sel: "#selrange", tip: "Select every key inside the play range (the whole clip when none)" },
  { sel: "#copykeys", tip: "Copy the selected keys", keys: "Ctrl+C" },
  { sel: "#pastekeys", tip: "Paste the copied keys with the first one at the playhead", keys: "Ctrl+V" },
  { sel: "#scalepct", tip: "Timing scale in percent (50 = twice as fast)" },
  { sel: "#applyscale", tip: "Scale the selected keys' timing about the playhead (the whole clip when none)" },
  { sel: "#rangein", tip: "Play range starts at the playhead", action: "rangeIn" },
  { sel: "#rangeout", tip: "Play range ends at the playhead", action: "rangeOut" },
  { sel: "#rangeclear", tip: "Play the whole clip again" },
    { sel: "#tlfit", tip: "Fit the whole clip in the timeline" },
  { sel: "#tlsplit", tip: "Resize the timeline: drag, or Up / Down when focused (Shift = bigger steps); double-click for tallest / back", keys: "Drag" },
  { sel: "#tlkeytip", tip: "Key details while hovering a key in the timeline: bone, channel, frame, value, interpolation" },
  { sel: "#tlzoom", tip: "Timeline zoom (the wheel over the keys also zooms)", keys: "Wheel" },
  { sel: "#tlpan", tip: "Timeline pan (Shift + wheel, middle drag or Space + drag also pan)" },
  { sel: "#transitionsbtn", tip: "Transitions: open the clip state graph (blend times between clips) and play it on the stage" },
  { sel: "#graphbtn", tip: "Graph editor: value-over-time curves with draggable keys and bezier handles", action: "graph" },
  // Right panel selects the panels build themselves
  { sel: "#eventpanel .row > select", tip: "Event to add at the playhead: windup, hit, trail, follow or ready" },
  { sel: "#slotpanel .kv > .v > select", tip: "Slot to inspect: the image it shows, its swap key and its draw order" },
  { sel: "#skinpanel .kv > .v > select", tip: "Skin to inspect, wear or edit" },
  // Setup mode
  { sel: "#setup-slot", tip: "Slot to edit: its images and draw order" },
  { sel: "#setupsave", tip: "Save the rig document", action: "save" },
  // Mesh tool (Setup)
  { sel: "#mesh-trace", tip: "Outline the picture's opaque pixels and fill it with a fresh mesh" },
  { sel: "#mesh-grid", tip: "Keep the outline and fill the inside with an even grid of points" },
  { sel: "#mesh-rect", tip: "Four corners of the picture and two triangles" },
  { sel: "#mesh-density", tip: "How many points the new mesh gets" },
  { sel: "#mesh-variants", tip: "Repeat each edit on sibling images that have the same number of points" },
  { sel: "#mesh-delete", tip: "Delete the selected points", keys: "Delete" },
  { sel: "#mesh-uv-head", tip: "Show or hide the UV view (the picture with its wireframe)" }
];

/** The hotkey text for a table entry ("R", "Ctrl+S", "Wheel"), or "". */
export function keysFor(def: Pick<TipDef, "action" | "keys">): string {
  if (def.keys) return def.keys;
  if (def.action) return HOTKEYS.find((h) => h.action === def.action)?.keys ?? "";
  return "";
}

/** "Rotate: drag a bone to rotate it (R)". */
export function tipText(def: TipDef): string {
  const keys = keysFor(def);
  return keys ? `${def.tip} (${keys})` : def.tip;
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** A title for a control the table does not name: its own label, the label beside it, its text or its placeholder. */
export function deriveTip(e: HTMLElement): string {
  const aria = clean(e.getAttribute("aria-label"));
  if (aria) return aria;
  const tag = e.tagName.toLowerCase();
  const type = (e as HTMLInputElement).type;
  const wrap = e.closest("label");
  if (wrap) {
    const text = clean(wrap.textContent);
    if (text) return text;
  }
  if (tag === "summary") {
    const text = clean(e.textContent);
    return text ? `Show or hide: ${text.slice(0, 60)}` : "Show or hide this section";
  }
  if (tag === "button") {
    const text = clean(e.textContent);
    if (text) return text;
  }
  const placeholder = clean((e as HTMLInputElement).placeholder);
  if (placeholder) return placeholder;
  // A key-value row: the row's own label, with the constraint it belongs to when there is one.
  const cell = e.closest(".v");
  const rowLabel = clean(cell?.previousElementSibling?.textContent);
  if (cell && rowLabel && rowLabel.length <= 48) {
    const side = e.nextSibling?.nodeType === 3 ? clean(e.nextSibling.textContent) : "";
    const owner = clean(e.closest("details.con")?.querySelector("summary b")?.textContent);
    const what = type === "checkbox" && side ? `${rowLabel}: ${side}` : rowLabel;
    return owner ? `${owner} constraint, ${what.toLowerCase()}` : what;
  }
  // A heading or label right before the control (the key-value rows and the "label + select" rows).
  let prev = e.previousElementSibling;
  while (prev && !clean(prev.textContent)) prev = prev.previousElementSibling;
  if (prev && prev !== e && !/^(BUTTON|INPUT|SELECT)$/.test(prev.tagName)) {
    const text = clean(prev.textContent);
    if (text && text.length <= 48) return text;
  }
  const section = e.closest("section")?.querySelector("h2");
  const where = section ? clean(section.firstChild?.textContent ?? section.textContent) : "";
  const kind = tag === "select" ? "Choose" : type === "checkbox" ? "Toggle" : type === "number" ? "Number" : type === "range" ? "Slider" : tag === "button" ? "Button" : "Field";
  return where ? `${kind} (${where.toLowerCase()})` : kind;
}

/** The title for a control: the table entry's text, or "" when the table does not name it. */
export function tableTipFor(e: Element, tips: readonly TipDef[] = TIPS): string {
  for (const t of tips) if (e.matches(t.sel)) return t.tip ? tipText(t) : "";
  return "";
}

const CONTROLS = "button, input, select, textarea, summary";

/** Gives every control a title now, and every control the panels add later. Returns a function that stops watching. */
export function installTooltips(root: HTMLElement = document.body): () => void {
  const apply = () => {
    for (const e of root.querySelectorAll<HTMLElement>(CONTROLS)) {
      if (e.dataset.tipped) continue;
      const fromTable = tableTipFor(e);
      if (fromTable) e.title = fromTable;
      else if (!e.title) e.title = deriveTip(e);
      e.dataset.tipped = "1";
    }
  };
  apply();
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      apply();
    });
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
