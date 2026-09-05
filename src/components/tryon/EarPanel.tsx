"use client";

import { dropOf, type Earring } from "@/lib/jewellery/earrings";
import { useTryOnStore } from "@/lib/store/tryon";

/**
 * The earring panel.
 *
 * Deliberately shorter than the other three, because there is no fitting
 * question to answer. A ring, a bracelet and a necklace all have to be *sized*
 * to the wearer and the panel's job is to keep "what size am I" apart from "what
 * size am I looking at". A 28 mm jhumka is 28 mm on everybody — so what a
 * shopper wants here is the drop, in a number they can hold against a pair they
 * already own, and confirmation that the tracker can actually see their ears.
 */
export function EarPanel({ earring }: { earring: Earring }) {
  const reading = useTryOnStore((s) => s.earReading);
  const drop = dropOf(earring);
  // Past this the far ear is behind the head and its earring is only occasionally
  // in view, which is worth saying rather than leaving to look like a fault.
  const turnedAway = reading ? Math.abs(reading.headTurnDeg) > 40 : false;

  return (
    <div className="space-y-4 rounded-2xl border border-line bg-surface-muted/40 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
          Drop
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

      <div>
        <span className="font-display text-4xl tabular-nums">{drop.toFixed(0)} mm</span>
        <p className="mt-1 text-xs text-muted">
          below the lobe · drawn at true size, so it hangs the same length on
          everyone
        </p>
      </div>

      <div className="rule" />

      {reading ? (
        <>
          <p className="text-xs text-muted">
            Placed from your face&rsquo;s own silhouette, whose widest points sit
            at the notch in front of your ear canal — a lobe hangs a couple of
            centimetres below that, so the drop is a proportion rather than
            something the camera can see. If it is sitting above or below your
            lobes, <span className="text-foreground">How far below the ear</span>{" "}
            in Placement &amp; tracking is the one to move.
          </p>
          {turnedAway && (
            <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
              Turned {Math.abs(reading.headTurnDeg).toFixed(0)}° away — the far
              earring is behind your head, so only one is showing.
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted">
          Face the camera with your head in frame and both ears visible.
        </p>
      )}
    </div>
  );
}
