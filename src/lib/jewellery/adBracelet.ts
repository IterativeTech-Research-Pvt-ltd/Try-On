import {
  BufferGeometry,
  CatmullRomCurve3,
  Matrix4,
  Quaternion,
  TorusGeometry,
  Vector3,
} from "three";
import { mergeInto, ribbonProfile, sweepProfile } from "./sweep";
import { WRIST_DEPTH_RATIO } from "./wristFit";

/**
 * An American-diamond bracelet: a band of colourless stones set solid the whole
 * way round the wrist.
 *
 * "American diamond" is cubic zirconia, and as with the collar what defines the
 * style is not the stone but the density — an AD piece leaves as little metal
 * showing as it can. On a bracelet that has a second consequence, and it is the
 * one this file is built around: the setting has to continue through 360
 * degrees. A wrist rotates freely and constantly, so any piece with a decorated
 * front and a plain back spends half its time showing the back. Every row here
 * closes on itself, which is why the stone counts are derived from the band's
 * own perimeter rather than being fixed numbers.
 *
 * All dimensions in millimetres. Local axes match the wrist pose frame:
 *   +X across the wrist    +Y out the back of the hand    +Z up the forearm
 *
 * So the band lies in the XY plane and its width runs along Z — the same
 * convention the ring's band uses, where the finger passes through along +Z.
 */

export type ADBraceletSpec = {
  /** Width of the band along the forearm. */
  bandWidthMm: number;
  /** Radial thickness of the metal the stones are set into. */
  baseThicknessMm: number;
  /** Radius of the wire forming the band's two edge rails. */
  railWireMm: number;
  /** Diameter of the stones in the main row. */
  mainStoneMm: number;
  /**
   * Diameter of the stones in the rows either side of the main one, or 0 for a
   * single-row piece. A classic tennis bracelet is one row; a heavier AD band is
   * three.
   */
  accentStoneMm: number;
  /** Gap between neighbouring stones, as a fraction of their diameter. */
  stoneGap: number;
  /** Whether the main row's stones each sit in their own collet. */
  colletted: boolean;
};

/** The classic line bracelet: one row of generous stones, edge to edge. */
export const AD_TENNIS: ADBraceletSpec = {
  bandWidthMm: 5.6,
  baseThicknessMm: 0.85,
  railWireMm: 0.5,
  mainStoneMm: 4.4,
  accentStoneMm: 0,
  stoneGap: 0.06,
  colletted: true,
};

/**
 * The heavy cut: three rows across a 9 mm band.
 *
 * Wide on purpose. Over live video the whole bracelet is a couple of hundred
 * pixels across, and a delicate piece at that size is a grey line — the same
 * reasoning that made the collar bridal-weight.
 */
export const AD_PAVE_BAND: ADBraceletSpec = {
  bandWidthMm: 9.2,
  baseThicknessMm: 1,
  railWireMm: 0.62,
  mainStoneMm: 4,
  accentStoneMm: 2.1,
  stoneGap: 0.05,
  colletted: true,
};

export type ADBraceletGeometry = {
  /** Everything drawn in metal: the base band, both rails and the collets. */
  metal: BufferGeometry;
  /** One transform per stone, ready for a single instanced draw. */
  stones: Matrix4[];
  /** Where each stone sits round the band, in radians. Used by the checks. */
  stoneAngles: number[];
  /** Inner semi-axes of the band, in millimetres — what the arm fills. */
  innerSemiMajorMm: number;
  innerSemiMinorMm: number;
  /** Furthest the piece reaches from the wrist's axis, for the contact shadow. */
  outerSemiMajorMm: number;
};

/** How many points the band's path is sampled at before it is swept. */
const PATH_SAMPLES = 128;

/** Segments along the band for the swept metalwork. */
const SWEEP_SEGMENTS = 176;

/**
 * The band's path at a given radial offset and position across the width.
 *
 * Offsetting an ellipse by moving both semi-axes is not its true parallel curve,
 * but the offsets here are under a millimetre against a thirty-millimetre axis,
 * where the two differ by well under a tenth of a millimetre. Modelling the
 * exact offset curve would cost an arc-length solve per row for nothing anyone
 * could see.
 */
function bandPath(semiMajor: number, semiMinor: number, z: number): CatmullRomCurve3 {
  const points: Vector3[] = [];
  for (let i = 0; i < PATH_SAMPLES; i++) {
    const t = (i / PATH_SAMPLES) * Math.PI * 2;
    points.push(new Vector3(Math.cos(t) * semiMajor, Math.sin(t) * semiMinor, z));
  }
  return new CatmullRomCurve3(points, true, "centripetal");
}

/**
 * Outward normal of the ellipse at a point lying on it.
 *
 * Not simply the direction from the centre: on an ellipse those differ, and by
 * enough to matter — using the radial direction instead tips every stone at the
 * flanks of the wrist a few degrees off the surface it is set into, which shows
 * up as a row that visibly lifts away from the metal at the sides.
 */
function outwardAt(
  point: Vector3,
  semiMajor: number,
  semiMinor: number,
  out: Vector3,
): Vector3 {
  return out
    .set(point.x / (semiMajor * semiMajor), point.y / (semiMinor * semiMinor), 0)
    .normalize();
}

/** A frame on the band: along it, out of it, and across its width. */
function frameAt(
  curve: CatmullRomCurve3,
  u: number,
  semiMajor: number,
  semiMinor: number,
): { point: Vector3; along: Vector3; outward: Vector3; across: Vector3 } {
  const point = curve.getPointAt(u, new Vector3());
  const along = curve.getTangentAt(u, new Vector3()).normalize();
  const outward = outwardAt(point, semiMajor, semiMinor, new Vector3());
  const across = new Vector3().crossVectors(along, outward).normalize();
  return { point, along, outward, across };
}

