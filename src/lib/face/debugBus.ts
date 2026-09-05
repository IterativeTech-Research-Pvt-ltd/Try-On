/**
 * A mailbox for what the earring solver last computed.
 *
 * The same one-slot, no-subscribers arrangement the ring and necklace buses use,
 * written every frame from inside the render loop and therefore never touching
 * React state.
 *
 * It exists for the reason the necklace's does, and the phrasing is the giveaway:
 * "it is not on my ears" describes at least four different faults. The tracker
 * may have the ears in the wrong place; it may have them right and the lobe drop
 * may be too long or too short; the head's stand-in may be swallowing the pair;
 * or the pieces may be drawn at the wrong size and only *look* misplaced.
 * Those have nothing in common except how they look, so the only way to tell
 * them apart is to draw what the solver believes and compare it with a face.
 */
export type EarDebugFrame = {
  /** The head's landmarks, in anchor-plane units. */
  ear: { left: { x: number; y: number }; right: { x: number; y: number } };
  mouth: { x: number; y: number };
  nose: { x: number; y: number };
  /** Where each piece was hung, in anchor-plane units. */
  lobe: { left: { x: number; y: number }; right: { x: number; y: number } };
  /** The head's centre and stand-in, so a swallowed pair is visible as one. */
  headCentre: { x: number; y: number };
  headWidth: number;
  headHeight: number;
  /** Ear-to-ear breadth in anchor-plane units, undone for the turn. */
  breadthUnits: number;
  headBreadthMm: number;
  headTurnDeg: number;
  headRollDeg: number;
  /** How far below the ear each piece hangs, in millimetres. */
  dropMm: number;
  /** Which of the pair the solver considers in view at all. */
  visible: { left: boolean; right: boolean };
  stamp: number;
};

export const earDebugBus: { frame: EarDebugFrame | null } = { frame: null };

export function publishEarDebug(frame: EarDebugFrame): void {
  earDebugBus.frame = frame;
}

export function clearEarDebug(): void {
  earDebugBus.frame = null;
}
