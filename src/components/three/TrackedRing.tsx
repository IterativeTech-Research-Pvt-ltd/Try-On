"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { Group, Mesh } from "three";
import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { fallBackToCpu, getHandLandmarker, GPU_FAILURE_LIMIT } from "@/lib/hand/tracker";
import { RingPoseSolver, type SolverOptions } from "@/lib/hand/ringPose";
import type { FrameGeometry } from "@/lib/hand/projection";
import { MedianTracker } from "@/lib/hand/measure";
import { clearDebugFrame, publishDebugFrame } from "@/lib/hand/debugBus";
import { fixedFraming } from "@/lib/hand/framing";
import { FingerWidthProbe } from "@/lib/hand/fingerProbe";
import { ANCHOR_DISTANCE, videoPixelsToPlaneUnits } from "@/lib/hand/projection";
import { FINGER_CHAINS } from "@/lib/hand/landmarks";
import { circumferenceMmToSize } from "@/lib/rings/sizes";
import { useTryOnStore } from "@/lib/store/tryon";
import type { Ring } from "@/lib/rings/types";
import { Ring3D } from "./Ring3D";
import { BORE_MAX, BORE_MIN, BORE_PRESS, FingerOccluder } from "./FingerOccluder";
import { ContactShadow } from "./ContactShadow";
import { HandOccluder, type HandOccluderHandle } from "./HandOccluder";

/** Frames a hand may go missing before we hide the ring, to ride out dropouts. */
const MISS_GRACE_FRAMES = 6;

/** Publish the size reading about twice a second, not every frame. */
const READING_INTERVAL_MS = 450;

type TrackedRingProps = {
  video: HTMLVideoElement | null;
  ring: Ring;
};

