/*
 * Atlas Animator: original implementation.
 *
 * A runtime slot: one entry of the draw list, bound to a bone, showing at most one attachment.
 *
 * What a slot shows is decided in layers, resolved by the skeleton after every update:
 * 1. `placeholder`: the setup attachment name, replaced by attachment keys (phase 2);
 * 2. `drivenPlaceholder`: an override from driven keys this frame (undefined = no override,
 *    null = show nothing);
 * 3. the active skins map the placeholder name to an attachment (later skins win);
 * 4. a slot hidden by an active skin, or on an inactive skin bone, shows nothing.
 */
import type { Attachment, MeshAttachment } from "./attachments.js";
import type { Bone } from "./bone.js";
import { copyRgba, parseRgba, type Rgba } from "./color.js";
import type { SequenceMode, SlotData } from "./format.js";

export class Slot {
  readonly data: SlotData;
  readonly index: number;
  readonly bone: Bone;
  readonly setupColor: Readonly<Rgba>;
  /** Current colour (multiplies the attachment's colour). Animation writes it; setup resets it. */
  readonly color: Rgba;
  /** Placeholder name shown, before driven overrides and skins. */
  placeholder: string | null;
  /** Driven-key override for this frame; undefined = none, null = show nothing. */
  drivenPlaceholder: string | null | undefined = undefined;
  /** Driven-key opacity this frame (1 = none); renderers multiply it into `color.a`. */
  drivenAlpha = 1;
  /**
   * Image-sequence state: the active sequence key (null = none, the attachment's setup frame
   * shows), the seconds since it, and the frame the skeleton resolved for the shown attachment.
   */
  sequenceMode: SequenceMode | null = null;
  sequenceIndex = 0;
  sequenceDelay = 0;
  sequenceElapsed = 0;
  sequenceFrame = 0;
  /** True while an active skin hides this slot. */
  hidden = false;
  /** The attachment drawn this frame (resolved by the skeleton). */
  attachment: Attachment | null = null;
  /**
   * Draw group shown in this slot this frame (plan 4d, draw groups): a grouped mesh shown by
   * `groupOwner` draws group `groupIndex` of its geometry here. Renderers draw the group instead
   * of `attachment`; a slot whose attachment is a grouped mesh draws only its own group.
   */
  groupMesh: MeshAttachment | null = null;
  groupIndex = -1;
  groupOwner: Slot | null = null;

  constructor(data: SlotData, index: number, bone: Bone) {
    this.data = data;
    this.index = index;
    this.bone = bone;
    this.setupColor = parseRgba(data.color);
    this.color = parseRgba(data.color);
    this.placeholder = data.attachment;
  }

  /** The placeholder name in effect after driven overrides. */
  get effectivePlaceholder(): string | null {
    return this.drivenPlaceholder === undefined ? this.placeholder : this.drivenPlaceholder;
  }

  setToSetupPose(): void {
    copyRgba(this.setupColor, this.color);
    this.placeholder = this.data.attachment;
    this.sequenceMode = null;
    this.sequenceElapsed = 0;
  }
}