/**
 * How many stones of this size fit round a row, from the row's own measured
 * length rather than a fixed number.
 *
 * A larger wrist therefore gets more stones instead of larger ones, which is how
 * a real piece is made, and what keeps a 4 mm stone reading as 4 mm on every
 * wearer. The collets read the same count, so they land under the same stones.
 */
function rowCount(curve: CatmullRomCurve3, stoneMm: number, gap: number): number {
  return Math.max(8, Math.floor(curve.getLength() / (stoneMm * (1 + gap))));
}

/** Lays one closed row of stones round the band. */
function layRow(
  semiMajor: number,
  semiMinor: number,
  z: number,
  stoneMm: number,
  gap: number,
  into: { stones: Matrix4[]; angles: number[] },
): void {
  if (stoneMm <= 0) return;

  const curve = bandPath(semiMajor, semiMinor, z);
  const count = rowCount(curve, stoneMm, gap);

  const basis = new Matrix4();
  const spin = new Quaternion();
  const scale = new Vector3(stoneMm / 2, stoneMm / 2, stoneMm / 2);

  for (let i = 0; i < count; i++) {
    // Half-step offsets so no row starts with a stone exactly on the axis, which
    // would line all three rows up into a visible seam at the same spot.
    const u = (i + 0.5) / count;
    const f = frameAt(curve, u, semiMajor, semiMinor);

    // The stone is authored with its girdle in XZ and its table facing +Y, so
    // its +Y has to become the band's outward normal.
    basis.makeBasis(f.along, f.outward, f.across);
    spin.setFromRotationMatrix(basis);

    into.stones.push(new Matrix4().compose(f.point, spin, scale));
    into.angles.push(Math.atan2(f.point.y, f.point.x));
  }
}

export function buildADBracelet(
  spec: ADBraceletSpec,
  innerSemiMajorMm: number,
): ADBraceletGeometry {
  const a = innerSemiMajorMm;
  const b = a * WRIST_DEPTH_RATIO;
  const half = spec.bandWidthMm / 2;
  const base = spec.baseThicknessMm;

  // ---- metalwork -------------------------------------------------------
  // The base is a flattened tube: as wide as the band and only as thick as the
  // metal under the stones. Without it you would see skin through every gap
  // between two stones, which is what makes a set band look like loose stones
  // floating over an arm rather than one piece.
  const parts: BufferGeometry[] = [
    sweepProfile(
      bandPath(a + base / 2, b + base / 2, 0),
      ribbonProfile(half, base / spec.bandWidthMm, 20),
      SWEEP_SEGMENTS,
      true,
    ),
  ];

  // Rails along both edges, standing a little proud of the base. They are the
  // channel the stones sit in, and the bright line that reads as the edge of the
  // piece when the band turns away from the light.
  const railRadius = spec.railWireMm;
  const railZ = half - railRadius * 0.5;
  const railLift = base * 0.75;
  for (const z of [railZ, -railZ]) {
    parts.push(
      sweepProfile(
        bandPath(a + railLift, b + railLift, z),
        ribbonProfile(railRadius, 0.92, 10),
        SWEEP_SEGMENTS,
        true,
      ),
    );
  }

  // ---- stones ----------------------------------------------------------
  // Girdles sit just above the base's outer surface, so the pavilion is buried
  // in the metal and only the crown stands out — set into the band, not stuck
  // onto it.
  const girdleLift = base + spec.mainStoneMm * 0.08;
  const laid = { stones: [] as Matrix4[], angles: [] as number[] };

  layRow(a + girdleLift, b + girdleLift, 0, spec.mainStoneMm, spec.stoneGap, laid);

  if (spec.accentStoneMm > 0) {
    const accentLift = base + spec.accentStoneMm * 0.08;
    const accentZ = half - railRadius - spec.accentStoneMm * 0.6;
    for (const z of [accentZ, -accentZ]) {
      layRow(
        a + accentLift,
        b + accentLift,
        z,
        spec.accentStoneMm,
        spec.stoneGap,
        laid,
      );
    }
  }

  // ---- collets ---------------------------------------------------------
  // A ring of metal under each main stone. On the collar these are what stopped
  // the clusters reading as stones resting on a flat band; the same is true of a
  // line bracelet seen close up.
  if (spec.colletted) {
    const stoneRadius = spec.mainStoneMm / 2;
    const curve = bandPath(a + girdleLift, b + girdleLift, 0);
    const count = rowCount(curve, spec.mainStoneMm, spec.stoneGap);
    const place = new Matrix4();

    for (let i = 0; i < count; i++) {
      const f = frameAt(curve, (i + 0.5) / count, a + girdleLift, b + girdleLift);
      const collet = new TorusGeometry(stoneRadius * 1.04, stoneRadius * 0.15, 6, 16);
      // A torus lies in its own XY plane with its axis on +Z, so the basis puts
      // that axis onto the band's outward normal.
      place.makeBasis(f.across, f.along, f.outward).setPosition(
        f.point.clone().addScaledVector(f.outward, -stoneRadius * 0.12),
      );
      collet.applyMatrix4(place);
      parts.push(collet);
    }
  }

  // The crown of a brilliant stands about a third of its girdle radius proud.
  const outer = a + girdleLift + spec.mainStoneMm * 0.16;

  return {
    metal: mergeInto(parts),
    stones: laid.stones,
    stoneAngles: laid.angles,
    innerSemiMajorMm: a,
    innerSemiMinorMm: b,
    outerSemiMajorMm: outer,
  };
}
