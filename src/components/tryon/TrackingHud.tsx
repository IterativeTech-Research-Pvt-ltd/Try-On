"use client";

import { useEffect, useState } from "react";
import { useTryOnStore, type TrackingStatus, type TryOnMode } from "@/lib/store/tryon";

const TONE: Record<TrackingStatus, string | null> = {
  idle: null,
  denied: null,
  error: "bg-red-400",
  "requesting-camera": "bg-neutral-500",
  "loading-model": "bg-amber-300",
  searching: "bg-amber-300",
  tracking: "bg-emerald-400",
};

/**
 * What to say while waiting, which depends on what is being tracked.
 *
 * The copy here was fixed and hand-specific — "Show your hand to the camera" — so in
 * necklace mode it asked for the wrong body part, and any detail the tracker had
 * about *why* it was waiting was thrown away. That mattered more than it sounds: a
 * necklace that never appears has several unrelated causes, and the only thing
 * separating them was a message this component was discarding.
 */
function waitingCopy(status: TrackingStatus, mode: TryOnMode, detail?: string) {
  if (detail) return detail;
  if (status === "loading-model") {
    return mode === "necklace" || mode === "earring"
      ? "Loading pose tracking"
      : "Loading hand tracking";
  }
  if (status === "searching") {
    if (mode === "necklace") {
      return "Sit back until your head and both shoulders are in frame";
    }
    if (mode === "earring") return "Bring your head into the frame";
    // The bracelet is tracked from the hand too — there is no forearm landmark —
    // so asking for the wrist alone would have someone hold up something the
    // model cannot see.
    return mode === "bracelet"
      ? "Show your hand and wrist to the camera"
      : "Show your hand to the camera";
  }
  if (status === "requesting-camera") return "Waiting for camera";
  return "Tracking";
}

export function TrackingHud({ onCapture }: { onCapture: () => string | null }) {
  const status = useTryOnStore((s) => s.status);
  const detail = useTryOnStore((s) => s.errorMessage);
  const mode = useTryOnStore((s) => s.mode);
  const fps = useTryOnStore((s) => s.fps);
  const showDiagnostics = useTryOnStore((s) => s.showDiagnostics);
  const [shot, setShot] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  const tone = TONE[status];
  const label = waitingCopy(status, mode, status === "tracking" ? undefined : detail ?? undefined);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(false), 180);
    return () => clearTimeout(id);
  }, [flash]);

  const handleCapture = () => {
    const data = onCapture();
    if (!data) return;
    setShot(data);
    setFlash(true);
  };

  return (
    <>
      {flash && <div className="pointer-events-none absolute inset-0 z-30 bg-white/80" />}

      {tone && (
        <div className="pointer-events-none absolute left-4 top-4 z-20 flex max-w-[85%] items-center gap-2 rounded-full bg-neutral-950/70 px-3 py-1.5 text-xs text-neutral-200 backdrop-blur">
          <span className={`size-1.5 shrink-0 rounded-full ${tone} ${status === "tracking" ? "" : "animate-pulse"}`} />
          {label}
          {showDiagnostics && status === "tracking" && (
            <span className="ml-1 tabular-nums text-neutral-500">{fps} fps</span>
          )}
        </div>
      )}

      {status === "tracking" && (
        <button
          type="button"
          onClick={handleCapture}
          aria-label="Take a photo"
          className="absolute bottom-5 left-1/2 z-20 -translate-x-1/2 rounded-full border-2 border-white/80 bg-white/25 p-1 backdrop-blur transition hover:bg-white/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <span className="block size-11 rounded-full bg-white" />
        </button>
      )}

      {shot && (
        <div className="absolute bottom-5 right-4 z-20 flex flex-col items-end gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL from the canvas, not an asset next/image can optimise */}
          <img
            src={shot}
            alt="Your try-on"
            className="h-24 w-auto rounded-xl border border-white/25 shadow-lg"
          />
          <div className="flex gap-2">
            <a
              href={shot}
              download="ring-tryon.png"
              className="rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-neutral-900 transition hover:bg-white"
            >
              Save
            </a>
            <button
              type="button"
              onClick={() => setShot(null)}
              className="rounded-full bg-neutral-950/70 px-3 py-1 text-xs text-neutral-200 backdrop-blur transition hover:bg-neutral-950"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </>
  );
}
