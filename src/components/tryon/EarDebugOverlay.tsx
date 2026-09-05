"use client";

import { useEffect, useRef } from "react";
import { earDebugBus } from "@/lib/face/debugBus";
import { useTryOnStore } from "@/lib/store/tryon";

/**
 * Draws what the earring solver believes, over the video.
 *
 * Built to separate the faults that "it is not on my ears" covers, because they
 * look identical in the finished render and have nothing else in common:
 *
 * - **Blue dots off your ears** — the tracker has not found your head properly,
 *   and nothing downstream can be right. Usually framing or light.
 * - **Blue dots right, gold rings wrong** — the lobe drop is off for your ears.
 *   That is a slider, not a bug: the model marks the notch in front of your ear
 *   canal, and how far below it a lobe hangs varies by person.
 * - **Gold rings right but no jewellery** — the head's stand-in is swallowing the
 *   pair, or the piece is being drawn at the wrong size.
 * - **Nothing at all** — the solve is being refused, which is a different problem
 *   again and says so in words.
 */
export function EarDebugOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const enabled = useTryOnStore((s) => s.showDiagnostics);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);

      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(rect.width * dpr);
      const height = Math.round(rect.height * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.clearRect(0, 0, width, height);

      const frame = earDebugBus.frame;
      if (!frame) {
        ctx.fillStyle = "rgba(255,140,140,0.95)";
        ctx.font = `${12 * dpr}px ui-monospace, monospace`;
        ctx.fillText("no pose — bring your head into frame", 12 * dpr, 24 * dpr);
        return;
      }
      if (performance.now() - frame.stamp > 500) return;

      // Anchor-plane units are normalised by display height with the origin at
      // the centre; undo both to get canvas pixels.
      const toPx = (p: { x: number; y: number }) => ({
        x: p.x * height + width / 2,
        y: height / 2 - p.y * height,
      });

      // The head, as the tracker sees it.
      const le = toPx(frame.ear.left);
      const re = toPx(frame.ear.right);
      ctx.strokeStyle = "rgba(120, 220, 255, 0.55)";
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      ctx.moveTo(le.x, le.y);
      ctx.lineTo(re.x, re.y);
      ctx.stroke();

      ctx.fillStyle = "rgba(120, 220, 255, 0.95)";
      for (const p of [frame.ear.left, frame.ear.right, frame.mouth, frame.nose]) {
        const q = toPx(p);
        ctx.beginPath();
        ctx.arc(q.x, q.y, 3.5 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }

      // The head's depth-only stand-in. If the pair vanishes while the gold
      // rings are in the right place, this is what ate them.
      const centre = toPx(frame.headCentre);
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.ellipse(
        centre.x,
        centre.y,
        (frame.headWidth / 2) * height,
        (frame.headHeight / 2) * height,
        (-frame.headRollDeg * Math.PI) / 180,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      ctx.setLineDash([]);

      // Where each piece was actually hung, and the drop that got it there.
      for (const side of ["left", "right"] as const) {
        const ear = toPx(frame.ear[side]);
        const lobe = toPx(frame.lobe[side]);
        const shown = frame.visible[side];
        ctx.strokeStyle = shown
          ? "rgba(255, 214, 120, 0.95)"
          : "rgba(255, 214, 120, 0.28)";
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.moveTo(ear.x, ear.y);
        ctx.lineTo(lobe.x, lobe.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(lobe.x, lobe.y, 6 * dpr, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      const lines = [
        `head ${frame.headBreadthMm.toFixed(0)} mm ear to ear`,
        `turned ${frame.headTurnDeg.toFixed(0)}°  tilted ${frame.headRollDeg.toFixed(0)}°`,
        `hanging ${frame.dropMm.toFixed(0)} mm below each ear`,
        `showing ${[frame.visible.left && "left", frame.visible.right && "right"].filter(Boolean).join(" + ") || "neither"}`,
      ];
      lines.forEach((line, i) => ctx.fillText(line, 12 * dpr, (44 + i * 15) * dpr));
    };

    draw();
    return () => cancelAnimationFrame(raf);
  }, [enabled]);

  if (!enabled) return null;
  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-10 h-full w-full"
    />
  );
}
