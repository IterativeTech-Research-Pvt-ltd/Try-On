import { Matrix4, Quaternion, Vector3 } from "three";
import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { FACE_LANDMARK_COUNT, FM } from "./tracker";
import { DEFAULT_ONE_EURO, OneEuroVector, type OneEuroConfig } from "@/lib/hand/oneEuro";
import { ANCHOR_DISTANCE, projectToAnchorPlane, type FrameGeometry } from "@/lib/hand/projection";
import { MedianTracker } from "@/lib/hand/measure";

/**
 * Where an earring hangs, in face-relative terms only.
 *
 * The unit is the wearer's own face width — the distance across the silhouette
 * at the level of the ear canals — so a nudge means the same thing on every head
 * and at every distance from the camera.
 */
export type EarAnchor = {
  /**
   * How far below the ear the lobe sits, in face widths.
   *
   * The face mesh stops at the silhouette: there is no ear vertex and no lobe
   * vertex. Its widest points sit at the *tragion*, the notch in front of the ear
   * canal, and a lobe hangs a couple of centimetres below that — so this is
   * derived, and it is the one number a wearer may genuinely need to adjust,
   * because lobes vary more than faces do.
   */
  dropBelowEar: number;
  /** Slide the piece forward or back along the jaw, in face widths. */
  acrossOffset: number;
  /** Fine trim on the drawn size. */
  sizeMultiplier: number;
};

export const DEFAULT_EAR_ANCHOR: EarAnchor = {
  /**
   * Small, because the anchor is already at lobe height — see EAR_ALONG_CONTOUR.
   * This is the last few millimetres from the contour out to where a piercing
   * actually sits, and it is the number a wearer with long lobes will want.
   */
  dropBelowEar: 0.03,
  acrossOffset: 0,
  sizeMultiplier: 1,
};

export type EarSolverOptions = {
  anchor: EarAnchor;
  smoothing: OneEuroConfig;
};

export const DEFAULT_EAR_SOLVER_OPTIONS: EarSolverOptions = {
  anchor: DEFAULT_EAR_ANCHOR,
  smoothing: DEFAULT_ONE_EURO,
};

export type EarPlacement = {
  /** Where the piece hangs from, on the anchor plane. */
  position: Vector3;
  /** Depth relative to the head's centre, in plane units. */
  depth: number;
  /** Its +Y is up the frame, +Z out of the ear. */
  quaternion: Quaternion;
  /** Millimetres to plane units *for this ear* — the two differ on a turn. */
  scale: number;
  /** False when this ear has swung far enough behind the head to be gone. */
  visible: boolean;
};

export type EarringPose = {
  /** The wearer's left ear. Decided from the face, so mirroring needs no case. */
  left: EarPlacement;
  right: EarPlacement;
  /** Face width across the silhouette, in plane units, undone for the turn. */
  widthUnits: number;
  /** Millimetres to plane units at the ear line. */
  unitsPerMm: number;
  /** How far the head is turned, in radians; positive brings the left ear near. */
  headTurn: number;
  /** How far the head is tipped on screen, in radians. */
  headRoll: number;
  /** The ear anchors and the face's own points, for the diagnostics overlay. */
  leftEar: Vector3;
  rightEar: Vector3;
  chin: Vector3;
  brow: Vector3;
  nose: Vector3;
  centre: Vector3;
  up: Vector3;
  spread: number;
  settled: boolean;
};

export type EarRejection = "no-face";

/**
 * Face width in millimetres, across the silhouette at ear level.
 *
 * A nominal, and deliberately so. This is bizygomatic breadth, which is among
 * the *tightest* dimensions on an adult body — essentially everyone is between
 * 128 and 150 mm — so a fixed figure is more accurate than anything a camera can
 * infer without a known reference in shot. The earlier build measured it from a
 * pose model's metric output and drew a 28 mm earring across people's faces when
 * that output was wrong, which it often was.
 */
export const NOMINAL_FACE_WIDTH_MM = 140;

/**
 * How far the nose stands out of the face's silhouette, in face widths.
 *
 * The head's turn is read from the nose, and this is the gain that converts what
 * it does on screen into an angle. A nose sits on the midline and well forward
 * of the plane the silhouette's widest points lie in, so a turn swings it
 * sideways: its offset from the midpoint of those two points, over the width
 * they span, is the tangent of the turn times this.
 *
 * A *tangent*, and that is why the cue is the nose rather than the face's own
 * squashing. Foreshortening gives a cosine, which is flat near zero — a one
 * percent error in the reference is worth eight degrees of recovered angle
 * exactly where heads spend most of their time. A tangent is linear there, so
 * the estimate is best conditioned in the pose people actually hold.
 *
 * Reading the width against a resting shape was tried first and is worse than it
 * looks: the resting shape has to be learned, it can only be learned from frames
 * where the head is square on, and knowing which frames those are is the problem
 * being solved. Learned from all of them, a head held at a constant angle simply
 * calibrates itself as facing forward and the turn reads zero.
 */
