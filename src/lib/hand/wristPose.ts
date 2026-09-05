import { Matrix4, Quaternion, Vector3 } from "three";
import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { LM } from "./landmarks";
import { DEFAULT_ONE_EURO, OneEuroVector, type OneEuroConfig } from "./oneEuro";
import { ANCHOR_DISTANCE, projectToAnchorPlane, type FrameGeometry } from "./projection";
import { MedianTracker, type Point3 } from "./measure";
import type { ForearmHint } from "./forearm";
import { estimatePlaneScale } from "./scale";
import {
  DEFAULT_DIAMETER_MM,
  WEAR_CLEARANCE,
  WRIST_BREADTH_RATIO,
  diameterMmForSemiMajor,
  semiMajorForDiameterMm,
  wristCircumferenceMm,
} from "@/lib/jewellery/wristFit";

/**
 * Where the bracelet sits, in wrist-relative terms only.
 *
 * Never screen coordinates and never pixels — the same rule the ring's anchor
 * follows, and for the same reason: an offset dialled in against one camera,
 * distance and crop is wrong for every other one. Here the unit is the band's
 * own radius, so a nudge means the same thing on every wrist.
 */
export type WristAnchor = {
  /** How far up the forearm from the wrist landmark the band sits, in band radii. */
  seatAlongForearm: number;
  /** Slide the band across the forearm, in band radii. */
  crossOffset: number;
  /** Fine trim on the fitted size. */
  sizeMultiplier: number;
  /**
   * Tip of the band away from square-on, in radians.
   *
   * A band drawn exactly perpendicular to the screen shows no opening at all —
   * its near and far rims project onto each other and it reads as a flat hoop
   * painted on the arm. A few degrees of drape is what gives it a visible
   * section, and a worn bracelet does hang slightly tipped anyway.
   */
  tilt: number;
};

export const DEFAULT_WRIST_ANCHOR: WristAnchor = {
  /**
   * Just under one band radius past the wrist landmark, which is about 30 mm on
   * an adult — where a clasped bracelet settles once it has slid down against
   * the base of the hand.
   */
  seatAlongForearm: 0.95,
  crossOffset: 0,
  sizeMultiplier: 1,
  tilt: 0.14,
};

export type WristSolverOptions = {
  anchor: WristAnchor;
  /** Draw at the measured wrist rather than at a chosen size. */
  autoFit: boolean;
  /** Inner fitting diameter to draw at when auto-fit is off, in millimetres. */
  diameterMm: number;
  /** See the ring solver: how much larger MediaPipe thinks this hand is. */
  metricBias: number;
  /**
   * Which way the forearm actually runs, from a model that can see an elbow, or
   * null when none is available.
   *
   * Without it the forearm's direction is the palm's, continued past the wrist —
   * which is exactly right until someone bends their wrist, and then wrong by
   * the angle they bent it. See ForearmHint.
   */
  forearm?: ForearmHint | null;
  smoothing: OneEuroConfig;
};

export const DEFAULT_WRIST_SOLVER_OPTIONS: WristSolverOptions = {
  anchor: DEFAULT_WRIST_ANCHOR,
  autoFit: true,
  diameterMm: DEFAULT_DIAMETER_MM,
  metricBias: 1,
  smoothing: DEFAULT_ONE_EURO,
};

export type WristPose = {
  /** Centre of the band, on the anchor plane. */
  position: Vector3;
  /** Band axis along the forearm; local +Y points at the lens. */
  quaternion: Quaternion;
  /** Inner semi-major axis the band is drawn at, in anchor-plane units. */
  radius: number;
  /**
   * Inner semi-major axis in millimetres, for laying the stones.
   *
   * Only ever the *physical* size, never the drawn one: the renderer divides
   * `radius` by this to get its scale, so an error here cancels out of what
   * appears on screen and only changes how many stones a row is given.
   */
  semiMajorMm: number;
  /** Anchor-plane units per metre, or 0 before the metric fit settles. */
  planeScale: number;
  /** Millimetres to anchor-plane units, with the metric bias removed. */
  unitsPerTrueMm: number;
  /** Measured breadth of the wrist, in true millimetres. */
  breadthMm: number;
  /** What a tape would read round it. */
  circumferenceMm: number;
  /** Inner fitting diameter of the band being drawn. */
  fittingDiameterMm: number;
  /** Interquartile spread of the width samples, as a fraction of the median. */
  spread: number;
  settled: boolean;
  /**
   * How far the forearm leans out of the picture plane, in radians, positive
   * toward the lens. Recovered from foreshortening, not from landmark depth.
   */
  forearmTilt: number;
  /** How far the wrist is rolled about the forearm, in radians. Same source. */
  wristRoll: number;
};

