/**
 * Wrist anthropometry and bracelet sizing.
 *
 * A bracelet is sized by the *inner circumference* of the band, not by any scale
 * with a name — there is no bracelet equivalent of a US ring size in common use,
 * and the number people are quoted in a shop is millimetres round the wrist. So
 * everything here is in millimetres, and the one derived quantity is the "fitting
 * diameter": the circumference divided by pi, which is what a bangle's diameter
 * would be if the wrist were round.
 *
 * It is not round, and that is the other half of this file. A wrist is markedly
 * flatter front-to-back than it is wide, and a bracelet worn on it takes that
 * section — so a circular band drawn at the right circumference is visibly too
 * deep from the side and too narrow from the front. Every dimension here is
 * therefore a pair: a breadth across the wrist and a depth through it.
 */

/**
 * Wrist breadth as a fraction of the span between the index and pinky knuckles.
 *
 * The hand model has no landmark on the forearm, so the wrist cannot be measured
 * directly — there is nothing to measure *between*. What it does give reliably is
 * the knuckle span, and wrist breadth tracks it closely across adults: roughly
 * 61 mm of wrist to a 73 mm span for a large hand, 53 to 63 for a small one,
 * which is the same ratio to within a percent.
 *
 * Note this is the span between landmark *centres*, not the anthropometric hand
 * breadth, which includes the soft tissue outside both knuckles and so is around
 * 15 mm larger. Using the published hand-breadth ratio against this span is a
 * mistake worth naming, because it undersizes every bracelet by a tenth.
 */
export const WRIST_BREADTH_RATIO = 0.84;

/** Wrist depth (back to palm) over wrist breadth (thumb side to little side). */
export const WRIST_DEPTH_RATIO = 0.74;

/**
 * How much more a tape reads round a wrist than the ellipse through the same two
 * axes.
 *
 * A wrist is not an ellipse: the two styloid prominences stand out at the sides,
 * and a tape bridges between them rather than following the curve. Ignoring that
 * reports every wrist about four percent under, which is the difference between a
 * number a shopper can check against their own tape and one they cannot.
 *
 * It applies to the *reported* measurement only. The band still follows the
 * ellipse, because that is the shape it actually sits on.
 */
export const WRIST_GIRTH_FACTOR = 1.045;

/**
 * How much larger than the wrist the band's inner surface is drawn.
 *
 * A tennis bracelet is clasped rather than pushed over the hand, so it hugs —
 * this is skin clearance and the thickness of the clasp, not the room a rigid
 * bangle needs to pass the knuckles.
 */
export const WEAR_CLEARANCE = 1.04;

/**
 * The depth-only forearm stand-in, expressed in the band's own inner semi-axes.
 *
 * `press` must stay above 1, for the reason set out at length in FingerOccluder:
 * the occluder only hides the band's far arc where it actually covers it, so an
 * occluder even slightly *inside* the band stops hiding the far arc anywhere and
 * the bracelet reads as a flat hoop lying on the arm. There is no graceful
 * degradation through that point, so the arm is always modelled as filling the
 * band it was sized to.
 */
export const WRIST_OCCLUDER = {
  press: 1.008,
  /** Length along the forearm, in inner semi-major axes. */
  length: 3.6,
  /**
   * How far up the forearm from the band the cylinder is centred, in semi-major
   * axes. Deliberately lopsided: the arm continues toward the elbow
   * indefinitely, whereas a couple of centimetres the other way is already the
   * palm, and past that the fingers.
   */
  rise: 0.5,
} as const;

/** Ramanujan's approximation for the perimeter of an ellipse. */
export function ellipsePerimeter(semiMajor: number, semiMinor: number): number {
  const sum = semiMajor + semiMinor;
  if (sum <= 0) return 0;
  const h = ((semiMajor - semiMinor) / sum) ** 2;
  return Math.PI * sum * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/** What a tape would read round a wrist of the given breadth. */
export function wristCircumferenceMm(breadthMm: number): number {
  const ellipse = ellipsePerimeter(breadthMm / 2, (breadthMm * WRIST_DEPTH_RATIO) / 2);
  return ellipse * WRIST_GIRTH_FACTOR;
}

/**
 * The semi-major axis of a band whose inner circumference is `pi x diameterMm`.
 *
 * The inverse of the above, and the reason bracelet sizes convert cleanly at all:
 * an ellipse of a fixed aspect scales linearly, so its perimeter is its
 * semi-major axis times a constant, and that constant is the perimeter of the
 * unit case.
 */
export function semiMajorForDiameterMm(diameterMm: number): number {
  const unit = ellipsePerimeter(1, WRIST_DEPTH_RATIO);
  return (Math.PI * diameterMm) / unit;
}

/** Fitting diameter of a band drawn at this semi-major axis. */
export function diameterMmForSemiMajor(semiMajorMm: number): number {
  return (semiMajorMm * ellipsePerimeter(1, WRIST_DEPTH_RATIO)) / Math.PI;
}

/**
 * The stock range, as inner fitting diameters.
 *
 * Worth reading alongside `wristCircumferenceMm`, because the two nearly
 * cancel: the band is drawn `WEAR_CLEARANCE` outside the wrist's ellipse, and
 * a tape reads `WRIST_GIRTH_FACTOR` more than that ellipse, so `pi x diameter`
 * comes out within half a percent of what someone measures with a tape. That is
 * a coincidence of two independent corrections rather than a design, but it is
 * why the panel can quote one "mm around" figure without qualifying it.
 */
export const MIN_DIAMETER_MM = 44; // ~138 mm around, a very small wrist
export const MAX_DIAMETER_MM = 66; // ~207 mm around, a large one
export const DEFAULT_DIAMETER_MM = 56; // ~176 mm around, an adult average

/** Bracelets are stocked in even millimetres, so a measurement snaps to one. */
export function snapToStockDiameter(diameterMm: number): number {
  const snapped = Math.round(diameterMm / 2) * 2;
  return Math.min(MAX_DIAMETER_MM, Math.max(MIN_DIAMETER_MM, snapped));
}

export const STOCK_DIAMETERS_MM: number[] = Array.from(
  { length: (MAX_DIAMETER_MM - MIN_DIAMETER_MM) / 2 + 1 },
  (_, i) => MIN_DIAMETER_MM + i * 2,
);

export type WristLabel = "XS" | "S" | "M" | "L" | "XL";

const LABELS: [number, WristLabel][] = [
  [48, "XS"],
  [51, "S"],
  [56, "M"],
  [61, "L"],
  [Infinity, "XL"],
];

export function diameterMmToLabel(diameterMm: number): WristLabel {
  for (const [max, label] of LABELS) if (diameterMm <= max) return label;
  return "XL";
}