const NOSE_PROJECTION = 0.657;

/** Beyond this the tangent runs away; ~74 degrees, and a profile by then. */
const MAX_TURN_TANGENT = 3.5;

/**
 * How far down the face's own contour the ear is taken to be, between the two
 * points read from it.
 *
 * All the way, which is to say the lower of them — and this is measured from
 * MediaPipe's own canonical face model rather than reasoned about. In that
 * model's units the two contour points sit at heights +0.67 and −1.05, the nose
 * tip at −1.13, and the chin at −9.40. An earlobe is level with the nose, so it
 * is the *lower* point that is at lobe height and the upper one is a centimetre
 * above it, up by the ear canal.
 *
 * Both earlier answers were wrong in the same direction. Anchoring on the widest
 * contour point hung the pieces a centimetre high; splitting the difference hung
 * them half a centimetre high.
 */
const EAR_ALONG_CONTOUR = 1;

/**
 * How far the head must turn before the far ear is treated as gone.
 *
 * Past this the ear is behind the cheek and its earring is only intermittently
 * in view; drawing it then reads as the piece cutting through the face. The
 * depth-only head still does the fine work — this is the coarse gate.
 */
const HIDDEN_BEYOND = 1.15; // ~66 degrees

/** Speed coefficient for the landmark filter, in the signal's own units. */
const PLANAR_BETA = 16;

const SCREEN_UP = new Vector3(0, 1, 0);

/** Only the landmarks that are read, so the filter is not 478 points wide. */
const READ = [
  FM.SIDE_A,
  FM.SIDE_B,
  FM.UNDER_A,
  FM.UNDER_B,
  FM.CHIN,
  FM.BROW,
  FM.NOSE_TIP,
] as const;

const scratch = {
  a: new Vector3(),
  b: new Vector3(),
  across: new Vector3(),
  anchor: new Vector3(),
  down: new Vector3(),
  outward: new Vector3(),
  up: new Vector3(),
  basis: new Matrix4(),
};

/**
 * Turns a frame of face landmarks into a pair of earring placements.
 *
 * **Rebuilt on the face model after the pose model proved to be the wrong
 * tool**, and the distinction is worth keeping written down because the pose
 * model does reach the ears. It reaches them with eleven coarse points inferred
 * as part of a whole-body estimate, and they wander by more than an earring is
 * wide — so the pieces sat near a face rather than on its ears, and no amount of
 * work downstream was going to fix an anchor that was not there. The necklace is
 * right to use that model; a necklace hangs off a shoulder line half a metre
 * across.
 *
 * What this reads instead is a dense face silhouette, and three things fall out
 * of it that the previous build had to estimate and get wrong:
 *
 * - **Where the ear is.** The mesh has no ear vertex, but its silhouette's
 *   widest points sit at the tragion, and they are precise.
 * - **How far the head is turned**, from the face's own width over its height.
 *   Only the width foreshortens on a turn, so the ratio *is* the cosine — and
 *   being a ratio it needs no scale, no distance and no metric model at all.
 * - **How big to draw the piece**, from the face's width against a nominal. Face
 *   breadth is one of the tightest dimensions on a body, so a fixed figure beats
 *   anything a camera can infer without a ruler in shot.
 *
 * The piece still hangs rather than being stuck on: vertical comes first and the
 * ear yields to it, so tipping your head leaves a jhumka pointing at the floor.
 */
export class EarPoseSolver {
  private planarFilter = new OneEuroVector(READ.length * 2);
  private smoothed: number[] = [];
  private planar = READ.map(() => ({ x: 0, y: 0 }));
  private lastTimestamp: number | null = null;
  private lastZoom = 1;
  private rejection: EarRejection | null = null;

  /** The face's width over its height, over a couple of seconds. */
  private aspect = new MedianTracker(60);

  readonly pose: EarringPose = {
    left: {
      position: new Vector3(),
      depth: 0,
      quaternion: new Quaternion(),
      scale: 0,
      visible: true,
    },
    right: {
      position: new Vector3(),
      depth: 0,
      quaternion: new Quaternion(),
      scale: 0,
      visible: true,
    },
    widthUnits: 0,
    unitsPerMm: 0,
    headTurn: 0,
    headRoll: 0,
    leftEar: new Vector3(),
    rightEar: new Vector3(),
    chin: new Vector3(),
    brow: new Vector3(),
    nose: new Vector3(),
    centre: new Vector3(),
    up: new Vector3(0, 1, 0),
    spread: 1,
    settled: false,
  };