const LANDMARK_COUNT = 21;

/**
 * The landmarks the local scale is fit over: the wrist and the four knuckles.
 *
 * The palm quad and nothing else. Both spans the leans are measured from live on
 * it, and it stays nearly flat however the fingers are held — which is what
 * makes one distance describe all of it.
 */
const PALM_POINTS = [
  LM.WRIST,
  LM.INDEX_MCP,
  LM.MIDDLE_MCP,
  LM.RING_MCP,
  LM.PINKY_MCP,
];

/**
 * Speed coefficient for the landmark filter, replacing the shared default's.
 *
 * The same units problem as the scale filters, in the place it is most visible.
 * `DEFAULT_ONE_EURO.beta` is 0.035, and a landmark travelling briskly covers
 * about one plane unit a second — so it lifts a 1.7 Hz cutoff to 1.735 Hz, which
 * is to say the adaptive half of the filter never ran and the band trailed the
 * hand by a fixed lag on every movement. On a ring that lag is a millimetre; on
 * a bracelet, three times the size, it is the piece visibly swimming behind the
 * arm.
 *
 * Set here rather than in the shared default because the ring and the necklace
 * have their own histories with those numbers, and because the studio's
 * Smoothing slider drives `minCutoff` — which still does exactly what it says.
 *
 * Sixteen rather than the sixty-odd the measurements would happily take: past
 * this the gain is small and the risk is not. Real landmark noise is coloured and
 * occasionally spiky where the harness's is white, and a high coefficient chases
 * exactly that — so the number stops where the evidence stops being about the
 * kind of noise the model actually produces.
 */
const PLANAR_BETA = 16;

/** Scratch — the solver runs every frame and must not allocate. */
const scratch = {
  planar: Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0, y: 0 })),
  world: Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0, y: 0, z: 0 })),
  point: { x: 0, y: 0 },
  wrist: new Vector3(),
  knuckles: new Vector3(),
  a: new Vector3(),
  b: new Vector3(),
  /** The forearm and the wrist's wide axis, as they lie in the picture plane. */
  along2D: new Vector3(),
  across2D: new Vector3(),
  /** The same two, lifted out of the plane by the recovered angles. */
  axis: new Vector3(),
  lateral: new Vector3(),
  up: new Vector3(),
  basis: new Matrix4(),
  drape: new Quaternion(),
};

/**
 * How much of its own length a span's depth component has to reach before its
 * *sign* is believed.
 *
 * Only the sign is ever taken from landmark depth, and only when the span is
 * clearly out of plane. Near square-on the sign is both unknowable and
 * irrelevant — the angle it applies to is near zero — so below this the previous
 * answer stands rather than flickering between two equally good ones.
 */
const CONFIDENT_DEPTH = 0.15;

/**
 * Floor on the foreshortening factors.
 *
 * A span seen almost end-on measures a few pixels, so the ratio that recovers
 * its angle is all noise there. Clamping stops the basis degenerating and caps
 * how far the piece can be tipped by a bad frame.
 */
const MIN_FORESHORTEN = 0.22;

/**
 * Where along the forearm the palm's scale fit actually applies, in palm
 * lengths from the wrist. Chosen for the worst case rather than the average —
 * see the note on the value below.
 *
 * The fit runs over the wrist and the four knuckles, so the distance it reports
 * is the average of one point at the wrist and four a palm's length up — four
 * fifths of the way to the knuckles. That is nowhere near the wrist, and once
 * the arm leans the two are at genuinely different distances from the lens.
 */
const PALM_SCALE_CENTROID = 0.7;

