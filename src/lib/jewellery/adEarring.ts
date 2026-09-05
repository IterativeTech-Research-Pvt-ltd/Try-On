import {
  BufferGeometry,
  CylinderGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  TorusGeometry,
  Vector2,
  Vector3,
} from "three";
import { mergeInto } from "./sweep";

/**
 * American-diamond earrings.
 *
 * Local axes match the frame the ear solver produces, and the origin is the
 * lobe itself:
 *   +X along the ear line   +Y up the frame   +Z out of the ear
 *
 * So everything is modelled *hanging*, from y = 0 downward — which is also how
 * the piece is measured. A pair of earrings is sold by its drop, not by a
 * diameter, and the drop is the one dimension a shopper can check against
 * something they already own.
 *
 * All dimensions in millimetres.
 */
export type ADEarringSpec = {
  style: "jhumka" | "drop" | "stud";
  /** Total hang from the lobe. The piece's headline dimension. */
  dropMm: number;
  /** Diameter of the stone that sits on the lobe itself. */
  topStoneMm: number;
  /** Widest diameter of the body — a bell, a drop or a halo. */
  bodyMm: number;
  /** Diameter of the stones set around the body. */
  accentStoneMm: number;
  /** Beads hanging from a jhumka's rim. Zero for the other two. */
  fringeCount: number;
  fringeStoneMm: number;
  /** Radius of the wire forming links and collets. */
  wireMm: number;
};

/**
 * The jhumka: a domed bell hung from a stud, with a fringe round its rim.
 *
 * The shape earrings mean in the half of the world this catalogue is written
 * for, and the one that most needs real geometry — a bell is a surface of
 * revolution with a flared lip, and no amount of flat card stands in for it once
 * the wearer turns their head.
 */
export const AD_JHUMKA: ADEarringSpec = {
  style: "jhumka",
  dropMm: 34,
  topStoneMm: 4.6,
  bodyMm: 21,
  accentStoneMm: 2.3,
  fringeCount: 24,
  fringeStoneMm: 2.6,
  wireMm: 0.6,
};

/** A single stone falling from a smaller one, on a fine link. */
export const AD_DROP: ADEarringSpec = {
  style: "drop",
  dropMm: 26,
  topStoneMm: 4.2,
  bodyMm: 9,
  accentStoneMm: 1.9,
  fringeCount: 0,
  fringeStoneMm: 0,
  wireMm: 0.5,
};

/** A haloed solitaire that sits on the lobe and does not hang at all. */
export const AD_STUD: ADEarringSpec = {
  style: "stud",
  dropMm: 6,
  topStoneMm: 6,
  bodyMm: 11,
  accentStoneMm: 1.8,
  fringeCount: 0,
  fringeStoneMm: 0,
  wireMm: 0.45,
};

export type ADEarringGeometry = {
  /** Everything drawn in metal. */
  metal: BufferGeometry;
  /** One transform per stone, for a single instanced draw. */
  stones: Matrix4[];
  /** How far the piece actually reaches below the lobe, in millimetres. */
  reachMm: number;
};

/** A stone's transform, with its table facing `out` and its girdle square to it. */
function setStone(
  into: Matrix4[],
  at: Vector3,
  out: Vector3,
  diameterMm: number,
): void {
  const up = Math.abs(out.y) > 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const x = new Vector3().crossVectors(up, out).normalize();
  const z = new Vector3().crossVectors(x, out).normalize().negate();
  const basis = new Matrix4().makeBasis(x, out, z.negate());
  const q = new Quaternion().setFromRotationMatrix(basis);
  const r = diameterMm / 2;
  into.push(new Matrix4().compose(at, q, new Vector3(r, r, r)));
}

/** A ring of stones lying in the horizontal plane, all facing outward. */
function ringOfStones(
  into: Matrix4[],
  centreY: number,
  radius: number,
  count: number,
  diameterMm: number,
  tipDown: number,
): void {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const out = new Vector3(Math.cos(a), -tipDown, Math.sin(a)).normalize();
    const at = new Vector3(
      Math.cos(a) * radius,
      centreY - tipDown * radius * 0.2,
      Math.sin(a) * radius,
    );
    setStone(into, at, out, diameterMm);
  }
}