  get lastRejection(): EarRejection | null {
    return this.rejection;
  }

  reset(): void {
    this.planarFilter.reset();
    this.aspect.reset();
    this.lastTimestamp = null;
  }

  /**
   * @returns the shared pose object, or null when no usable face was found.
   *          The object is reused between frames — read it, don't retain it.
   */
  solve(
    result: FaceLandmarkerResult,
    geometry: FrameGeometry,
    options: EarSolverOptions,
    timestampMs: number,
  ): EarringPose | null {
    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks || landmarks.length < FACE_LANDMARK_COUNT) {
      this.rejection = "no-face";
      this.lastTimestamp = null;
      return null;
    }
    this.rejection = null;

    const dt =
      this.lastTimestamp === null ? 1 / 60 : (timestampMs - this.lastTimestamp) / 1000;
    this.lastTimestamp = timestampMs;
    if (dt > 0.5) this.planarFilter.reset();

    const zoom = geometry.zoom > 0 ? geometry.zoom : 1;
    if (zoom !== this.lastZoom) {
      const factor = zoom / this.lastZoom;
      this.planarFilter.rescale(factor);
      for (let i = 0; i < this.smoothed.length; i++) this.smoothed[i] *= factor;
      this.lastZoom = zoom;
    }

    const raw: number[] = [];
    const point = { x: 0, y: 0 };
    for (let i = 0; i < READ.length; i++) {
      const lm = landmarks[READ[i]];
      projectToAnchorPlane(lm.x, lm.y, geometry, point);
      raw[i * 2] = point.x;
      raw[i * 2 + 1] = point.y;
    }

    this.planarFilter.setConfig({ ...options.smoothing, beta: PLANAR_BETA });
    this.smoothed = this.planarFilter.filter(raw, dt, this.smoothed);
    for (let i = 0; i < READ.length; i++) {
      this.planar[i].x = this.smoothed[i * 2];
      this.planar[i].y = this.smoothed[i * 2 + 1];
    }