/**
 * Hard limit on that correction, as a fraction of the distance to the hand.
 *
 * It is the one place left that divides, so it is the one place that has to be
 * fenced. In practice a lean of sixty degrees on an arm held at arm's length
 * reaches about a sixth of this.
 */
const MAX_DEPTH_SHIFT = 0.4;

/**
 * The scale filters' cutoff at rest, in Hz. Low, because a band that breathes on
 * a still hand is far worse than one that takes a beat to catch up.
 */
const SCALE_MIN_CUTOFF = 0.35;

/**
 * How much the scale filters open up with speed — **as a fraction of the scale's
 * own value**, which is the whole point of the number.
 *
 * A One Euro filter's `beta` multiplies a derivative, so it carries the signal's
 * units. Landmark coordinates run to about a tenth of a frame height; a scale in
 * plane units per metre runs to about three. Handing the same beta to both, as
 * this did, tunes it for the landmarks and leaves it thirty times too small for
 * the scale — so the adaptive half of the filter never engaged and what remained
 * was a fixed 0.35 Hz low-pass, a second of lag on any real movement.
 *
 * Multiplying by the current scale makes it dimensionless: a hand moving fast
 * enough to change its apparent size by half a second's worth opens the cutoff by
 * the same amount whether it is near the camera or far from it.
 */
const SCALE_BETA = 0.6;

/** Local +X of the band: the axis the drape tips it about. */
const BAND_LATERAL = new Vector3(1, 0, 0);

/** Fallback forearm direction when the palm is too foreshortened to give one. */
const DOWN_THE_FRAME = new Vector3(0, -1, 0);

/** Points a scale filter's speed coefficient at the scale it is smoothing. */
function tune(filter: OneEuroVector, current: number | undefined): void {
  filter.setConfig({
    minCutoff: SCALE_MIN_CUTOFF,
    beta: SCALE_BETA * (current && current > 0 ? current : 1),
    dCutoff: 1,
  });
}

/**
 * Turns a frame of hand landmarks into a bracelet pose.
 *
 * **No landmark's depth ever reaches the pose.** That is the important decision
 * in this file, and it is what separates it from the ring solver, which reads
 * the metric landmarks' 3D structure directly and pays for their noise. Doing
 * the same here produced a band that tipped and swam against an arm which had
 * not moved: a bracelet is three times a ring's size, so the same few degrees of
 * jitter travel three times as far across the screen.
 *
 * Building the frame flat instead — everything in the picture plane, depth
 * discarded — fixed the swimming and cost the two things a flat frame cannot
 * express: an arm pointing toward the lens, and a rolled wrist.
 *
 * So the frame is built in the picture plane and then *lifted out of it* by two
 * angles, each recovered from foreshortening rather than from depth:
 *
 * - **Forearm tilt.** The palm's true length is a fixed anatomical span, and
 *   `planeScale` converts it into the length it would project to if it lay
 *   square to the lens. What it actually measures on screen, over that, is the
 *   cosine of its lean.
 * - **Wrist roll.** The same trick on the span between the knuckles. The two
 *   cues separate cleanly, because each rotation leaves the other's span alone:
 *   the knuckle line is the axis the arm pitches about, and the palm's length is
 *   the axis the wrist rolls about.
 *
 * Both inputs are robust in a way raw depth is not. `planeScale` is a
 * least-squares fit over all 21 points and is rotation-invariant by
 * construction; the two anatomical lengths are 3D distances, so they do not
 * foreshorten at all, and a long-run median of a constant is about as steady as
 * a measurement gets. Depth is consulted for exactly two bits — which way each
 * angle leans — and even those are latched until the evidence is unambiguous.
 *
 * One more thing falls out: because the projection has already applied the
 * preview's mirror, a mirrored frame needs no special case at all.
 */
export class WristPoseSolver {
  private planarFilter = new OneEuroVector(LANDMARK_COUNT * 2);
  private worldFilter = new OneEuroVector(LANDMARK_COUNT * 3);
  private scaleFilter = new OneEuroVector(1, { minCutoff: 0.35, beta: 0.004, dCutoff: 1 });
  private palmScaleFilter = new OneEuroVector(1, { minCutoff: 0.35, beta: 0.004, dCutoff: 1 });
  private planarSmoothed: number[] = [];
  private worldSmoothed: number[] = [];
  private scaleSmoothed: number[] = [];
  private palmScaleSmoothed: number[] = [];
  private lastTimestamp: number | null = null;

