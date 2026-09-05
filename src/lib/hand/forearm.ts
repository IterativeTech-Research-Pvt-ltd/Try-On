import type { PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import { PL } from "@/lib/neck/landmarks";
import { projectToAnchorPlane, type FrameGeometry } from "./projection";

/**
 * Which way the forearm runs, read from the pose model.
 *
 * The bracelet solver's own guess at this is the palm's direction, continued
 * past the wrist — which is right whenever the hand is in line with the arm, and
 * wrong by exactly the angle of the wrist when it is not. A hand held at a right
 * angle put the band a full band-radius-and-a-third off the arm: not tilted, but
 * beside it.
 *
 * That is not a tuning problem. The hand model has twenty-one landmarks and the
 * last one is the wrist, so there is nothing below it to measure a forearm
 * between, and no amount of work on those points can recover a direction they do
 * not contain. The pose model does have an elbow, so it is the only place the
 * answer can come from.
 *
 * It is a *hint* rather than the truth because the elbow is often the weakest
 * landmark in the frame — the pose model is asked here for the one joint its
 * "lite" weights are worst at, on a body that is mostly out of shot. So it
 * arrives with a confidence, and the solver turns toward it by that much rather
 * than trusting it outright.
 */
export type ForearmHint = {
  /** Unit direction down the arm, away from the hand, on the anchor plane. */
  x: number;
  y: number;
  /** 0 when unusable, 1 when the elbow is plainly visible and plainly this arm's. */
  confidence: number;
};

/** Visibility below which a joint is not worth reading. */
const MIN_VISIBILITY = 0.5;

/**
 * How far the pose model's idea of the wrist may sit from the hand model's,
 * as a fraction of the forearm's own on-screen length, before the two are taken
 * to be describing different arms.
 *
 * Both models are looking at the same picture, so their wrists should very
 * nearly coincide. When they do not, the usual reason is that the nearer arm in
 * the pose is the *other* one — and taking that one would point the bracelet
 * across the frame at somebody else's elbow.
 */
const MAX_WRIST_GAP = 0.45;

/** Shortest forearm worth taking a direction from, in anchor-plane units. */
const MIN_FOREARM_UNITS = 0.04;

/**
 * How quickly the smoothed direction follows a new reading, per update.
 *
 * A forearm swings slowly and the elbow is noisy, which is the easy case: heavy
 * smoothing costs nothing anyone can see and removes essentially all of it.
 */
const FOLLOW = 0.18;

type Joint = { x: number; y: number; visibility?: number };

export class ForearmTracker {
  private readonly current: ForearmHint = { x: 0, y: -1, confidence: 0 };
  private settled = false;
  private readonly point = { x: 0, y: 0 };
  private readonly elbow = { x: 0, y: 0 };
  private readonly wrist = { x: 0, y: 0 };

  /**
   * The latest hint, whether or not the pose model ran this frame.
   *
   * The solver runs every frame and the pose model does not, so the two are
   * deliberately decoupled: the band follows the hand at full rate and merely
   * carries the most recent forearm correction with it.
   */
  get hint(): ForearmHint {
    return this.current;
  }

  /** Forget the arm, so a re-acquired hand does not inherit the old one. */
  reset(): void {
    this.current.x = 0;
    this.current.y = -1;
    this.current.confidence = 0;
    this.settled = false;
  }

  /**
   * @param handWrist where the *hand* model puts the wrist, in plane units. Used
   *                  to decide which of the two arms in the pose is this one.
   * @returns the shared hint object — read it, don't retain it.
   */
  update(
    result: PoseLandmarkerResult | null,
    geometry: FrameGeometry,
    handWrist: { x: number; y: number },
  ): ForearmHint {
    const landmarks = result?.landmarks?.[0] as Joint[] | undefined;
    if (!landmarks || landmarks.length <= PL.RIGHT_WRIST) return this.decay();

    let best: { x: number; y: number; confidence: number } | null = null;

    for (const [elbowIndex, wristIndex] of [
      [PL.LEFT_ELBOW, PL.LEFT_WRIST],
      [PL.RIGHT_ELBOW, PL.RIGHT_WRIST],
    ]) {
      const e = landmarks[elbowIndex];
      const w = landmarks[wristIndex];
      if (!e || !w) continue;
      const seen = Math.min(e.visibility ?? 1, w.visibility ?? 1);
      if (seen < MIN_VISIBILITY) continue;

      projectToAnchorPlane(e.x, e.y, geometry, this.point);
      this.elbow.x = this.point.x;
      this.elbow.y = this.point.y;
      projectToAnchorPlane(w.x, w.y, geometry, this.point);
      this.wrist.x = this.point.x;
      this.wrist.y = this.point.y;

      // Down the arm, away from the hand — the same sense the solver's own
      // palm-derived axis runs in.
      const dx = this.elbow.x - this.wrist.x;
      const dy = this.elbow.y - this.wrist.y;
      const length = Math.hypot(dx, dy);
      if (length < MIN_FOREARM_UNITS) continue;

      const gap = Math.hypot(this.wrist.x - handWrist.x, this.wrist.y - handWrist.y);
      if (gap > length * MAX_WRIST_GAP) continue;

      // Confident when the joint is plainly visible and the two models agree
      // closely about where the wrist is; tapering off as either gives way.
      const agreement = 1 - gap / (length * MAX_WRIST_GAP);
      const confidence = Math.min(1, Math.max(0, seen * agreement));
      if (!best || confidence > best.confidence) {
        best = { x: dx / length, y: dy / length, confidence };
      }
    }

    if (!best) return this.decay();

    if (!this.settled) {
      this.current.x = best.x;
      this.current.y = best.y;
      this.settled = true;
    } else {
      this.current.x += (best.x - this.current.x) * FOLLOW;
      this.current.y += (best.y - this.current.y) * FOLLOW;
      const length = Math.hypot(this.current.x, this.current.y);
      if (length > 1e-6) {
        this.current.x /= length;
        this.current.y /= length;
      }
    }
    this.current.confidence += (best.confidence - this.current.confidence) * FOLLOW;
    return this.current;
  }

  /**
   * Let the hint fade rather than dropping it.
   *
   * The pose model loses an arm for a frame or two all the time — a hand crosses
   * it, or the elbow leaves the picture. Cutting the hint dead would swing the
   * band back onto the palm's axis and then back off it, which is worse than
   * carrying the last good answer for a moment while it gives out gently.
   */
  private decay(): ForearmHint {
    this.current.confidence *= 1 - FOLLOW;
    if (this.current.confidence < 0.02) this.current.confidence = 0;
    return this.current;
  }
}