export function TrackedRing({ video, ring }: TrackedRingProps) {
  const groupRef = useRef<Group>(null);
  const occluderRef = useRef<Mesh>(null);
  const shadowRef = useRef<Mesh>(null);
  const handOccluderRef = useRef<HandOccluderHandle | null>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const solver = useMemo(() => new RingPoseSolver(), []);
  const circumference = useMemo(() => new MedianTracker(45), []);
  const probe = useMemo(() => new FingerWidthProbe(), []);
  const silhouette = useRef<number | null>(null);
  const missCount = useRef(0);
  const inferenceFailures = useRef(0);
  const lastVideoTime = useRef(-1);
  const lastLandmarks = useRef<ReadonlyArray<{ x: number; y: number }> | null>(null);
  const lastReadingAt = useRef(0);
  const fpsWindow = useRef({ frames: 0, since: 0 });

  const { size } = useThree();
  const metal = useTryOnStore((s) => s.metal);
  const gem = useTryOnStore((s) => s.gem);
  const setStatus = useTryOnStore((s) => s.setStatus);
  const setFps = useTryOnStore((s) => s.setFps);
  const setReading = useTryOnStore((s) => s.setReading);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading-model");
    getHandLandmarker()
      .then((lm) => {
        if (cancelled) return;
        landmarkerRef.current = lm;
        setStatus("searching");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus(
          "error",
          err instanceof Error ? err.message : "Could not load the hand tracking model.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [setStatus]);

  // Re-seat the filters whenever the target changes, so the ring snaps to the
  // new finger instead of gliding across the hand, and the measurement restarts.
  const finger = useTryOnStore((s) => s.finger);
  const metricBias = useTryOnStore((s) => s.metricBias);
  useEffect(() => {
    solver.reset();
    circumference.reset();
    silhouette.current = null;
  }, [finger, metricBias, solver, circumference]);

  useFrame(() => {
    const group = groupRef.current;
    const occluder = occluderRef.current;
    const shadow = shadowRef.current;
    const landmarker = landmarkerRef.current;
    if (!group || !occluder || !shadow) return;

    if (!landmarker || !video || video.readyState < 2 || video.videoWidth === 0) return;

    // MediaPipe rejects a repeated timestamp, and re-running detection on a
    // frame we have already seen costs a full inference for no new information.
    if (video.currentTime === lastVideoTime.current) return;
    lastVideoTime.current = video.currentTime;

    const now = performance.now();
    const state = useTryOnStore.getState();

    // The crop is fixed, so both layers can derive it from the same store value
    // with nothing to keep in sync frame to frame.
    const framing = fixedFraming(state.zoom);

    const geometry: FrameGeometry = {
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      displayWidth: size.width,
      displayHeight: size.height,
      mirrored: state.mirrored,
      zoom: framing.zoom,
      centerU: framing.centerU,
      centerV: framing.centerV,
    };

    // Read the finger's true width off the pixels. This runs before the solve so
    // the correction applies to the same frame it was measured from.
    const chain = FINGER_CHAINS[state.anchor.finger];
    const raw = lastLandmarks.current;
    if (raw && state.usePixelProbe) {
      const toPx = (i: number) => ({
        x: raw[i].x * video.videoWidth,
        y: raw[i].y * video.videoHeight,
      });
      const measured = probe.measure(video, toPx(chain.mcp), toPx(chain.pip), state.anchor.positionAlongFinger);
      silhouette.current =
        measured && measured.confidence > 0.25
          ? videoPixelsToPlaneUnits(measured.halfWidthPx, geometry)
          : null;
    } else if (!state.usePixelProbe) {
      silhouette.current = null;
    }

    const options: SolverOptions = {
      anchor: state.anchor,
      ringSize: state.ringSize,
      metricBias: state.metricBias,
      autoFit: state.autoFit,
      flipGem: state.flipGem,
      settingFacesCamera: state.settingFacesCamera,
      mirrored: state.mirrored,
      silhouetteHalfWidth: silhouette.current,
      smoothing: state.smoothing,
    };

    let result;
    try {
      result = landmarker.detectForVideo(video, now);
      inferenceFailures.current = 0;
    } catch {
      // A transient inference failure should not kill the render loop — but one
      // that never stops is a GPU delegate this device cannot actually run.
      if (++inferenceFailures.current === GPU_FAILURE_LIMIT) {
        landmarkerRef.current = null;
        fallBackToCpu()?.then((lm) => (landmarkerRef.current = lm)).catch(() => {});
      }
      return;
    }

    let pose = null;
    try {
      lastLandmarks.current = result.landmarks?.[0] ?? null;
      pose = solver.solve(result, geometry, options, now);
    } catch {
      return;
    }

    if (pose) {
      missCount.current = 0;
      group.visible = true;
      group.quaternion.copy(pose.quaternion);

      // Place the band at its real depth, not flat on the anchor plane.
      //
      // The solver reports where the band lands on that plane, plus how far in
      // front of it the finger actually is. Moving an object off the plane under a
      // perspective camera would shift it on screen and change its size, so both
      // are compensated by the same factor — which is just the perspective divide,
      // `(D − z) / D`. The screen position and size therefore come out identical
      // to the flat case, and what is gained is everything depth is *for*: the
      // ring's own near side foreshortens correctly, and it sits in the same 3D
      // space as the hand occluders rather than being special-cased onto z = 0.
      const z = pose.seatDepth;
      const k = (ANCHOR_DISTANCE - z) / ANCHOR_DISTANCE;
      group.position.set(pose.position.x * k, pose.position.y * k, z);
      group.scale.setScalar(pose.ringRadius * k);

      // Everything below lives inside the scaled group, so it is expressed in
      // multiples of the band's inner radius.
      //
      // The bore is circular and just over 1, so the same fraction of the band's
      // thickness survives no matter which way the hand is turned. See
      // FingerOccluder for why an anatomically-shaped ellipse was worse.
      // Nudge the bore toward the finger's measured silhouette, so the band's
      // visible inner edge lands on skin rather than short of it or past it.
      //
      // The authority given to that measurement is deliberately narrow. An
      // unbounded clamp here is what produced the worst regression in this file's
      // history: a probe reading a crease instead of the finger's edge shrank the
      // bore to about half, and once the bore drops below the band's inner radius
      // it stops hiding the far arc *anywhere* — so the whole ring appeared as a
      // flat oval lying on top of the hand. The failure is not gradual, so the
      // range must not straddle 1.
      const silhouetteLocal =
        pose.silhouetteHalfWidth > 0
          ? pose.silhouetteHalfWidth / Math.max(pose.ringRadius, 1e-6)
          : BORE_PRESS;
      const bore = Math.max(BORE_MIN, Math.min(BORE_MAX, silhouetteLocal * 1.01));
      occluder.scale.set(bore, bore, 1);

      // Span the proximal phalanx and no further. A long cylinder centred on the
      // band puts its end cap between the ring and the lens the moment the finger
      // points at the camera, hiding the ring outright — and the rest of the
      // finger is already covered by the tapered hand occluder, which follows the
      // real bends instead of running straight on.
      const phalanxLocal = pose.phalanxLength / Math.max(pose.ringRadius, 1e-6);
      occluder.scale.z = phalanxLocal * 1.06;
      // The band sits at `seat` along the phalanx; the cylinder is centred on
      // its midpoint, so it shifts distally by the difference.
      occluder.position.z = (0.5 - state.anchor.positionAlongFinger) * phalanxLocal;

      // Shifting the *finger* across the band is equivalent to shifting the ring
      // the other way, and doing it here rather than by moving the ring keeps the
      // occlusion consistent with the new position for free. MediaPipe places its
      // joint landmarks nearer the visible knuckle than the true bone axis, so a
      // small correction is sometimes needed to centre the band on the finger.
      occluder.position.y = state.anchor.crossOffset;

      // The shadow stays on the band, where metal meets skin.
      shadow.scale.x = bore * 1.006;
      shadow.scale.y = bore * 1.006;
      shadow.position.y = state.anchor.crossOffset;

      handOccluderRef.current?.update(pose, state.anchor.finger);

      if (state.status !== "tracking") setStatus("tracking");

      // The card calibration reads its scale estimate out of the same mailbox
      // the overlay uses, so it has to be filled during calibration too.
      if (state.showDiagnostics || state.calibratingWithCard) {
        // Screen direction of the finger, straight from the two landmarks the
        // placement is built on.
        const mcpP = pose.planar[chain.mcp];
        const pipP = pose.planar[chain.pip];
        const axisScreen = { x: pipP.x - mcpP.x, y: pipP.y - mcpP.y };
        publishDebugFrame({
          planar: pose.planar as { x: number; y: number }[],
          finger: state.anchor.finger,
          seat: { x: pose.position.x, y: pose.position.y },
          ringRadius: pose.ringRadius,
          fingerRadius: pose.fingerRadius,
          silhouetteHalfWidth: pose.silhouetteHalfWidth,
          widthMm: pose.trueWidthMm,
          usSize: state.reading?.usSize ?? 0,
          planeScale: pose.planeScale,
          facing: pose.facing,
          axisAngleDeg: (Math.atan2(axisScreen.y, axisScreen.x) * 180) / Math.PI,
          tiltDeg: (Math.acos(Math.min(1, Math.max(0, pose.facing))) * 180) / Math.PI,
          ringDiameterMm:
            pose.planeScale > 0
              ? (pose.ringRadius * 2 * 1000) / (pose.planeScale * state.metricBias)
              : 0,
          rotationOffsetDeg: (state.anchor.rotationOffset * 180) / Math.PI,
          stamp: now,
        });
      }

      // --- Size estimation ---------------------------------------------------
      if (pose.trueCircumferenceMm > 0) {
        circumference.push(pose.trueCircumferenceMm);
        if (now - lastReadingAt.current > READING_INTERVAL_MS) {
          lastReadingAt.current = now;
          const median = circumference.value;
          if (median !== null) {
            setReading({
              circumferenceMm: median,
              widthMm: pose.trueWidthMm,
              usSize: circumferenceMmToSize(median),
              spread: circumference.spread ?? 1,
              settled: circumference.settled && (circumference.spread ?? 1) < 0.05,
            });
          }
        }
      }
    } else if (++missCount.current > MISS_GRACE_FRAMES) {
      group.visible = false;
      handOccluderRef.current?.hide();
      clearDebugFrame();
      if (state.status === "tracking") setStatus("searching");
    }

    // Rolling frame-rate readout, refreshed about twice a second.
    const window = fpsWindow.current;
    window.frames++;
    if (now - window.since > 500) {
      setFps(Math.round((window.frames * 1000) / (now - window.since)));
      window.frames = 0;
      window.since = now;
    }
  });

  return (
    <>
      {/* Scene-space, so it can sit at real depths relative to the band. */}
      <HandOccluder ref={handOccluderRef} />
      <group ref={groupRef} visible={false}>
        <FingerOccluder ref={occluderRef} />
        <ContactShadow ref={shadowRef} bandWidth={ring.design.bandWidth} />
        <Ring3D ring={ring} metal={metal} gem={gem ?? undefined} quality="live" />
      </group>
    </>
  );
}
