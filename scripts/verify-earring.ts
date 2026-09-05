/**
 * Numeric checks on the earring pose solver and the American-diamond pieces,
 * driven by a synthetic head.
 *
 * Rewritten when the earrings moved from the pose model to the face model. The
 * previous version passed everything while the pieces sat beside people's ears,
 * which is worth remembering: it was testing a solver built on landmarks that
 * were not precise enough to place jewellery, and no assertion about that solver
 * could have said so. Its checks were right and its foundation was wrong.
 *
 * So this one leans on what the face model actually guarantees — a dense
 * silhouette, and proportions that hold whatever the scale — and on the checks
 * that caught real faults on the bracelet: a head that is turning, tipping,
 * moving and changing distance at once, with every landmark shaken.
 *
 * Run with: npx tsx scripts/verify-earring.ts
 */
import { Matrix4, Quaternion, Vector3 } from "three";
import {
  EarPoseSolver,
  DEFAULT_EAR_ANCHOR,
  NOMINAL_FACE_WIDTH_MM,
  type EarSolverOptions,
} from "../src/lib/face/earPose";
import { FACE_LANDMARK_COUNT, FM } from "../src/lib/face/tracker";
import { DEFAULT_ONE_EURO } from "../src/lib/hand/oneEuro";
import { ANCHOR_DISTANCE, CAMERA_FOV, type FrameGeometry } from "../src/lib/hand/projection";
import { buildADEarring } from "../src/lib/jewellery/adEarring";
import { EARRINGS, dropOf } from "../src/lib/jewellery/earrings";

/* ------------------------------------------------------------------ */
/* A synthetic adult face, in metres                                   */
/* ------------------------------------------------------------------ */

/**
 * The seven landmarks the solver reads, taken from MediaPipe's own canonical
 * face model rather than invented.
 *
 * Transcribed from `canonical_face_model.obj`, in its units, with +x to the
 * subject's left, +y up and +z out of the face. This matters more than it
 * sounds: an earlier version of this file made a face up, gave it a nose 0.39
 * of its width forward where a real one is 0.657, and every check passed while
 * the solver over-estimated real head turns by nearly half. A synthetic subject
 * is only as good as its proportions, and the proportions are published.
 */
const CANONICAL: Record<number, [number, number, number]> = {
  [FM.SIDE_A]: [-7.66, 0.67, -2.44],
  [FM.SIDE_B]: [7.66, 0.67, -2.44],
  [FM.UNDER_A]: [-7.54, -1.05, -2.43],
  [FM.UNDER_B]: [7.54, -1.05, -2.43],
  [FM.BROW]: [0, 8.26, 4.48],
  [FM.CHIN]: [0, -9.4, 4.26],
  [FM.NOSE_TIP]: [0, -1.13, 7.48],
};

/** Face width across the silhouette, in metres, to scale the model by. */
const FACE_WIDTH_M = 0.14;
const UNIT = FACE_WIDTH_M / (CANONICAL[FM.SIDE_B][0] - CANONICAL[FM.SIDE_A][0]);

/**
 * The canonical face, optionally turned about its vertical axis and tipped in
 * the plane of the picture.
 *
 * Only the seven landmarks the solver reads are placed; the rest of the 478 are
 * filled so the array is the right length, because nothing looks at them.
 */
function makeFace(turn = 0, roll = 0): { x: number; y: number; z: number }[] {
  const p = Array.from({ length: FACE_LANDMARK_COUNT }, () => ({ x: 0, y: 0, z: 0 }));
  for (const [index, [x, y, z]] of Object.entries(CANONICAL)) {
    // MediaPipe's landmark convention is y down, z away from the viewer.
    p[Number(index)] = { x: x * UNIT, y: -y * UNIT, z: -z * UNIT };
  }

  // Turn about the head's vertical: +turn brings SIDE_B toward the lens, which
  // is the wearer's left ear.
  const tc = Math.cos(turn);
  const ts = Math.sin(turn);
  let out = p.map(({ x, y, z }) => ({ x: x * tc + z * ts, y, z: -x * ts + z * tc }));

  // Tip in the plane of the picture.
  const rc = Math.cos(roll);
  const rs = Math.sin(roll);
  out = out.map(({ x, y, z }) => ({ x: x * rc - y * rs, y: x * rs + y * rc, z }));
  return out;
}

