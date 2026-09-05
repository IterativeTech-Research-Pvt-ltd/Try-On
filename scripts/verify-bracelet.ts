/**
 * Numeric checks on the bracelet pose solver and the American-diamond band,
 * driven by a synthetic hand.
 *
 * Same reasoning as the ring and necklace harnesses: a bracelet that is 10%
 * oversized, seated 15 mm too far up the arm, or rolled the wrong way round the
 * forearm still looks broadly plausible over a webcam, and by the time it looks
 * wrong you cannot tell which stage produced it. Feeding the solver a hand whose
 * real dimensions we chose ourselves turns that into an assertion.
 *
 * The band gets its own section because two of its failure modes are silent. A
 * basis built left-handed still produces a quaternion, and stones set from it
 * sit at plausible positions facing the wrong way; and a row laid from a fixed
 * count rather than the band's own length leaves a gap at the back that only
 * appears when the wearer turns their wrist.
 *
 * Run with: npx tsx scripts/verify-bracelet.ts
 */
import { Matrix4, Quaternion, Vector3 } from "three";
import {
  WristPoseSolver,
  DEFAULT_WRIST_ANCHOR,
  type WristSolverOptions,
} from "../src/lib/hand/wristPose";
import type { ForearmHint } from "../src/lib/hand/forearm";
import { DEFAULT_ONE_EURO } from "../src/lib/hand/oneEuro";
import { LM } from "../src/lib/hand/landmarks";
import { ANCHOR_DISTANCE, CAMERA_FOV, type FrameGeometry } from "../src/lib/hand/projection";
import {
  WEAR_CLEARANCE,
  WRIST_BREADTH_RATIO,
  WRIST_DEPTH_RATIO,
  WRIST_OCCLUDER,
  wristCircumferenceMm,
} from "../src/lib/jewellery/wristFit";
import { buildADBracelet } from "../src/lib/jewellery/adBracelet";
import { BRACELETS } from "../src/lib/jewellery/bracelets";

/* ------------------------------------------------------------------ */
/* A synthetic adult hand and forearm, in metres                       */
/* ------------------------------------------------------------------ */

/** The span the wrist estimate is supposed to be derived from. */
const KNUCKLE_PITCH = 0.024;
const KNUCKLE_SPAN_M = KNUCKLE_PITCH * 3;
/** Wrist landmark to middle knuckle. */
const PALM_LENGTH_M = 0.098;

/**
 * Builds a right hand with the fingers pointing up the image and the forearm
 * running down out of frame, optionally rolled about the forearm axis.
 *
 * MediaPipe world convention: +x right, +y down, +z away from the viewer.
 */
function makeWorldHand(
  roll = 0,
  spin = 0,
  pitch = 0,
  jitter = 0,
): { x: number; y: number; z: number }[] {
  const p: { x: number; y: number; z: number }[] = Array.from({ length: 21 }, () => ({
    x: 0,
    y: 0,
    z: 0,
  }));

  const set = (i: number, x: number, yUp: number, zToward: number) => {
    p[i] = { x, y: -yUp, z: -zToward };
  };

  set(LM.WRIST, 0, 0, 0);

  const knuckleY = PALM_LENGTH_M;
  set(LM.INDEX_MCP, -1.5 * KNUCKLE_PITCH, knuckleY, 0);
  set(LM.MIDDLE_MCP, 0, knuckleY + 0.003, 0);
  set(LM.RING_MCP, 1 * KNUCKLE_PITCH, knuckleY, 0);
  set(LM.PINKY_MCP, 1.5 * KNUCKLE_PITCH, knuckleY - 0.005, 0);
  // The index and middle knuckles carry the span the estimate reads, so they are
  // placed exactly; the ring knuckle only has to be between them.
  set(LM.RING_MCP, 0.75 * KNUCKLE_PITCH, knuckleY, 0);

  const chain = (mcp: number, lengths: number[]) => {
    let y = -p[mcp].y;
    const x = p[mcp].x;
    for (let i = 0; i < lengths.length; i++) {
      y += lengths[i];
      set(mcp + i + 1, x, y, 0);
    }
  };
  chain(LM.INDEX_MCP, [0.039, 0.023, 0.02]);
  chain(LM.MIDDLE_MCP, [0.043, 0.026, 0.021]);
  chain(LM.RING_MCP, [0.0385, 0.025, 0.02]);
  chain(LM.PINKY_MCP, [0.031, 0.018, 0.018]);

  // The thumb, displaced toward the palm.
  const palmar = 0.012;
  set(LM.THUMB_CMC, -1.9 * KNUCKLE_PITCH, 0.02, palmar * 0.4);
  set(LM.THUMB_MCP, -2.5 * KNUCKLE_PITCH, 0.042, palmar);
  set(LM.THUMB_IP, -2.9 * KNUCKLE_PITCH, 0.062, palmar * 1.1);
  set(LM.THUMB_TIP, -3.1 * KNUCKLE_PITCH, 0.078, palmar * 1.1);

  // Roll about the forearm axis, which here runs down the image's y.
  const rc = Math.cos(roll);
  const rs = Math.sin(roll);
  let out = p.map(({ x, y, z }) => ({ x: x * rc - z * rs, y, z: x * rs + z * rc }));

  // Pitch the arm out of the picture plane, about the knuckle line. Positive
  // brings the fingers toward the lens and takes the wrist away from it.
  const pc = Math.cos(pitch);
  const ps = Math.sin(pitch);
  out = out.map(({ x, y, z }) => ({ x, y: y * pc - z * ps, z: y * ps + z * pc }));

  // Then swing the whole arm round *within* the picture, about the view axis.
  const sc = Math.cos(spin);
  const ss = Math.sin(spin);
  out = out.map(({ x, y, z }) => ({ x: x * sc - y * ss, y: x * ss + y * sc, z }));

  // Finally, noise on depth alone — the one output of the model this solver is
  // built not to trust. Deterministic, so a failure is reproducible.
  if (jitter === 0) return out;
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  return out.map((v) => ({ ...v, z: v.z + next() * jitter }));
}