  /** See the ring solver: a zoom change is a change of units, not of pose. */
  private lastZoom = 1;

  /**
   * Breadth samples over a couple of seconds.
   *
   * The median rather than the frame's own estimate, because a band that
   * followed the per-frame number would breathe in and out by a millimetre as
   * the model re-fits the hand — far more noticeable on a bracelet than on a
   * ring, since the piece is three times the size.
   */
  private breadth = new MedianTracker(60);

  /**
   * The wearer's palm length and knuckle span in metres — true 3D distances,
   * so they do not foreshorten and a long median of them is very nearly a
   * constant. They are the yardsticks both lean angles are measured against.
   */
  private palmLength = new MedianTracker(90);
  private knuckleSpan = new MedianTracker(90);

  /** Whether this frame carried metric landmarks at all. */
  private hasWorld = false;

  /**
   * The palm's length and the knuckle span as they measure on screen *before*
   * smoothing.
   *
   * Both lean angles are a ratio of one of these to what the scale fit says it
   * would measure square-on — and that fit is taken from the raw landmarks too.
   * Taking the two sides of a ratio from different places is what matters here:
   * a smoothed numerator over a live denominator dips every time the hand moves,
   * and a dip in that ratio is indistinguishable from a lean. The band would
   * tip, and drag its seat sideways, purely because the hand was travelling.
   *
   * Sharing the raw landmarks also cancels most of the per-frame noise, since
   * both sides are extents over the same jittering points.
   */
  private rawPalmUnits = 0;
  private rawSpanUnits = 0;

  readonly pose: WristPose = {
    position: new Vector3(),
    quaternion: new Quaternion(),
    radius: 0,
    semiMajorMm: semiMajorForDiameterMm(DEFAULT_DIAMETER_MM),
    planeScale: 0,
    unitsPerTrueMm: 0,
    breadthMm: 0,
    circumferenceMm: 0,
    fittingDiameterMm: 0,
    spread: 1,
    settled: false,
    forearmTilt: 0,
    wristRoll: 0,
  };

  reset(): void {
    this.planarFilter.reset();
    this.worldFilter.reset();
    this.scaleFilter.reset();
    this.palmScaleFilter.reset();
    this.breadth.reset();
    this.palmLength.reset();
    this.knuckleSpan.reset();
    this.lastTimestamp = null;
  }

  /**
   * @returns the shared pose object, or null when no usable hand was found.
   *          The object is reused between frames — read it, don't retain it.
   */
  solve(
    result: HandLandmarkerResult,
    geometry: FrameGeometry,
    options: WristSolverOptions,
    timestampMs: number,
  ): WristPose | null {
    const landmarks = result.landmarks?.[0];
    if (!landmarks || landmarks.length < LANDMARK_COUNT) {
      this.lastTimestamp = null;
      return null;
    }

    const dt =
      this.lastTimestamp === null ? 1 / 60 : (timestampMs - this.lastTimestamp) / 1000;
    this.lastTimestamp = timestampMs;

    // A long gap means tracking dropped and re-acquired; stale filter state would
    // drag the bracelet across the screen from wherever the arm used to be.
    if (dt > 0.5) {
      this.planarFilter.reset();
      this.worldFilter.reset();
      this.scaleFilter.reset();
    }

    const zoom = geometry.zoom > 0 ? geometry.zoom : 1;
    if (zoom !== this.lastZoom) {
      const factor = zoom / this.lastZoom;
      this.planarFilter.rescale(factor);
      this.scaleFilter.rescale(factor);
      this.palmScaleFilter.rescale(factor);
      for (let i = 0; i < this.planarSmoothed.length; i++) this.planarSmoothed[i] *= factor;
      for (let i = 0; i < this.scaleSmoothed.length; i++) this.scaleSmoothed[i] *= factor;
      for (let i = 0; i < this.palmScaleSmoothed.length; i++) {
        this.palmScaleSmoothed[i] *= factor;
      }
      this.lastZoom = zoom;
    }

    this.project(landmarks, geometry);
    this.smooth(dt, result.worldLandmarks?.[0], options);

    return this.compose(options);
  }