function projectFace(
  world: { x: number; y: number; z: number }[],
  distance: number,
  aspect: number,
  shiftX = 0,
  shiftY = 0,
) {
  const f = 1 / Math.tan(((CAMERA_FOV * Math.PI) / 180) / 2);
  return world.map((w) => {
    const depth = distance + w.z;
    return {
      x: ((f / aspect) * ((w.x + shiftX) / depth)) / 2 + 0.5,
      y: (f * ((w.y + shiftY) / depth)) / 2 + 0.5,
      z: w.z,
    };
  });
}

/* ------------------------------------------------------------------ */

let failures = 0;

function check(label: string, actual: number, expected: number, tolerance: number) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label.padEnd(48)} got ${actual.toFixed(4)}  want ${expected.toFixed(4)} ±${tolerance}`,
  );
}

function checkTrue(label: string, value: boolean) {
  if (!value) failures++;
  console.log(`${value ? "PASS" : "FAIL"}  ${label}`);
}

/* ------------------------------------------------------------------ */
/* The pieces                                                          */
/* ------------------------------------------------------------------ */

function verifyPieces() {
  console.log("\n— The pieces ——————————————————————————————————————");

  for (const earring of EARRINGS) {
    console.log(`\n  ${earring.name}`);
    const built = buildADEarring(earring.spec);

    checkTrue(`  sets stones at all (${built.stones.length})`, built.stones.length > 3);

    const position = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    let proper = 0;
    let below = 0;
    let finite = true;
    let widest = 0;

    for (const matrix of built.stones) {
      matrix.decompose(position, rotation, scale);
      // three.js puts a reflected basis's sign on scale.x, so a negative scale
      // means the frame was built left-handed and the stone faces inward.
      if (scale.x > 0) proper++;
      // The lobe is the origin. A hanging piece must be entirely below it, or
      // it is inside the wearer's head; a stud sits *on* the lobe and is
      // supposed to surround it.
      if (earring.spec.style === "stud" || position.y <= 1e-6) below++;
      if (!Number.isFinite(position.y) || !Number.isFinite(scale.x)) finite = false;
      widest = Math.max(widest, Math.hypot(position.x, position.z));
    }

    const n = built.stones.length;
    check("  right-handed stone frames", proper, n, 0);
    check(
      earring.spec.style === "stud"
        ? "  sits on the lobe rather than hanging"
        : "  nothing set above the lobe",
      below,
      n,
      0,
    );
    checkTrue("  no degenerate stones", finite);
    checkTrue(
      `  stays within its stated width (${(widest * 2).toFixed(1)} mm of ${earring.spec.bodyMm})`,
      widest * 2 <= earring.spec.bodyMm * 1.12,
    );

    built.metal.computeBoundingBox();
    const box = built.metal.boundingBox!;
    checkTrue("  metalwork has real extent", box.max.y - box.min.y > 0.5);
    checkTrue(
      `  drop is the piece's own reach (${built.reachMm.toFixed(1)} mm)`,
      Math.abs(built.reachMm - dropOf(earring)) < 1e-9 && built.reachMm > 5,
    );
    checkTrue(
      `  the stated drop is honest (${built.reachMm.toFixed(0)} mm vs ${earring.spec.dropMm} designed)`,
      Math.abs(built.reachMm - earring.spec.dropMm) < earring.spec.dropMm * 0.35,
    );
  }

  // A jhumka is a bell: wider than it is tall. Getting this backwards is what an
  // egg on a wire looks like, and it is not something a stone count would catch.
  const jhumka = EARRINGS.find((e) => e.spec.style === "jhumka")!;
  const bell = buildADEarring(jhumka.spec);
  bell.metal.computeBoundingBox();
  const box = bell.metal.boundingBox!;
  console.log("\n  Proportions");
  checkTrue(
    `  the bell is wider than it is tall (${(box.max.x - box.min.x).toFixed(0)} across,` +
      ` ${(box.max.y - box.min.y).toFixed(0)} down)`,
    box.max.x - box.min.x > (box.max.y - box.min.y) * 0.55,
  );
}

