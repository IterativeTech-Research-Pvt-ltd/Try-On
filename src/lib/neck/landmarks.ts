/**
 * MediaPipe pose landmark indices, for the handful a necklace needs.
 *
 * The pose model returns 33 points over the whole body; a necklace only cares
 * about the shoulder girdle and which way the head is turned. Everything below
 * the hips is irrelevant and is never read.
 *
 *        0 nose
 *    7 ear      ear 8
 *      9 mouth 10
 *  11 shoulder    shoulder 12
 *
 * Note the left/right naming is anatomical — landmark 11 is the *subject's* left
 * shoulder, which appears on the right of an unmirrored image.
 */
export const PL = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_MOUTH: 9,
  RIGHT_MOUTH: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  // Read by the bracelet, not the necklace. The hand model stops at the wrist,
  // so a forearm's direction can only come from a model that has an elbow.
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
} as const;

/** The pose model always returns this many points. */
export const POSE_LANDMARK_COUNT = 33;

/**
 * The landmarks the necklace solver reads. Anything not in here is ignored, and
 * a frame is rejected unless all of these are present and confident.
 */
export const REQUIRED_LANDMARKS = [PL.LEFT_SHOULDER, PL.RIGHT_SHOULDER];

/**
 * Only the shoulders, and that is the point.
 *
 * This list used to include the nose, both ears and both mouth corners, and any one
 * of them dropping below the visibility threshold made the solver return nothing —
 * so the necklace **vanished** rather than being mispositioned. Turning your head far
 * enough to hide an ear was enough to do it, which is precisely when someone wants
 * to see how a necklace looks from the side.
 *
 * A necklace hangs off the shoulder girdle. The head landmarks now feed only optional
 * refinements — the second width cue and the neck-length measurement — both of which
 * are separately gated and both of which have fallbacks. Requiring them was
 * demanding evidence the solve does not actually need.
 */

/**
 * Adult biacromial (shoulder-to-shoulder) breadth, in millimetres.
 *
 * Only a fallback. The pose model's world landmarks are metric, so the real
 * shoulder width is measured per person; this is the figure used when those are
 * unavailable, and as a sanity bound on the measurement.
 */
export const NOMINAL_SHOULDER_WIDTH_MM = 395;
export const MIN_SHOULDER_WIDTH_MM = 280;
export const MAX_SHOULDER_WIDTH_MM = 520;