  private project(
    landmarks: ReadonlyArray<{ x: number; y: number }>,
    geometry: FrameGeometry,
  ): void {
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      const lm = landmarks[i];
      projectToAnchorPlane(lm.x, lm.y, geometry, scratch.point);
      scratch.planar[i].x = scratch.point.x;
      scratch.planar[i].y = scratch.point.y;
    }
  }

  private smooth(
    dt: number,
    world: ReadonlyArray<Point3> | undefined,
    options: WristSolverOptions,
  ): void {
    this.planarFilter.setConfig({ ...options.smoothing, beta: PLANAR_BETA });
    this.worldFilter.setConfig({ ...options.smoothing, beta: PLANAR_BETA });

    const planarRaw: number[] = [];
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      planarRaw[i * 2] = scratch.planar[i].x;
      planarRaw[i * 2 + 1] = scratch.planar[i].y;
    }
    // Measured off the raw landmarks, to be read against the raw fit below.
    this.rawPalmUnits = Math.hypot(
      scratch.planar[LM.WRIST].x - scratch.planar[LM.MIDDLE_MCP].x,
      scratch.planar[LM.WRIST].y - scratch.planar[LM.MIDDLE_MCP].y,
    );
    this.rawSpanUnits = Math.hypot(
      scratch.planar[LM.INDEX_MCP].x - scratch.planar[LM.PINKY_MCP].x,
      scratch.planar[LM.INDEX_MCP].y - scratch.planar[LM.PINKY_MCP].y,
    );

    // Fit the scales from the *raw* landmarks, before they are smoothed.
    //
    // A least-squares fit over five or twenty-one points already averages away
    // most of the per-landmark jitter, and the result then gets a filter of its
    // own — so running it on smoothed input smooths the same quantity twice and
    // pays the lag twice. Which is most of what was left of the size lagging
    // behind a moving hand, once the speed coefficient was fixed.
    if (world && world.length >= LANDMARK_COUNT) {
      const raw = estimatePlaneScale(scratch.planar, world);
      if (raw !== null) {
        tune(this.scaleFilter, this.scaleSmoothed[0]);
        this.scaleSmoothed = this.scaleFilter.filter([raw], dt, this.scaleSmoothed);
      }
      // The same fit over the palm alone, which is the yardstick both leans are
      // measured against. Fitting the whole hand there read a lean partly as a
      // roll: the fingers reach far enough out of the palm's plane that once the
      // arm tips, the average distance the fit reports is no longer the distance
      // to the knuckles the spans actually live on.
      const local = estimatePlaneScale(scratch.planar, world, PALM_POINTS);
      if (local !== null) {
        tune(this.palmScaleFilter, this.palmScaleSmoothed[0]);
        this.palmScaleSmoothed = this.palmScaleFilter.filter(
          [local],
          dt,
          this.palmScaleSmoothed,
        );
      }
    }

    this.planarSmoothed = this.planarFilter.filter(planarRaw, dt, this.planarSmoothed);
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      scratch.planar[i].x = this.planarSmoothed[i * 2];
      scratch.planar[i].y = this.planarSmoothed[i * 2 + 1];
    }

    // The metric landmarks are optional here, because nothing that places the
    // band depends on them. Without them the piece is still drawn, sized off the
    // hand's own span on screen; only the millimetre readout waits.
    this.hasWorld = !!world && world.length >= LANDMARK_COUNT;
    if (!world || world.length < LANDMARK_COUNT) return;

    const worldRaw: number[] = [];
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      // MediaPipe world space is image-aligned: +x right, +y down, +z away from
      // the viewer. three.js is y-up and looks down -z, so two axes invert.
      const lm = world[i];
      worldRaw[i * 3] = lm.x;
      worldRaw[i * 3 + 1] = -lm.y;
      worldRaw[i * 3 + 2] = -lm.z;
    }
    this.worldSmoothed = this.worldFilter.filter(worldRaw, dt, this.worldSmoothed);
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      scratch.world[i].x = this.worldSmoothed[i * 3];
      scratch.world[i].y = this.worldSmoothed[i * 3 + 1];
      scratch.world[i].z = this.worldSmoothed[i * 3 + 2];
    }

  }

  private planarAt(index: number, out: Vector3): Vector3 {
    return out.set(scratch.planar[index].x, scratch.planar[index].y, 0);
  }

  private worldAt(index: number, out: Vector3): Vector3 {
    const w = scratch.world[index];
    return out.set(w.x, w.y, w.z);
  }

  /**
   * The cosine of how far a span leans out of the picture plane.
   *
   * `trueMetres` is the span's real 3D length, which does not foreshorten;
   * multiplying by `planeScale` gives what it would measure on screen lying
   * square to the lens. The ratio of what it actually measures to that is the
   * cosine directly.
   */
  private foreshortening(
    projectedUnits: number,
    trueMetres: number | null,
    planeScale: number,
  ): number {
    if (!trueMetres || planeScale <= 0) return 1;
    const square = trueMetres * planeScale;
    if (!(square > 0)) return 1;
    return Math.min(1, Math.max(MIN_FORESHORTEN, projectedUnits / square));
  }

  /**
   * Which way a span leans, and how sure we are — as one signed number in
   * [-1, 1] rather than a sign and a latch.
   *
   * Depth is the only thing that can say *which* way a span leans, and it is
   * also the noisiest thing the model reports. An earlier version took the sign
   * from it and held that sign until the evidence turned round, which is fine
   * until you notice what happens near square-on: the foreshortening cue is
   * badly conditioned there and will happily claim twenty degrees from a two
   * percent scale error, so the band would take a confident twenty-degree lean
   * in whichever direction the noise last fell, and snap over when it changed
   * its mind.
   *
   * Ramping instead of latching removes both halves of that. The lean this
   * returns fades smoothly to nothing as the evidence does, so a sign that is
   * about to flip is already multiplying an angle of zero and the flip cannot be
   * seen. A real lean always produces real depth, so nothing is lost.
   *
   * `inPlane` is the direction the span takes on screen, so a span whose
   * projection runs against it is read the right way round.
   */
  private leanOf(world: Vector3, inPlane: Vector3): number {
    const length = world.length();
    if (length < 1e-9) return 0;
    const facing = world.x * inPlane.x + world.y * inPlane.y >= 0 ? 1 : -1;
    const depth = (world.z * facing) / length;
    return Math.min(1, Math.max(-1, depth / CONFIDENT_DEPTH));
  }

  private compose(options: WristSolverOptions): WristPose {
    const { anchor } = options;
    const { pose } = this;

    const planeScale = this.scaleSmoothed[0] ?? 0;
    pose.planeScale = planeScale;
    const bias = options.metricBias > 0 ? options.metricBias : 1;
    // `planeScale` came from dividing plane units by MediaPipe's metres, so it is
    // too small by the same factor those metres are too large; undoing the bias
    // here is what makes one true millimetre convert correctly.
    pose.unitsPerTrueMm = planeScale > 0 ? (planeScale * bias) / 1000 : 0;

    // --- The two spans, as they appear and as they really are ---------------
    this.planarAt(LM.WRIST, scratch.wrist);
    this.planarAt(LM.MIDDLE_MCP, scratch.knuckles);
    scratch.along2D.subVectors(scratch.wrist, scratch.knuckles).setZ(0);
    const palmUnits = scratch.along2D.length();
    if (palmUnits < 1e-9) scratch.along2D.copy(DOWN_THE_FRAME);
    scratch.along2D.normalize();

    // Turn toward the real forearm, by however much the elbow is worth trusting.
    //
    // Rotated rather than blended: averaging two unit vectors shortens the
    // result as they diverge and collapses it entirely at a right angle, which
    // is precisely the case this exists to fix.
    const hint = options.forearm;
    if (hint && hint.confidence > 0.01) {
      const from = Math.atan2(scratch.along2D.y, scratch.along2D.x);
      const to = Math.atan2(hint.y, hint.x);
      let delta = to - from;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const turned = from + delta * Math.min(1, hint.confidence);
      scratch.along2D.set(Math.cos(turned), Math.sin(turned), 0);
    }

    this.planarAt(LM.INDEX_MCP, scratch.a);
    this.planarAt(LM.PINKY_MCP, scratch.b);
    const spanUnits = scratch.a.distanceTo(scratch.b);

    // A quarter turn from the forearm, in the same plane. The wrist's wide axis
    // is perpendicular to the arm, so this is where it lies on screen whatever
    // the roll — the roll only takes it out of the plane, never round it.
    scratch.across2D.set(-scratch.along2D.y, scratch.along2D.x, 0);

    // The wearer's own two anatomical lengths, in metres. True 3D distances, so
    // they do not foreshorten — which is exactly what makes them usable as the
    // yardstick the leans are measured against.
    if (this.hasWorld) {
      this.worldAt(LM.WRIST, scratch.a);
      this.worldAt(LM.MIDDLE_MCP, scratch.b);
      this.palmLength.push(scratch.a.distanceTo(scratch.b));

      this.worldAt(LM.INDEX_MCP, scratch.a);
      this.worldAt(LM.PINKY_MCP, scratch.b);
      this.knuckleSpan.push(scratch.a.distanceTo(scratch.b));
    }

    const palmMetres = this.palmLength.value;
    const spanMetres = this.knuckleSpan.value;

    // --- Out of the picture plane -------------------------------------------
    // Against the palm's own scale, not the whole hand's. See `smooth`.
    const localScale = this.palmScaleSmoothed[0] ?? planeScale;
    const cosTilt = this.foreshortening(this.rawPalmUnits, palmMetres, localScale);
    const cosRoll = this.foreshortening(this.rawSpanUnits, spanMetres, localScale);

    this.worldAt(LM.WRIST, scratch.a);
    this.worldAt(LM.MIDDLE_MCP, scratch.b);
    const tiltLean = this.leanOf(scratch.a.sub(scratch.b), scratch.along2D);

    this.worldAt(LM.PINKY_MCP, scratch.a);
    this.worldAt(LM.INDEX_MCP, scratch.b);
    const rollLean = this.leanOf(scratch.a.sub(scratch.b), scratch.across2D);

    // Magnitude from the projection, direction and confidence from depth. Where
    // they disagree the projection wins on size and depth wins on sign, which is
    // each cue doing the thing it is actually good at.
    const sinTilt = tiltLean * Math.sqrt(Math.max(0, 1 - cosTilt * cosTilt));
    const sinRoll = rollLean * Math.sqrt(Math.max(0, 1 - cosRoll * cosRoll));
    const leanTilt = Math.sqrt(Math.max(0, 1 - sinTilt * sinTilt));
    const leanRoll = Math.sqrt(Math.max(0, 1 - sinRoll * sinRoll));
    pose.forearmTilt = Math.atan2(sinTilt, leanTilt);
    pose.wristRoll = Math.atan2(sinRoll, leanRoll);

    // --- How big the wrist is ------------------------------------------------
    //
    // The wearer's own breadth, converted at the palm's scale. Written as a
    // *multiplication* and that is the whole point of the line.
    //
    // It used to divide: the arm's width on screen over the cosine of the roll
    // that foreshortened it, over one minus a depth correction. Both are
    // estimates, and dividing by an estimate hands its error straight to the
    // most visible number in the piece — with `1 / cos` blowing up exactly as
    // the wrist turns, which is the one thing a bracelet does constantly. On
    // noise-free landmarks it was accurate to a percent; on a real camera it
    // breathes. Multiplying a measured length by a filtered scale cannot do
    // that, and lands in the same place: the median span times the scale *is*
    // the width the arm would show square-on.
    const palmScale = this.palmScaleSmoothed[0] ?? planeScale;
    if (spanMetres) this.breadth.push(spanMetres * 1000 * WRIST_BREADTH_RATIO);
    const breadthMm = (this.breadth.value ?? 0) / bias;
    pose.breadthMm = breadthMm;
    pose.circumferenceMm = wristCircumferenceMm(breadthMm);
    pose.spread = this.breadth.spread ?? 1;
    pose.settled = this.breadth.settled && (this.breadth.spread ?? 1) < 0.05;

    const fittedMm = (breadthMm / 2) * WEAR_CLEARANCE;
    const chosenMm = semiMajorForDiameterMm(options.diameterMm);
    const sizeRatio =
      !options.autoFit && options.diameterMm > 0 && fittedMm > 0 ? chosenMm / fittedMm : 1;
    const trim = anchor.sizeMultiplier * sizeRatio;

    // The scale fit describes the palm, which under a lean is a different
    // distance from the lens than the wrist is. Correcting for that is what
    // stops the band swelling by a fifth on an arm reaching toward the camera.
    //
    // Note where the noise goes. The correction is driven by `sinTilt`, which
    // has already been faded out where the evidence for it is weak — so this
    // multiplies by one exactly when it is least sure of itself, which is the
    // opposite of what dividing by a raw cosine did.
    let magnify = 1;
    if (palmScale > 0 && palmMetres) {
      const toPalm = (ANCHOR_DISTANCE * this.lastZoom) / palmScale;
      const shift = (PALM_SCALE_CENTROID * palmMetres * sinTilt) / toPalm;
      magnify = 1 / (1 - Math.min(MAX_DEPTH_SHIFT, Math.max(-MAX_DEPTH_SHIFT, shift)));
    }

    const unitsPerTrueMm = palmScale > 0 ? (palmScale * bias * magnify) / 1000 : 0;
    if (unitsPerTrueMm > 0 && fittedMm > 0) {
      pose.radius = fittedMm * trim * unitsPerTrueMm;
      pose.semiMajorMm = fittedMm * trim;
    } else {
      // Nothing metric yet. The arm's width on screen is a fine seed, and it is
      // what the piece was drawn at before any of this existed.
      pose.radius = (spanUnits * WRIST_BREADTH_RATIO * WEAR_CLEARANCE * trim) / 2;
      pose.semiMajorMm = semiMajorForDiameterMm(DEFAULT_DIAMETER_MM);
    }
    pose.fittingDiameterMm = diameterMmForSemiMajor(
      fittedMm > 0 ? fittedMm * trim : pose.semiMajorMm,
    );

    // --- Placement ------------------------------------------------------------
    //
    // The seat is a distance along the *forearm*, so what it takes up on screen
    // is that distance foreshortened. Leaving the cosine out is what walked the
    // band off the end of a arm pointing at the camera: the visible forearm got
    // shorter while the offset down it did not.
    pose.position
      .copy(scratch.wrist)
      .addScaledVector(scratch.along2D, pose.radius * anchor.seatAlongForearm * leanTilt)
      .addScaledVector(scratch.across2D, pose.radius * anchor.crossOffset * leanRoll);

    // --- Orientation ----------------------------------------------------------
    // Each axis is its picture-plane direction, lifted out by its own angle.
    scratch.axis
      .copy(scratch.along2D)
      .multiplyScalar(leanTilt)
      .setZ(sinTilt)
      .normalize();
    scratch.lateral
      .copy(scratch.across2D)
      .multiplyScalar(leanRoll)
      .setZ(sinRoll);

    // A tilted arm and a rolled wrist leave the two very slightly out of square,
    // so the lateral is trued against the axis before the third is taken from
    // their cross product — which is what keeps the basis a rotation.
    scratch.lateral.addScaledVector(scratch.axis, -scratch.lateral.dot(scratch.axis));
    if (scratch.lateral.lengthSq() < 1e-10) {
      scratch.lateral.copy(scratch.across2D);
      scratch.lateral.addScaledVector(scratch.axis, -scratch.lateral.dot(scratch.axis));
    }
    scratch.lateral.normalize();
    scratch.up.crossVectors(scratch.axis, scratch.lateral).normalize();

    scratch.basis.makeBasis(scratch.lateral, scratch.up, scratch.axis);
    pose.quaternion.setFromRotationMatrix(scratch.basis);

    scratch.drape.setFromAxisAngle(BAND_LATERAL, anchor.tilt);
    pose.quaternion.multiply(scratch.drape);

    return pose;
  }
}