    return this.compose(options);
  }

  private at(landmark: number, out: Vector3): Vector3 {
    const i = READ.indexOf(landmark as (typeof READ)[number]);
    return out.set(this.planar[i].x, this.planar[i].y, 0);
  }

  private compose(options: EarSolverOptions): EarringPose {
    const { anchor } = options;
    const { pose } = this;

    this.at(FM.SIDE_A, scratch.a);
    this.at(FM.SIDE_B, scratch.b);
    this.at(FM.CHIN, pose.chin);
    this.at(FM.BROW, pose.brow);
    this.at(FM.NOSE_TIP, pose.nose);

    pose.centre.addVectors(scratch.a, scratch.b).multiplyScalar(0.5);
    scratch.across.subVectors(scratch.b, scratch.a).setZ(0);
    const widthSeen = scratch.across.length();
    if (widthSeen < 1e-9) scratch.across.set(1, 0, 0);
    scratch.across.normalize();

    // The face's own vertical, from brow to chin. Taken from its own pair rather
    // than as a perpendicular to the ear line, so a head that tips keeps its
    // lobes: the two spans tip together and neither has to stand in for the
    // other.
    scratch.down.subVectors(pose.chin, pose.brow).setZ(0);
    const heightSeen = scratch.down.length();
    if (heightSeen < 1e-9) scratch.down.set(0, -1, 0);
    scratch.down.normalize();
    pose.up.copy(scratch.down).negate();
    pose.headRoll = Math.atan2(-scratch.down.x, -scratch.down.y);

    // --- How far the head is turned ------------------------------------------
    //
    // From the nose, which sits on the midline and forward of the silhouette, so
    // a turn swings it off centre. Both quantities are lengths on screen and the
    // answer is their ratio, so this needs no scale, no distance, no depth and
    // no metric model — and it comes out signed, so there is no direction to
    // resolve separately and nothing to latch.
    scratch.a.subVectors(pose.nose, pose.centre);
    const noseOffset = widthSeen > 1e-9 ? scratch.a.dot(scratch.across) / widthSeen : 0;
    // Negated, because a nose leans *away* from the ear that comes forward:
    // turn your head so your left ear faces the camera and your nose goes to
    // your right. Reading the offset as the turn's direction rather than its
    // opposite puts both earrings on the wrong sides of the head.
    //
    // The gain also has to allow for the nose being nearer the lens than the
    // silhouette it is measured against, which magnifies its offset — by a tenth
    // at arm's length and more as the wearer leans in, so it is computed rather
    // than folded into the constant.
    const towardLens =
      widthSeen > 1e-9
        ? (NOSE_PROJECTION * NOMINAL_FACE_WIDTH_MM) /
          1000 /
          ((ANCHOR_DISTANCE * this.lastZoom * NOMINAL_FACE_WIDTH_MM) / 1000 / widthSeen)
        : 0;
    const gain = NOSE_PROJECTION / (1 - Math.min(0.4, Math.max(0, towardLens)));
    const tanTurn = Math.min(
      MAX_TURN_TANGENT,
      Math.max(-MAX_TURN_TANGENT, -noseOffset / gain),
    );
    const cosTurn = 1 / Math.sqrt(1 + tanTurn * tanTurn);
    const sinTurn = tanTurn * cosTurn;
    pose.headTurn = Math.atan2(sinTurn, cosTurn);

    // Tracked only to report how steadily the face is being read; the shape
    // itself is not used for anything, for the reason on NOSE_PROJECTION.
    if (heightSeen > 1e-6 && widthSeen > 0) this.aspect.push(widthSeen / heightSeen);
    pose.spread = this.aspect.spread ?? 1;
    pose.settled = this.aspect.settled;

    // --- Size ----------------------------------------------------------------
    pose.widthUnits = widthSeen / cosTurn;
    pose.unitsPerMm = pose.widthUnits / NOMINAL_FACE_WIDTH_MM;

    // --- Each lobe -----------------------------------------------------------
    //
    // Which silhouette point is the wearer's left is decided here rather than
    // assumed, from the nose: it leans toward whichever ear has come forward.
    // So a mirrored preview needs no special case, and neither does a rear
    // camera.
    const halfDepth = (pose.widthUnits / 2) * sinTurn;

    for (const side of ["left", "right"] as const) {
      const place = pose[side];
      // `across` runs from SIDE_A to SIDE_B. The wearer's left ear is the one
      // the nose leans *away* from when it comes forward, which is the +across
      // end when sinTurn is positive.
      const isB = side === "left";
      const ear = isB ? scratch.b : scratch.a;

      // The anchor is the midpoint of two contour points, not the widest one.
      //
      // The silhouette's widest point sits at the temple — above the ear canal
      // and forward of it — so hanging from it alone puts a jhumka high on the
      // cheek and asks the drop slider to make up two centimetres it should not
      // have to. The next point down the contour sits about at ear level. Their
      // midpoint is much nearer the tragion than either, and splitting them also
      // halves the error if the mesh's idea of either one is off.
      this.at(isB ? FM.SIDE_B : FM.SIDE_A, ear);
      this.at(isB ? FM.UNDER_B : FM.UNDER_A, scratch.anchor);
      ear.lerp(scratch.anchor, EAR_ALONG_CONTOUR);
      (isB ? pose.leftEar : pose.rightEar).copy(ear);

      place.position
        .copy(ear)
        .addScaledVector(scratch.down, pose.widthUnits * anchor.dropBelowEar)
        .addScaledVector(
          scratch.across,
          pose.widthUnits * anchor.acrossOffset * (isB ? 1 : -1),
        );
      place.depth = isB ? halfDepth : -halfDepth;

      const reach = ANCHOR_DISTANCE * this.lastZoom;
      const toward = Math.min(0.5, Math.max(-0.5, place.depth / reach));
      place.scale = (pose.unitsPerMm * anchor.sizeMultiplier) / (1 - toward);

      // It hangs, so vertical comes first and the ear yields to it. Build the
      // frame the other way round and the two constraints fight: outward tips
      // with the ear line, up must stay square to outward, so up tips too and
      // the earring rolls with the head — which is exactly what a hook prevents.
      scratch.outward
        .set(scratch.across.x, scratch.across.y, 0)
        .multiplyScalar(isB ? 1 : -1);
      scratch.outward.z = isB ? -sinTurn : sinTurn;
      scratch.up.copy(SCREEN_UP);
      scratch.outward.addScaledVector(scratch.up, -scratch.outward.dot(scratch.up));
      if (scratch.outward.lengthSq() < 1e-9) scratch.outward.set(0, 0, 1);
      scratch.outward.normalize();
      scratch.a.crossVectors(scratch.up, scratch.outward).normalize();
      scratch.basis.makeBasis(scratch.a, scratch.up, scratch.outward);
      place.quaternion.setFromRotationMatrix(scratch.basis);

      // The far ear goes behind the cheek. The head's depth-only stand-in does
      // the fine work; this is the coarse gate for when it is simply gone.
      const away = isB ? -pose.headTurn : pose.headTurn;
      place.visible = away < HIDDEN_BEYOND;
    }

    return pose;
  }
}