/** Pinhole projection to normalized image coordinates. */
function projectHand(
  world: { x: number; y: number; z: number }[],
  distance: number,
  aspect: number,
): { x: number; y: number; z: number }[] {
  const f = 1 / Math.tan(((CAMERA_FOV * Math.PI) / 180) / 2);
  return world.map((w) => {
    const depth = distance + w.z;
    const ndcX = (f / aspect) * (w.x / depth);
    const ndcY = f * (w.y / depth);
    return { x: ndcX / 2 + 0.5, y: ndcY / 2 + 0.5, z: w.z };
  });
}

/* ------------------------------------------------------------------ */

let failures = 0;

function check(label: string, actual: number, expected: number, tolerance: number) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} got ${actual.toFixed(4)}  want ${expected.toFixed(4)} ±${tolerance}`,
  );
}

function checkTrue(label: string, value: boolean) {
  if (!value) failures++;
  console.log(`${value ? "PASS" : "FAIL"}  ${label}`);
}

/* ------------------------------------------------------------------ */
/* The band                                                            */
/* ------------------------------------------------------------------ */

function verifyBand() {
  console.log("\n— American diamond band ——————————————————————————");

  for (const bracelet of BRACELETS) {
    console.log(`\n  ${bracelet.name}`);
    const semiMajor = 30;
    const built = buildADBracelet(bracelet.spec, semiMajor);
    const semiMinor = semiMajor * WRIST_DEPTH_RATIO;

    checkTrue(
      `  lays stones at all (${built.stones.length})`,
      built.stones.length > 20,
    );

    const position = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    const table = new Vector3();
    const axis = new Vector3();

    let properFrames = 0;
    let outwardFacing = 0;
    let bandAligned = 0;
    let outsideSkin = 0;
    let minStoneMm = Infinity;
    let maxStoneMm = 0;

    for (const matrix of built.stones) {
      matrix.decompose(position, rotation, scale);

      // three.js puts the sign of a reflected basis on scale.x, so a negative
      // scale here means the frame was built left-handed and the quaternion
      // pulled out of it is not the rotation the geometry needs.
      if (scale.x > 0) properFrames++;
      minStoneMm = Math.min(minStoneMm, scale.x * 2);
      maxStoneMm = Math.max(maxStoneMm, scale.x * 2);

      // The stone is authored with its table on +Y, and it has to face out of
      // the band.
      table.set(0, 1, 0).applyQuaternion(rotation);
      const ellipse =
        (position.x / semiMajor) ** 2 + (position.y / semiMinor) ** 2;
      if (ellipse > 1) outsideSkin++;
      // Stepping along the table direction must take it further out.
      const stepped =
        ((position.x + table.x * 0.5) / semiMajor) ** 2 +
        ((position.y + table.y * 0.5) / semiMinor) ** 2;
      if (stepped > ellipse && Math.abs(table.z) < 0.02) outwardFacing++;

      // The third axis of every stone's frame is the band's own axis, because
      // the band is planar — so it must be parallel to Z everywhere.
      axis.set(0, 0, 1).applyQuaternion(rotation);
      if (Math.abs(axis.z) > 0.999) bandAligned++;
    }

    const n = built.stones.length;
    check("  right-handed stone frames", properFrames, n, 0);
    check("  tables facing out of the band", outwardFacing, n, 0);
    check("  stone frames square to the band axis", bandAligned, n, 0);
    check("  stones clear of the wearer's skin", outsideSkin, n, 0);
    check(
      "  main stone drawn at its stated size (mm)",
      maxStoneMm,
      bracelet.spec.mainStoneMm,
      0.01,
    );
    checkTrue(
      `  accent row present only where specified (${minStoneMm.toFixed(1)} mm)`,
      bracelet.spec.accentStoneMm > 0
        ? Math.abs(minStoneMm - bracelet.spec.accentStoneMm) < 0.01
        : Math.abs(minStoneMm - bracelet.spec.mainStoneMm) < 0.01,
    );

    // --- the 360-degree claim -------------------------------------------
    // Checked one row at a time, grouped by stone size, because pooling the
    // rows would let a hole in one of them hide behind the others.
    //
    // The bar is the row's own mean spacing, with headroom: stones are spaced
    // evenly by *arc length*, and equal arc lengths subtend larger angles where
    // the wrist's ellipse is tightest, so some variation is correct. A row laid
    // from a fixed count rather than the band's measured length fails this with
    // one gap several times the mean, which is the failure that only shows when
    // the wearer turns their wrist.
    // Keyed on stone size *and* position across the band: the two accent rows
    // are the same size as each other, and pooling them would halve the
    // apparent spacing and hide a hole in either one.
    const rows = new Map<string, { stoneMm: number; angles: number[] }>();
    for (let i = 0; i < built.stones.length; i++) {
      built.stones[i].decompose(position, rotation, scale);
      const key = `${scale.x.toFixed(2)}@${position.z.toFixed(1)}`;
      const row = rows.get(key) ?? { stoneMm: scale.x * 2, angles: [] };
      row.angles.push(built.stoneAngles[i]);
      rows.set(key, row);
    }

    for (const { stoneMm, angles: raw } of rows.values()) {
      const angles = [...raw].sort((x, y) => x - y);
      let widest = angles[0] + Math.PI * 2 - angles[angles.length - 1];
      for (let i = 1; i < angles.length; i++) {
        widest = Math.max(widest, angles[i] - angles[i - 1]);
      }
      const mean = (Math.PI * 2) / angles.length;
      checkTrue(
        `  ${stoneMm.toFixed(1)} mm row closes round the band` +
          ` (${angles.length} stones, widest gap ${(widest / mean).toFixed(2)}x mean)`,
        widest < mean * 1.5,
      );
    }

    // --- metalwork -------------------------------------------------------
    built.metal.computeBoundingBox();
    const box = built.metal.boundingBox!;
    // The rails stand half a wire proud of each edge, so the metal reaches
    // exactly one wire radius wider than the band's stated width.
    check(
      "  band width along the forearm (mm)",
      box.max.z - box.min.z,
      bracelet.spec.bandWidthMm + bracelet.spec.railWireMm,
      0.02,
    );
    // Not exactly zero: the collets are laid at even arc lengths, which is
    // symmetric about the wrist's flat axis but not about its wide one.
    check(
      "  band centred across the wrist (mm)",
      box.max.x + box.min.x,
      0,
      bracelet.spec.mainStoneMm * 0.15,
    );
    checkTrue(
      "  band closes round the wrist",
      box.max.x > semiMajor && box.max.y > semiMinor,
    );

    // No metal inside the band's inner surface, or it would be buried in the arm.
    const pos = built.metal.attributes.position;
    let deepest = Infinity;
    let finite = true;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        finite = false;
        break;
      }
      deepest = Math.min(deepest, Math.hypot(x / semiMajor, y / semiMinor));
    }
    checkTrue("  metalwork has no degenerate vertices", finite);
    checkTrue(
      `  metalwork sits on the wrist, not in it (${deepest.toFixed(3)})`,
      deepest > 0.985,
    );
  }

  // --- sizing with the wearer -------------------------------------------
  console.log("\n  Sizing");
  const small = buildADBracelet(BRACELETS[0].spec, 26);
  const large = buildADBracelet(BRACELETS[0].spec, 34);
  const ratio = large.stones.length / small.stones.length;
  check("  stone count grows with the wrist", ratio, 34 / 26, 0.06);

  const s = new Vector3();
  const q = new Quaternion();
  const v = new Vector3();
  small.stones[0].decompose(v, q, s);
  const smallStone = s.x;
  large.stones[0].decompose(v, q, s);
  check("  stone size does not grow with the wrist", s.x, smallStone, 0.001);

  checkTrue(
    "  forearm occluder is never inside the band",
    WRIST_OCCLUDER.press > 1,
  );
}

/* ------------------------------------------------------------------ */
/* The solver                                                          */
/* ------------------------------------------------------------------ */

function verifySolver() {
  const DISPLAY_W = 1280;
  const DISPLAY_H = 1600; // the stage is 4:5
  const aspect = DISPLAY_W / DISPLAY_H;
  const CAMERA_DISTANCE = 0.45;

  const geometry: FrameGeometry = {
    videoWidth: DISPLAY_W,
    videoHeight: DISPLAY_H,
    displayWidth: DISPLAY_W,
    displayHeight: DISPLAY_H,
    mirrored: false,
    zoom: 1,
    centerU: 0.5,
    centerV: 0.5,
  };

  const options: WristSolverOptions = {
    anchor: DEFAULT_WRIST_ANCHOR,
    autoFit: true,
    diameterMm: 56,
    metricBias: 1,
    smoothing: DEFAULT_ONE_EURO,
  };

  const settle = (
    roll: number,
    opts: WristSolverOptions,
    geo: FrameGeometry = geometry,
    spin = 0,
    pitch = 0,
    /** Noise on the world landmarks' depth, in metres. */
    jitter = 0,
  ) => {
    // The image the model would see is projected from the *clean* hand; the
    // jitter goes only into the metric landmarks it reports alongside, which is
    // where MediaPipe's depth noise actually lives.
    const world = makeWorldHand(roll, spin, pitch);
    const image = projectHand(world, CAMERA_DISTANCE, aspect);
    const reported = makeWorldHand(roll, spin, pitch, jitter);
    const result = {
      landmarks: [image],
      worldLandmarks: [reported],
      handedness: [],
      handednesses: [],
    };
    const solver = new WristPoseSolver();
    let last = null;
    for (let i = 0; i < 240; i++) {
      last = solver.solve(result as never, geo, opts, i * (1000 / 30));
    }
    if (!last) {
      console.log("FAIL  solver returned no pose");
      process.exit(1);
    }
    return {
      position: last.position.clone(),
      quaternion: last.quaternion.clone(),
      radius: last.radius,
      planeScale: last.planeScale,
      unitsPerTrueMm: last.unitsPerTrueMm,
      semiMajorMm: last.semiMajorMm,
      breadthMm: last.breadthMm,
      circumferenceMm: last.circumferenceMm,
      fittingDiameterMm: last.fittingDiameterMm,
      forearmTilt: last.forearmTilt,
      wristRoll: last.wristRoll,
      settled: last.settled,
      image,
    };
  };

  console.log("\n— Wrist measurement ——————————————————————————————");
  const pose = settle(0, options);

  const f = 1 / Math.tan(((CAMERA_FOV * Math.PI) / 180) / 2);
  const expectedScale = f / 2 / CAMERA_DISTANCE;
  check("plane units per metre", pose.planeScale, expectedScale, expectedScale * 0.06);

  const expectedBreadth = KNUCKLE_SPAN_M * 1000 * WRIST_BREADTH_RATIO;
  check("wrist breadth (mm)", pose.breadthMm, expectedBreadth, 0.6);
  check(
    "wrist circumference (mm)",
    pose.circumferenceMm,
    wristCircumferenceMm(expectedBreadth),
    0.8,
  );
  checkTrue(
    `circumference is a plausible adult wrist (${pose.circumferenceMm.toFixed(0)} mm)`,
    pose.circumferenceMm > 140 && pose.circumferenceMm < 210,
  );
  checkTrue("reading settles", pose.settled);

  check(
    "band built just clear of the wrist",
    pose.semiMajorMm / (expectedBreadth / 2),
    WEAR_CLEARANCE,
    0.005,
  );

  console.log("\n— Placement ——————————————————————————————————————");

  // Where the wrist and middle knuckle land on the anchor plane, worked out
  // independently of the solver.
  const planar = (i: number) =>
    new Vector3((pose.image[i].x - 0.5) * aspect, (0.5 - pose.image[i].y) * 1, 0);
  const wrist = planar(LM.WRIST);
  const knuckles = planar(LM.MIDDLE_MCP);
  const down = new Vector3().subVectors(wrist, knuckles).setZ(0).normalize();

  const expectedSeat = wrist
    .clone()
    .addScaledVector(down, pose.radius * DEFAULT_WRIST_ANCHOR.seatAlongForearm);
  check("seat lands on the forearm (x)", pose.position.x, expectedSeat.x, 0.004);
  check("seat lands on the forearm (y)", pose.position.y, expectedSeat.y, 0.004);

  // The seat has to be past the wrist, on the far side from the hand — a sign
  // error here puts the bracelet in the middle of the palm.
  const beyond = new Vector3().subVectors(pose.position, wrist).dot(down);
  checkTrue("seated beyond the wrist crease", beyond > 0);
  check(
    "seated the distance asked for (band radii)",
    beyond / pose.radius,
    DEFAULT_WRIST_ANCHOR.seatAlongForearm,
    0.01,
  );

  const spanUnits = planar(LM.INDEX_MCP).distanceTo(planar(LM.PINKY_MCP));
  check(
    "band drawn just clear of the arm's own width",
    pose.radius / ((spanUnits * WRIST_BREADTH_RATIO) / 2),
    WEAR_CLEARANCE,
    0.006,
  );

  console.log("\n— Depth noise cannot move the band ————————————————");

  // The whole point of recovering the two lean angles from foreshortening
  // instead of from landmark depth. 8 mm of jitter on every z is far more than
  // MediaPipe actually produces; the pose is allowed to barely notice.
  const noisy = settle(0, options, geometry, 0, 0, 0.008);
  check("seat holds against depth noise (x)", noisy.position.x, pose.position.x, 0.0015);
  check("seat holds against depth noise (y)", noisy.position.y, pose.position.y, 0.0015);
  check("size holds against depth noise", noisy.radius / pose.radius, 1, 0.02);
  check(
    "orientation holds against depth noise",
    noisy.quaternion.dot(pose.quaternion),
    1,
    0.004,
  );

  console.log("\n— Steadiness on a shaky camera ————————————————————");

  // The check the harness was missing. Every landmark was being fed in
  // noise-free, so anything that only misbehaves on a jittery input measured
  // perfectly here — and what a wearer sees is not where the size lands on
  // average but whether it sits still.
  //
  // The largest single-frame *step* is the telling number rather than the total
  // swing, because the failures worth catching are discontinuities: a sign that
  // latches one way and flips, or a clamp that quietly swaps one size law for
  // another as the estimate crosses it. Both hold perfectly still either side of
  // the jump and so leave the swing looking respectable.
  //
  // **Read this together with the moving-hand section below.** They are the two
  // ends of one trade — a scale filter steady enough to pass this and slow
  // enough to fail that is not a good filter, it is half a filter. Tightening
  // either of these numbers without checking the other is how the size came to
  // lag a quarter of its own width behind a moving hand.
  {
    const shaky = (roll: number) => {
      const clean = makeWorldHand(roll);
      const solver = new WristPoseSolver();
      let seed = 987;
      const jitter = (scale: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed / 0x7fffffff - 0.5) * scale;
      };
      const radii: number[] = [];
      const seats: number[] = [];
      for (let i = 0; i < 300; i++) {
        // 4 mm on every metric landmark, and a third of a percent of the frame
        // on every image one — a fair bit worse than the model actually is.
        const world = clean.map((v) => ({
          x: v.x + jitter(0.004),
          y: v.y + jitter(0.004),
          z: v.z + jitter(0.004),
        }));
        const image = projectHand(clean, CAMERA_DISTANCE, aspect).map((v) => ({
          x: v.x + jitter(0.003),
          y: v.y + jitter(0.003),
          z: v.z,
        }));
        const out = solver.solve(
          { landmarks: [image], worldLandmarks: [world] } as never,
          geometry,
          options,
          i * (1000 / 30),
        );
        if (out && i > 150) {
          radii.push(out.radius);
          seats.push(out.position.y);
        }
      }
      const swing = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
      const step = (xs: number[]) => {
        let worst = 0;
        for (let i = 1; i < xs.length; i++) worst = Math.max(worst, Math.abs(xs[i] - xs[i - 1]));
        return worst;
      };
      return {
        sizeSwing: swing(radii) / radii[0],
        sizeStep: step(radii) / radii[0],
        seatSwing: swing(seats),
        seatStep: step(seats),
      };
    };

    // Zero is in the list on purpose: square-on is where the lean's direction is
    // least knowable, so it is where a latched sign used to sit on the fence and
    // flip. It is also the pose people hold a hand up in.
    for (const degrees of [0, 40, 65]) {
      const shake = shaky((degrees * Math.PI) / 180);
      checkTrue(
        `drawn size does not breathe at ${degrees}° of roll` +
          ` (${(shake.sizeSwing * 100).toFixed(1)}% swing)`,
        shake.sizeSwing < 0.04,
      );
      checkTrue(
        `drawn size never jumps at ${degrees}° of roll` +
          ` (${(shake.sizeStep * 100).toFixed(2)}% worst frame)`,
        shake.sizeStep < 0.01,
      );
      checkTrue(
        `seat does not wander at ${degrees}° of roll` +
          ` (${(shake.seatSwing * 1000).toFixed(2)} thousandths of a frame)`,
        shake.seatSwing < 0.006,
      );
      checkTrue(
        `seat never jumps at ${degrees}° of roll` +
          ` (${(shake.seatStep * 1000).toFixed(2)} thousandths worst frame)`,
        shake.seatStep < 0.0013,
      );
    }
  }

  console.log("\n— A hand that moves ———————————————————————————————");

  // The other end of the trade above, and the check that was missing when the
  // size lagged a quarter of its own width behind an ordinary movement.
  //
  // A One Euro filter's `beta` multiplies a derivative, so it carries the
  // signal's units — and a scale in plane units per metre is some thirty times
  // the magnitude of a landmark coordinate. Handing both the same beta tunes it
  // for the landmarks and leaves the scale with a fixed low-pass and a second of
  // lag. Nothing about a still hand can show that up.
  {
    const FPS = 30;
    const solver = new WristPoseSolver();
    const world = makeWorldHand();
    let seed = 4242;
    const shake = (scale: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff - 0.5) * scale;
    };

    /** What the band should be, from the arm's own width in the clean frame. */
    const wanted = (clean: { x: number; y: number }[]) => {
      const at = (i: number) => ({ x: (clean[i].x - 0.5) * aspect, y: 0.5 - clean[i].y });
      const a = at(LM.INDEX_MCP);
      const b = at(LM.PINKY_MCP);
      return (Math.hypot(a.x - b.x, a.y - b.y) * WRIST_BREADTH_RATIO * WEAR_CLEARANCE) / 2;
    };

    let frame = 0;
    const at = (distance: number) => {
      const clean = projectHand(world, distance, aspect);
      const image = clean.map((v) => ({ x: v.x + shake(0.0015), y: v.y + shake(0.0015), z: v.z }));
      const noisy = world.map((v) => ({
        x: v.x + shake(0.002),
        y: v.y + shake(0.002),
        z: v.z + shake(0.002),
      }));
      const out = solver.solve(
        { landmarks: [image], worldLandmarks: [noisy] } as never,
        geometry,
        options,
        frame++ * (1000 / FPS),
      )!;
      return Math.abs(out.radius - wanted(clean)) / wanted(clean);
    };

    for (let i = 0; i < 200; i++) at(0.45);

    // Fifteen centimetres closer over half a second — an ordinary movement, not
    // a stress test.
    let worst = 0;
    for (let i = 0; i < 15; i++) worst = Math.max(worst, at(0.45 - 0.15 * ((i + 1) / 15)));
    checkTrue(
      `size keeps up with a moving hand (${(worst * 100).toFixed(1)}% behind at worst)`,
      worst < 0.07,
    );

    let settle = 0;
    for (let i = 0; i < 90; i++) if (at(0.3) > 0.03) settle++;
    checkTrue(
      `size is caught up the moment the hand stops (${(settle / FPS).toFixed(2)}s)`,
      settle / FPS < 0.2,
    );
  }

  console.log("\n— A hand that moves and turns at once ——————————————");

  // Every other section here holds one thing still while it varies another, and
  // a solver can pass all of them while being unusable: the errors that show up
  // in a try-on come from a hand that is travelling, turning and changing
  // distance at the same time, which is the only thing a hand ever actually
  // does. This section drives all five at once at speeds a person produces, and
  // reports the *distribution* rather than a single pose — a piece that is right
  // on average and wrong on one frame in twenty reads as unreliable, and only a
  // percentile shows that.
  {
    const FPS = 30;
    const solver = new WristPoseSolver();
    let seed = 20260825;
    const jitter = (scale: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff - 0.5) * scale;
    };

    /**
     * The hand posed and placed, and the truth that goes with it.
     *
     * The lateral movement is applied to the projection only. MediaPipe's world
     * landmarks are hand-local, so carrying someone's hand across the frame does
     * not move them — and feeding a translated copy to the solver would quietly
     * excuse it from the one error the movement actually causes.
     */
    const frameAt = (t: number) => {
      const roll = Math.sin(t * 1.1) * 0.9;
      const lean = Math.sin(t * 0.7 + 1) * 0.7;
      const spin = Math.sin(t * 0.5 + 2) * 1.2;
      const distance = 0.42 + Math.sin(t * 0.9) * 0.1;
      const across = Math.sin(t * 1.3) * 0.05;
      const up = Math.cos(t * 1.1) * 0.04;
      const world = makeWorldHand(roll, spin, lean);
      const placed = world.map((v) => ({ x: v.x + across, y: v.y + up, z: v.z }));
      return { world, placed, distance };
    };

    const sizeErrors: number[] = [];
    const seatErrors: number[] = [];
    let frame = 0;

    for (let i = 0; i < 750; i++) {
      const t = i / FPS;
      const { world, placed, distance } = frameAt(t);
      const clean = projectHand(placed, distance, aspect);
      const image = clean.map((v) => ({
        x: v.x + jitter(0.0015),
        y: v.y + jitter(0.0015),
        z: v.z,
      }));
      const noisy = world.map((v) => ({
        x: v.x + jitter(0.002),
        y: v.y + jitter(0.002),
        z: v.z + jitter(0.002),
      }));
      const out = solver.solve(
        { landmarks: [image], worldLandmarks: [noisy] } as never,
        geometry,
        options,
        frame++ * (1000 / FPS),
      )!;
      if (i < 200) continue;

      // The band's true size is its millimetres at the wrist's own distance.
      const wantRadius =
        (((KNUCKLE_SPAN_M * 1000 * WRIST_BREADTH_RATIO) / 2) * WEAR_CLEARANCE * ANCHOR_DISTANCE) /
        1000 /
        (distance + world[LM.WRIST].z);
      sizeErrors.push(Math.abs(out.radius - wantRadius) / wantRadius);

      const at = (j: number) =>
        new Vector3((clean[j].x - 0.5) * aspect, (0.5 - clean[j].y) * 1, 0);
      const three = (j: number) => new Vector3(world[j].x, -world[j].y, -world[j].z);
      const axis = three(LM.WRIST).sub(three(LM.MIDDLE_MCP)).normalize();
      const inPlane = new Vector3(axis.x, axis.y, 0).normalize();
      const wantSeat = at(LM.WRIST).addScaledVector(
        inPlane,
        wantRadius *
          DEFAULT_WRIST_ANCHOR.seatAlongForearm *
          Math.sqrt(Math.max(0, 1 - axis.z * axis.z)),
      );
      seatErrors.push(out.position.distanceTo(wantSeat) / wantRadius);
    }

    const at = (xs: number[], q: number) => {
      const sorted = [...xs].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    };

    checkTrue(
      `size is right through the movement (median ${(at(sizeErrors, 0.5) * 100).toFixed(1)}%)`,
      at(sizeErrors, 0.5) < 0.05,
    );
    checkTrue(
      `size has no bad frames (95th ${(at(sizeErrors, 0.95) * 100).toFixed(1)}%,` +
        ` worst ${(at(sizeErrors, 1) * 100).toFixed(1)}%)`,
      at(sizeErrors, 0.95) < 0.1 && at(sizeErrors, 1) < 0.15,
    );
    checkTrue(
      `band stays on the arm through the movement` +
        ` (median ${(at(seatErrors, 0.5) * 100).toFixed(0)}% of a band radius)`,
      at(seatErrors, 0.5) < 0.12,
    );
    checkTrue(
      `band never leaves the arm (95th ${(at(seatErrors, 0.95) * 100).toFixed(0)}%,` +
        ` worst ${(at(seatErrors, 1) * 100).toFixed(0)}%)`,
      at(seatErrors, 0.95) < 0.22 && at(seatErrors, 1) < 0.3,
    );
  }

  console.log("\n— Orientation ————————————————————————————————————");

  const bandAxis = new Vector3(0, 0, 1).applyQuaternion(pose.quaternion);
  const flat = new Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
  const across = new Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
  const drape = DEFAULT_WRIST_ANCHOR.tilt;

  // A hand held flat to the lens leans neither way, so both recovered angles
  // should be near nothing. Not exactly nothing: the thumb sits forward of the
  // palm, so a real perspective projection magnifies it slightly and drags the
  // whole-hand scale fit with it. A couple of degrees of standing bias is the
  // honest floor of this method, and is well inside what anyone can see.
  checkTrue(
    `flat hand reads as barely tilted (${((pose.forearmTilt * 180) / Math.PI).toFixed(1)}°)`,
    Math.abs(pose.forearmTilt) < 0.02,
  );
  checkTrue(
    `flat hand reads as barely rolled (${((pose.wristRoll * 180) / Math.PI).toFixed(1)}°)`,
    Math.abs(pose.wristRoll) < 0.02,
  );

  check("band axis follows the forearm", bandAxis.dot(down), Math.cos(drape), 0.02);
  check("band's wide axis lies across the arm", across.dot(down), 0, 0.01);
  check("band presents its wide face to the lens", flat.z, Math.cos(drape), 0.02);
  check("basis stays orthonormal", bandAxis.dot(flat), 0, 1e-6);
  check(
    "basis stays right-handed",
    new Vector3().crossVectors(across, flat).dot(bandAxis),
    1,
    1e-6,
  );

  console.log("\n— Arm out of the picture plane ————————————————————");

  // The case a flat frame cannot express at all: an arm leaning toward or away
  // from the lens. Both the band's own tilt and how far down the *visible*
  // forearm it is seated have to follow, or the piece walks off the end of an
  // arm that has got shorter on screen.
  //
  // Tight, and it has to be: the cue is a cosine, so near square-on a one
  // percent error in the scale it is measured against is worth eight degrees of
  // recovered angle. That is precisely why the scale is fit over the palm alone
  // — over the whole hand these came back seven degrees out, with a quarter of
  // the lean showing up as a roll instead.
  for (const degrees of [-50, -25, 25, 50]) {
    const angle = (degrees * Math.PI) / 180;
    const leaning = settle(0, options, geometry, 0, angle);
    const w = makeWorldHand(0, 0, angle);
    const three = (i: number) => new Vector3(w[i].x, -w[i].y, -w[i].z);
    const trueAxis = three(LM.WRIST).sub(three(LM.MIDDLE_MCP)).normalize();
    const expected = Math.asin(trueAxis.z);

    check(
      `lean recovered at ${degrees}°`,
      (leaning.forearmTilt * 180) / Math.PI,
      (expected * 180) / Math.PI,
      3,
    );
    checkTrue(
      `a lean is not mistaken for a roll at ${degrees}°` +
        ` (${((leaning.wristRoll * 180) / Math.PI).toFixed(0)}°)`,
      Math.abs(leaning.wristRoll) < 0.15,
    );

    const axisNow = new Vector3(0, 0, 1).applyQuaternion(leaning.quaternion);
    check(
      `band axis leaves the picture plane with the arm at ${degrees}°`,
      axisNow.dot(trueAxis),
      Math.cos(drape),
      0.05,
    );

    // The seat, measured on screen against the arm's own visible direction.
    const at = (i: number) =>
      new Vector3(
        (leaning.image[i].x - 0.5) * aspect,
        (0.5 - leaning.image[i].y) * 1,
        0,
      );
    const armNow = new Vector3().subVectors(at(LM.WRIST), at(LM.MIDDLE_MCP)).normalize();
    const seatNow = new Vector3().subVectors(leaning.position, at(LM.WRIST)).dot(armNow);
    check(
      `seat foreshortens with the arm at ${degrees}°`,
      seatNow / leaning.radius,
      DEFAULT_WRIST_ANCHOR.seatAlongForearm * Math.cos(leaning.forearmTilt),
      0.02,
    );
    // A leaning arm is no narrower, so the band must not shrink. What it must
    // not do is the fifth it was doing when the size came from the whole hand's
    // average distance rather than the wrist's own.
    //
    // Five percent rather than the one a *held* pose can be tuned to, and
    // deliberately — see "A hand that moves and turns at once" below. The step
    // that corrects the palm's scale down to the wrist's is the least robust in
    // the size, and tuning it to a static sweep costs four percent at the
    // ninety-fifth percentile of real movement. Held poses are not what anyone
    // does with a bracelet.
    check(
      `size holds through the lean at ${degrees}°`,
      leaning.radius / pose.radius,
      1,
      0.05,
    );
  }

  console.log("\n— A bent wrist ————————————————————————————————————");

  // The hand model's twenty-one landmarks end at the wrist, so the solver's own
  // guess at the forearm is the palm's direction carried past it. That is exact
  // while the hand is in line with the arm and wrong by the angle of the bend
  // when it is not — and wrong as a *rotation about the wrist*, so at a right
  // angle the band is not tilted, it is beside the arm.
  {
    /** Swing everything but the wrist about it; the forearm does not move. */
    const bend = (flex: number) => {
      const p = makeWorldHand();
      const w = p[LM.WRIST];
      const c = Math.cos(flex);
      const sn = Math.sin(flex);
      return p.map((v, i) =>
        i === LM.WRIST
          ? v
          : {
              x: w.x + (v.x - w.x) * c - (v.y - w.y) * sn,
              y: w.y + (v.x - w.x) * sn + (v.y - w.y) * c,
              z: v.z,
            },
      );
    };

    const seatOf = (flex: number, hint: ForearmHint | null) => {
      const world = bend(flex);
      const image = projectHand(world, CAMERA_DISTANCE, aspect);
      const solver = new WristPoseSolver();
      let last = null;
      for (let i = 0; i < 240; i++) {
        last = solver.solve(
          { landmarks: [image], worldLandmarks: [world] } as never,
          geometry,
          { ...options, forearm: hint },
          i * (1000 / 30),
        );
      }
      const at = (j: number) =>
        new Vector3((image[j].x - 0.5) * aspect, (0.5 - image[j].y) * 1, 0);
      // The forearm runs straight down the frame from the wrist, always.
      const want = at(LM.WRIST).addScaledVector(
        new Vector3(0, -1, 0),
        last!.radius * DEFAULT_WRIST_ANCHOR.seatAlongForearm,
      );
      return { off: last!.position.distanceTo(want) / last!.radius, radius: last!.radius };
    };

    // What an elbow directly below the wrist looks like on the anchor plane.
    const elbow: ForearmHint = { x: 0, y: -1, confidence: 1 };

    for (const degrees of [30, 60, 90]) {
      const flex = (degrees * Math.PI) / 180;
      const blind = seatOf(flex, null);
      const seeing = seatOf(flex, elbow);
      checkTrue(
        `a ${degrees}° bend puts the band off the arm without an elbow` +
          ` (${blind.off.toFixed(2)} band radii)`,
        blind.off > 0.25,
      );
      check(
        `the elbow puts it back at ${degrees}°`,
        seeing.off,
        0,
        0.02,
      );
    }

    // Half-trusted elbows land in between rather than jumping.
    const half = seatOf(Math.PI / 2, { x: 0, y: -1, confidence: 0.5 });
    const none = seatOf(Math.PI / 2, null);
    checkTrue(
      `a half-trusted elbow corrects part of the way (${half.off.toFixed(2)} of ${none.off.toFixed(2)})`,
      half.off > 0.05 && half.off < none.off * 0.75,
    );
  }

  console.log("\n— Rolling the wrist ——————————————————————————————");

  /** Half-width of the band's own ellipse as it lands on screen, in band radii. */
  const apparentHalfWidth = (quaternion: Quaternion) => {
    const x = new Vector3(1, 0, 0).applyQuaternion(quaternion);
    const y = new Vector3(0, 1, 0).applyQuaternion(quaternion);
    let widest = 0;
    for (let i = 0; i < 180; i++) {
      const t = (i / 180) * Math.PI * 2;
      const px = Math.cos(t) * x.x + WRIST_DEPTH_RATIO * Math.sin(t) * y.x;
      const py = Math.cos(t) * x.y + WRIST_DEPTH_RATIO * Math.sin(t) * y.y;
      widest = Math.max(widest, Math.hypot(px, py));
    }
    return widest;
  };

  const flatWidth = apparentHalfWidth(pose.quaternion);
  const flatAlongArm = Math.hypot(bandAxis.x, bandAxis.y);
  let previousWidth = flatWidth;

  // A rolled wrist looks narrower and the band has to look narrower with it —
  // but by being *turned*, not by being drawn smaller. Drawing it smaller was
  // the bug: it took the band's width along the arm down with it, and nothing
  // about a roll should touch that.
  for (const degrees of [30, 55, 75]) {
    const angle = (degrees * Math.PI) / 180;
    const rolled = settle(angle, options);
    const w = makeWorldHand(angle);
    const three = (i: number) => new Vector3(w[i].x, -w[i].y, -w[i].z);
    const trueAcross = three(LM.PINKY_MCP).sub(three(LM.INDEX_MCP)).normalize();

    // Looser than the lean, and only at the extremes: a cosine law assumes both
    // ends of the span sit at the same distance, and past about sixty degrees
    // one knuckle has come far enough toward the lens — and the other gone far
    // enough away — that the span projects longer than the cosine says. The
    // band is only three percent wider on screen for it.
    check(
      `roll recovered at ${degrees}°`,
      Math.abs((rolled.wristRoll * 180) / Math.PI),
      Math.abs((Math.asin(trueAcross.z) * 180) / Math.PI),
      degrees > 60 ? 7 : 4,
    );
    check(`piece is not redrawn smaller at ${degrees}°`, rolled.radius, pose.radius, 0.004);
    check(
      `stones are not re-laid for a roll at ${degrees}°`,
      rolled.semiMajorMm,
      pose.semiMajorMm,
      0.8,
    );

    const width = apparentHalfWidth(rolled.quaternion);
    checkTrue(
      `band narrows with the arm at ${degrees}° (${(width / flatWidth).toFixed(2)}x)`,
      width < previousWidth && width > WRIST_DEPTH_RATIO * 0.95,
    );
    previousWidth = width;

    const axisNow = new Vector3(0, 0, 1).applyQuaternion(rolled.quaternion);
    check(
      `band keeps its width along the arm at ${degrees}°`,
      Math.hypot(axisNow.x, axisNow.y),
      flatAlongArm,
      0.03,
    );
  }

  console.log("\n— Sizing modes ———————————————————————————————————");

  const manual = settle(0, { ...options, autoFit: false, diameterMm: 66 });
  check("manual size is drawn at its own diameter", manual.fittingDiameterMm, 66, 0.05);
  checkTrue(
    "manual size is larger on screen than the fitted one",
    manual.radius > pose.radius,
  );
  check(
    "manual size scales the drawn band by the same ratio",
    manual.radius / pose.radius,
    manual.semiMajorMm / pose.semiMajorMm,
    1e-6,
  );

  // The metric bias cannot reach the drawn band at all now: it is not in the
  // path. It should still correct the reported millimetres.
  const biased = settle(0, { ...options, metricBias: 1.2 });
  check("bias cannot move the drawn band", biased.radius, pose.radius, 1e-9);
  check("bias corrects the reported wrist", biased.breadthMm, pose.breadthMm / 1.2, 0.5);

  console.log("\n— Framing ————————————————————————————————————————");

  const mirrored = settle(0, options, { ...geometry, mirrored: true });
  check("mirroring reflects the seat", mirrored.position.x, -pose.position.x, 0.004);
  check("mirroring keeps the size", mirrored.radius, pose.radius, 1e-6);
  const mirroredAcross = new Vector3(1, 0, 0).applyQuaternion(mirrored.quaternion);
  const mirroredAxis = new Vector3(0, 0, 1).applyQuaternion(mirrored.quaternion);
  check(
    "mirroring keeps the basis right-handed",
    new Vector3()
      .crossVectors(
        mirroredAcross,
        new Vector3(0, 1, 0).applyQuaternion(mirrored.quaternion),
      )
      .dot(mirroredAxis),
    1,
    1e-6,
  );

  const zoomed = settle(0, options, { ...geometry, zoom: 2 });
  check("a 2x crop doubles the seat's offset", zoomed.position.x, pose.position.x * 2, 0.005);
  check("a 2x crop doubles the drawn band", zoomed.radius, pose.radius * 2, 1e-4);

  console.log("\n— Pose matrix ————————————————————————————————————");

  const matrix = new Matrix4().makeRotationFromQuaternion(pose.quaternion);
  check("pose is a pure rotation", matrix.determinant(), 1, 1e-6);
}

verifyBand();
verifySolver();

console.log(
  failures === 0
    ? "\nAll bracelet checks passed.\n"
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