export function buildADEarring(spec: ADEarringSpec): ADEarringGeometry {
  const parts: BufferGeometry[] = [];
  const stones: Matrix4[] = [];
  const wire = spec.wireMm;

  // ---- the stone on the lobe -------------------------------------------
  // Sits proud of the ear, facing the viewer, with a collet behind it.
  setStone(stones, new Vector3(0, 0, wire * 2), new Vector3(0, 0, 1), spec.topStoneMm);
  const collet = new TorusGeometry(spec.topStoneMm * 0.52, wire * 0.7, 6, 18);
  collet.translate(0, 0, wire * 1.4);
  parts.push(collet);

  if (spec.style === "stud") {
    // A halo, and nothing hangs.
    const haloRadius = spec.bodyMm / 2 - spec.accentStoneMm / 2;
    const count = Math.max(8, Math.round((Math.PI * 2 * haloRadius) / (spec.accentStoneMm * 1.12)));
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      setStone(
        stones,
        new Vector3(Math.cos(a) * haloRadius, Math.sin(a) * haloRadius, wire * 1.6),
        new Vector3(0, 0, 1),
        spec.accentStoneMm,
      );
    }
    const rail = new TorusGeometry(haloRadius, wire * 0.6, 6, 40);
    rail.translate(0, 0, wire);
    parts.push(rail);
    return { metal: mergeInto(parts), stones, reachMm: spec.bodyMm / 2 };
  }

  // ---- the link down to the body ---------------------------------------
  const linkTop = -spec.topStoneMm * 0.55;
  const linkLength = spec.style === "jhumka" ? spec.dropMm * 0.16 : spec.dropMm * 0.28;
  const link = new CylinderGeometry(wire * 0.75, wire * 0.75, linkLength, 8, 1, true);
  link.translate(0, linkTop - linkLength / 2, wire);
  parts.push(link);

  const bodyTop = linkTop - linkLength;

  if (spec.style === "drop") {
    // A single pear falling from the link, in a claw.
    const radius = spec.bodyMm / 2;
    const centre = bodyTop - radius * 1.25;
    setStone(stones, new Vector3(0, centre, wire), new Vector3(0, 0, 1), spec.bodyMm);
    const claw = new TorusGeometry(radius * 0.92, wire * 0.8, 6, 24);
    claw.translate(0, centre, wire * 0.4);
    parts.push(claw);

    // A few accents up the link, so the piece is set rather than plain.
    for (let i = 0; i < 3; i++) {
      const y = linkTop - linkLength * ((i + 0.5) / 3);
      setStone(stones, new Vector3(0, y, wire * 1.8), new Vector3(0, 0, 1), spec.accentStoneMm);
    }
    return { metal: mergeInto(parts), stones, reachMm: -(centre - radius * 1.3) };
  }

  // ---- the jhumka's bell -------------------------------------------------
  //
  // A surface of revolution: a domed shoulder that turns over into a flared
  // lip. Authored as a profile and revolved, because that is what the shape
  // actually is — and because the lip has to read as an edge from the side and
  // as a ring from below.
  // Proportioned off the rim, not the drop. A jhumka is a *bell*: wider than it
  // is tall, with the skirt turning outward at the lip. Taking the height from
  // the overall drop instead made it half as tall again as it was wide, which
  // reads as an egg on a wire — the fringe was doing all the work of saying what
  // the piece was.
  const bellHeight = spec.bodyMm * 0.58;
  const rim = spec.bodyMm / 2;
  const profile: Vector2[] = [];
  const STEPS = 18;
  /** The bell's radius a fraction of the way down it. */
  const bellRadius = (t: number) => {
    // A domed shoulder, then a lip that turns outward over the last stretch.
    // Without the turn the widest point is also the last point and the skirt
    // reads as closing rather than opening.
    const dome = Math.pow(Math.sin((t * Math.PI) / 2), 0.7);
    const flare = t > 0.84 ? 1 + ((t - 0.84) / 0.16) * 0.1 : 1;
    return rim * dome * flare;
  };
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    profile.push(new Vector2(Math.max(0.001, bellRadius(t)), -t * bellHeight));
  }
  // Back up the inside, a hair narrower, so the bell has a wall and its inside
  // is visible from below rather than being an infinitely thin shell.
  for (let i = STEPS; i >= 0; i--) {
    const t = i / STEPS;
    profile.push(new Vector2(Math.max(0.001, bellRadius(t) - wire * 0.9), -t * bellHeight));
  }
  const bell = new LatheGeometry(profile, 48);
  bell.translate(0, bodyTop, 0);
  parts.push(bell);

  // A bright rail round the lip, and the stones set against it.
  const lipY = bodyTop - bellHeight;
  const lip = new TorusGeometry(rim, wire * 1.1, 8, 48);
  lip.rotateX(Math.PI / 2);
  lip.translate(0, lipY, 0);
  parts.push(lip);

  const rimCount = Math.max(10, Math.round((Math.PI * 2 * rim) / (spec.accentStoneMm * 1.15)));
  ringOfStones(stones, lipY + spec.accentStoneMm * 0.5, rim * 0.92, rimCount, spec.accentStoneMm, 0.35);

  // A second, smaller ring up on the shoulder, which is what makes a jhumka
  // read as set rather than as a plain gold bell.
  const shoulderY = bodyTop - bellHeight * 0.42;
  const shoulderR = bellRadius(0.42);
  const shoulderCount = Math.max(8, Math.round((Math.PI * 2 * shoulderR) / (spec.accentStoneMm * 1.2)));
  ringOfStones(stones, shoulderY, shoulderR * 0.95, shoulderCount, spec.accentStoneMm * 0.85, 0.8);

  // ---- the fringe ---------------------------------------------------------
  let lowest = lipY;
  for (let i = 0; i < spec.fringeCount; i++) {
    const a = (i / spec.fringeCount) * Math.PI * 2;
    const hangFrom = new Vector3(Math.cos(a) * rim, lipY, Math.sin(a) * rim);
    const hang = spec.fringeStoneMm * 2.4;
    const bead = hangFrom.clone().setY(lipY - hang);
    setStone(stones, bead, new Vector3(0, 0, 1), spec.fringeStoneMm);

    const thread = new CylinderGeometry(wire * 0.35, wire * 0.35, hang, 5, 1, true);
    thread.translate(hangFrom.x, lipY - hang / 2, hangFrom.z);
    parts.push(thread);
    lowest = Math.min(lowest, bead.y - spec.fringeStoneMm * 0.6);
  }

  return { metal: mergeInto(parts), stones, reachMm: -lowest };
}