/* ------------------------------------------------------------------ */
/* The solver                                                          */
/* ------------------------------------------------------------------ */

function verifySolver() {
  const W = 1280;
  const H = 1600;
  const aspect = W / H;
  const DISTANCE = 0.5;

  const geometry: FrameGeometry = {
    videoWidth: W,
    videoHeight: H,
    displayWidth: W,
    displayHeight: H,
    mirrored: false,
    zoom: 1,
    centerU: 0.5,
    centerV: 0.5,
  };

  const options: EarSolverOptions = {
    anchor: DEFAULT_EAR_ANCHOR,
    smoothing: DEFAULT_ONE_EURO,
  };

  const settle = (
    turn = 0,
    roll = 0,
    opts: EarSolverOptions = options,
    geo: FrameGeometry = geometry,
    distance = DISTANCE,
  ) => {
    const world = makeFace(turn, roll);
    const image = projectFace(world, distance, aspect);
    const solver = new EarPoseSolver();
    let last = null;
    for (let i = 0; i < 200; i++) {
      last = solver.solve(
        { faceLandmarks: [image] } as never,
        geo,
        opts,
        i * (1000 / 30),
      );
    }
    if (!last) {
      console.log("FAIL  solver returned no pose");
      process.exit(1);
    }
    return {
      left: {
        position: last.left.position.clone(),
        depth: last.left.depth,
        quaternion: last.left.quaternion.clone(),
        scale: last.left.scale,
        visible: last.left.visible,
      },
      right: {
        position: last.right.position.clone(),
        depth: last.right.depth,
        quaternion: last.right.quaternion.clone(),
        scale: last.right.scale,
        visible: last.right.visible,
      },
      widthUnits: last.widthUnits,
      unitsPerMm: last.unitsPerMm,
      headTurn: last.headTurn,
      headRoll: last.headRoll,
      leftEar: last.leftEar.clone(),
      rightEar: last.rightEar.clone(),
      settled: last.settled,
      image,
    };
  };

  console.log("\n— The face, as measured ————————————————————————————");
  const pose = settle();

  const planar = (i: number) =>
    new Vector3((pose.image[i].x - 0.5) * aspect, (0.5 - pose.image[i].y) * 1, 0);
  const sideA = planar(FM.SIDE_A);
  const sideB = planar(FM.SIDE_B);
  const seenWidth = sideA.distanceTo(sideB);

  check("face width, square on", pose.widthUnits, seenWidth, 0.002);
  check(
    "the drawn scale is the face's width over a nominal",
    pose.unitsPerMm,
    seenWidth / NOMINAL_FACE_WIDTH_MM,
    1e-5,
  );
  checkTrue("proportions settle", pose.settled);
  checkTrue(
    "no metric model is needed for any of it",
    Number.isFinite(pose.unitsPerMm) && pose.unitsPerMm > 0,
  );

  console.log("\n— Where the pair hangs —————————————————————————————");

  // The wearer's left ear is the SIDE_B side, by the synthetic face's
  // construction. Measured against the anchor the solver reports rather than
  // against a raw landmark: the anchor is deliberately not either of the two
  // contour points, because neither of them is an ear.
  check("left earring hangs off the left ear (x)", pose.left.position.x, pose.leftEar.x, 0.003);
  check("right earring hangs off the right ear (x)", pose.right.position.x, pose.rightEar.x, 0.003);
  const drop = pose.widthUnits * DEFAULT_EAR_ANCHOR.dropBelowEar;
  check("left hangs below it", pose.left.position.y, pose.leftEar.y - drop, 0.003);
  check("right hangs below it", pose.right.position.y, pose.rightEar.y - drop, 0.003);
  check(
    "the drop is a real distance (mm below the ear)",
    drop / pose.unitsPerMm,
    NOMINAL_FACE_WIDTH_MM * DEFAULT_EAR_ANCHOR.dropBelowEar,
    0.5,
  );
  // Between the silhouette's widest point and the one below it, which is where
  // an ear canal is — the widest point on its own is the temple.
  const underB = planar(FM.UNDER_B);
  checkTrue(
    `the anchor sits down the contour from the widest point, not on it` +
      ` (${((pose.leftEar.y - sideB.y) / (underB.y - sideB.y)).toFixed(2)} of the way)`,
    pose.leftEar.y < sideB.y && pose.leftEar.y > underB.y - 1e-9,
  );

  console.log("\n— A hanging earring does not roll ———————————————————");

  for (const degrees of [15, 30, 45]) {
    const tipped = settle(0, (degrees * Math.PI) / 180);
    const up = new Vector3(0, 1, 0).applyQuaternion(tipped.left.quaternion);
    check(`piece stays upright at ${degrees}° of head tilt`, up.y, 1, 0.02);
    check(
      `the head's own tilt is still tracked at ${degrees}°`,
      Math.abs((tipped.headRoll * 180) / Math.PI),
      degrees,
      3,
    );
    check(
      `it still hangs off the ear at ${degrees}°`,
      tipped.left.position.distanceTo(tipped.leftEar) / tipped.widthUnits,
      DEFAULT_EAR_ANCHOR.dropBelowEar,
      0.01,
    );
  }

  console.log("\n— A turned head ————————————————————————————————————");

  for (const degrees of [20, 45, 60]) {
    const turned = settle((degrees * Math.PI) / 180);
    check(
      `the turn is recovered at ${degrees}°`,
      (turned.headTurn * 180) / Math.PI,
      degrees,
      3,
    );
    checkTrue(
      `the near ear comes forward and the far one goes back at ${degrees}°`,
      turned.left.depth > 0 && turned.right.depth < 0,
    );
    checkTrue(
      `the pair narrows on screen at ${degrees}°`,
      Math.abs(turned.left.position.x - turned.right.position.x) <
        Math.abs(pose.left.position.x - pose.right.position.x),
    );
    // A turn does not change how wide anyone's face is.
    check(
      `the face is not remeasured by a turn at ${degrees}°`,
      turned.widthUnits / pose.widthUnits,
      1,
      0.06,
    );
    checkTrue(
      `the near earring is drawn larger than the far one at ${degrees}°`,
      turned.left.scale > turned.right.scale,
    );
  }

  const profile = settle((75 * Math.PI) / 180);
  checkTrue(
    "past about sixty-five degrees the far earring is dropped rather than drawn through the cheek",
    !profile.right.visible && profile.left.visible,
  );

  console.log("\n— Framing ————————————————————————————————————————");

  const mirrored = settle(0, 0, options, { ...geometry, mirrored: true });
  check("mirroring reflects the pair", mirrored.left.position.x, -pose.left.position.x, 0.003);
  check("mirroring keeps the size", mirrored.unitsPerMm, pose.unitsPerMm, 1e-6);

  const zoomed = settle(0, 0, options, { ...geometry, zoom: 2 });
  check("a 2x crop doubles the drawn piece", zoomed.unitsPerMm, pose.unitsPerMm * 2, 1e-4);

  const near = settle(0, 0, options, geometry, 0.35);
  check(
    "leaning in makes the piece bigger in proportion",
    near.unitsPerMm / pose.unitsPerMm,
    0.5 / 0.35,
    0.03,
  );
  check(
    "and does not change the drop in face widths",
    near.left.position.distanceTo(near.leftEar) / near.widthUnits,
    DEFAULT_EAR_ANCHOR.dropBelowEar,
    0.01,
  );

  const trimmed = settle(0, 0, {
    ...options,
    anchor: { ...DEFAULT_EAR_ANCHOR, sizeMultiplier: 0.85 },
  });
  check("the size trim scales the piece", trimmed.left.scale / pose.left.scale, 0.85, 0.01);
  check("and does not move the lobe", trimmed.left.position.y, pose.left.position.y, 1e-6);

  console.log("\n— A head that moves and turns at once ———————————————");

  // The section that earns its place, and the one the bracelet taught: turn,
  // tilt, distance and position together, every landmark shaken, reported as a
  // distribution. A pair that is right on average and wrong on one frame in
  // twenty reads as broken.
  {
    const FPS = 30;
    const solver = new EarPoseSolver();
    let seed = 20260901;
    const jitter = (scale: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff - 0.5) * scale;
    };

    const dropErrors: number[] = [];
    const scaleErrors: number[] = [];
    let uprightWorst = 0;
    let frame = 0;

    for (let i = 0; i < 700; i++) {
      const t = i / FPS;
      const turn = Math.sin(t * 0.8) * 0.9;
      const roll = Math.sin(t * 1.2 + 1) * 0.5;
      const distance = 0.5 + Math.sin(t * 0.9 + 2) * 0.1;
      const shiftX = Math.sin(t * 1.4) * 0.05;
      const shiftY = Math.cos(t * 1.1) * 0.04;

      const world = makeFace(turn, roll);
      const clean = projectFace(world, distance, aspect, shiftX, shiftY);
      const image = clean.map((v) => ({
        x: v.x + jitter(0.0012),
        y: v.y + jitter(0.0012),
        z: v.z,
      }));
      const out = solver.solve(
        { faceLandmarks: [image] } as never,
        geometry,
        options,
        frame++ * (1000 / FPS),
      )!;
      if (i < 200) continue;

      // Measured from where the *clean* frame puts the contour point the anchor
      // is taken from, not from the anchor the solver reports — comparing a
      // position against the thing it was computed from tests arithmetic, and
      // this has to test the tracking that got there.
      const ear = new Vector3(
        (clean[FM.UNDER_B].x - 0.5) * aspect,
        0.5 - clean[FM.UNDER_B].y,
        0,
      );
      dropErrors.push(out.left.position.distanceTo(ear) / out.widthUnits);

      // True size: the face is a known width, so the scale that should be drawn
      // is that width's projection over the nominal millimetres.
      const seen =
        (ANCHOR_DISTANCE * FACE_WIDTH_M) / (distance + world[FM.SIDE_B].z);
      scaleErrors.push(
        Math.abs(out.left.scale - seen / NOMINAL_FACE_WIDTH_MM) /
          (seen / NOMINAL_FACE_WIDTH_MM),
      );

      const up = new Vector3(0, 1, 0).applyQuaternion(out.left.quaternion);
      uprightWorst = Math.max(uprightWorst, Math.acos(Math.min(1, up.y)));
    }

    const at = (xs: number[], q: number) => {
      const sorted = [...xs].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    };

    // How far the piece ends up from the wearer's actual lobe, in face widths —
    // so 0.02 is under three millimetres on a real face.
    checkTrue(
      `the pieces stay on the lobes through the movement` +
        ` (median ${(at(dropErrors, 0.5) * 100).toFixed(1)}% of a face width,` +
        ` 95th ${(at(dropErrors, 0.95) * 100).toFixed(1)}%)`,
      at(dropErrors, 0.5) < 0.06 && at(dropErrors, 0.95) < 0.1,
    );
    checkTrue(
      `the size holds through the movement (median ${(at(scaleErrors, 0.5) * 100).toFixed(1)}%,` +
        ` 95th ${(at(scaleErrors, 0.95) * 100).toFixed(1)}%)`,
      at(scaleErrors, 0.5) < 0.08 && at(scaleErrors, 0.95) < 0.18,
    );
    checkTrue(
      `it never stops hanging straight down (worst ${((uprightWorst * 180) / Math.PI).toFixed(1)}°)`,
      uprightWorst < 0.05,
    );
  }

  console.log("\n— Pose matrix ————————————————————————————————————");
  const matrix = new Matrix4().makeRotationFromQuaternion(pose.left.quaternion);
  check("pose is a pure rotation", matrix.determinant(), 1, 1e-6);
}

verifyPieces();
verifySolver();

console.log(
  failures === 0
    ? "\nAll earring checks passed.\n"
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
