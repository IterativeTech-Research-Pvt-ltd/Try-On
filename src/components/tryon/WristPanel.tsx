"use client";

import {
  STOCK_DIAMETERS_MM,
  diameterMmToLabel,
  snapToStockDiameter,
} from "@/lib/jewellery/wristFit";
import { useTryOnStore } from "@/lib/store/tryon";
import { Field, Toggle } from "./controls";

/**
 * The bracelet sizing panel.
 *
 * The same two questions the ring's panel keeps apart — *what size am I* and
 * *what size am I looking at* — with one honest difference that belongs on
 * screen rather than buried in a solver: the wrist is never measured directly.
 * The hand model has no landmark on the forearm, so the number here is derived
 * from the wearer's hand and a population ratio, and it is worth saying so.
 */
export function WristPanel() {
  const reading = useTryOnStore((s) => s.braceletReading);
  const diameterMm = useTryOnStore((s) => s.braceletDiameterMm);
  const autoFit = useTryOnStore((s) => s.braceletAutoFit);
  const source = useTryOnStore((s) => s.calibrationSource);
  const setDiameterMm = useTryOnStore((s) => s.setBraceletDiameterMm);
  const setAutoFit = useTryOnStore((s) => s.setBraceletAutoFit);

  // Both numbers are inner circumferences, so comparing them says exactly what a
  // shopper wants to know: is the piece on screen the one that would fit.
  const fitDiameter = reading ? snapToStockDiameter(reading.fittingDiameterMm) : null;
  const looseness = fitDiameter === null ? null : diameterMm - fitDiameter;

  return (
    <div className="space-y-5 rounded-2xl border border-line bg-surface-muted/40 p-5">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
            Measured from your hand
          </p>
          {reading && (
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                reading.settled
                  ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                  : "border-amber-500/40 text-amber-600 dark:text-amber-400"
              }`}
            >
              {reading.settled ? "Steady" : "Settling"}
            </span>
          )}
        </div>

        {reading ? (
          <div className="mt-2">
            <span className="font-display text-4xl tabular-nums">
              {reading.circumferenceMm.toFixed(0)} mm
            </span>
            <p className="mt-1 text-xs text-muted">
              round your wrist · {reading.widthMm.toFixed(0)} mm across · size{" "}
              {diameterMmToLabel(reading.fittingDiameterMm)}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Taken from the span across your knuckles, because the hand tracker
              has no landmark on the forearm — there is nothing below the wrist
              for it to measure between. Your wrist is a fixed proportion of that
              span, so the estimate is steady even when your hand turns.
            </p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">
            Hold your hand steady with the whole palm in frame for a couple of
            seconds.
          </p>
        )}

        {source === "none" && (
          <p className="mt-3 text-xs leading-relaxed text-muted">
            A camera alone cannot tell how big your hand is, so this assumes
            average proportions. Calibrating with a bank card on the Rings tab
            corrects it — the correction is the same one, and it carries across.
          </p>
        )}
      </div>

      <div className="rule" />

      <Field
        label={`Showing ${diameterMm} mm · ${diameterMmToLabel(diameterMm)}`}
        hint={
          <span className="text-muted">
            {Math.round(Math.PI * diameterMm)} mm around
          </span>
        }
      >
        <select
          value={diameterMm}
          onChange={(e) => setDiameterMm(Number(e.target.value))}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm"
        >
          {STOCK_DIAMETERS_MM.map((d) => (
            <option key={d} value={d}>
              {d} mm across — {Math.round(Math.PI * d)} mm around ·{" "}
              {diameterMmToLabel(d)}
            </option>
          ))}
        </select>
      </Field>

      <Toggle
        label="Always fit my wrist"
        hint={
          autoFit
            ? "The bracelet is drawn at the size that fits you, so it always sits right."
            : "The bracelet is drawn at its true size, so you can see how it would sit."
        }
        checked={autoFit}
        onChange={() => setAutoFit(!autoFit)}
      />

      {!autoFit && looseness !== null && (
        <p
          className={`text-xs ${
            Math.abs(looseness) <= 2
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-amber-600 dark:text-amber-400"
          }`}
        >
          {Math.abs(looseness) <= 2
            ? "This size matches your wrist."
            : looseness > 0
              ? `About ${looseness} mm loose — it will slide down over your hand.`
              : `About ${Math.abs(looseness)} mm tight — it will not close.`}
        </p>
      )}
    </div>
  );
}
