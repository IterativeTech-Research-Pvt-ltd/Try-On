"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { Group, Mesh } from "three";
import type { HandLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import { fallBackToCpu, getHandLandmarker, GPU_FAILURE_LIMIT } from "@/lib/hand/tracker";
import { getPoseLandmarker } from "@/lib/neck/tracker";
import { ForearmTracker } from "@/lib/hand/forearm";
import { WristPoseSolver, type WristSolverOptions } from "@/lib/hand/wristPose";
import { projectToAnchorPlane, type FrameGeometry } from "@/lib/hand/projection";
import { fixedFraming } from "@/lib/hand/framing";
import { WRIST_DEPTH_RATIO, WRIST_OCCLUDER } from "@/lib/jewellery/wristFit";
import { useTryOnStore } from "@/lib/store/tryon";
import type { MetalId } from "@/lib/rings/types";
import type { Bracelet } from "@/lib/jewellery/bracelets";
import { ADBracelet3D } from "./ADBracelet3D";
import { WristOccluder } from "./WristOccluder";
import { ContactShadow } from "./ContactShadow";

/** Frames a hand may go missing before the piece is hidden, to ride out dropouts. */
const MISS_GRACE_FRAMES = 6;

/** Publish the size reading about twice a second, not every frame. */
const READING_INTERVAL_MS = 450;

/**
 * Run the pose model on one frame in this many.
 *
 * It is only asked for the direction of a forearm, which swings far slower than
 * a hand twitches, and the answer is heavily smoothed on the way in. Every third
 * frame keeps the second model's cost to a third while losing nothing anyone can
 * see — and this is the only mode that runs two models at once.
 */
const POSE_EVERY = 3;

/**
 * How far the measured wrist has to move before the band is rebuilt, in
 * millimetres of semi-major axis.
 *
 * Laying a hundred and seventy stones is not something to redo thirty times a
 * second, and a wrist does not change size — so the measurement is published to
 * the store with a dead band and the rows are re-laid only when it moves by
 * enough to see. Half a millimetre on a thirty-millimetre axis is under two
 * percent, which is below what anyone can pick out on a moving preview.
 */
const REBUILD_STEP_MM = 0.5;

/**
 * Where the contact shadow sits relative to the arm, as a multiple of the
 * occluder. Just outside it, so the sleeve's front half survives to darken the
 * skin and its back half is correctly hidden behind the arm.
 */
const SHADOW_CLEARANCE = 1.006;

export function TrackedBracelet({
  video,
  metal,
  bracelet,
}: {
  video: HTMLVideoElement | null;
  metal: MetalId;
  bracelet: Bracelet;
}) {
  const groupRef = useRef<Group>(null);
  const occluderRef = useRef<Mesh>(null);
  const shadowRef = useRef<Mesh>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const poseRef = useRef<PoseLandmarker | null>(null);
  const solver = useMemo(() => new WristPoseSolver(), []);
  const forearm = useMemo(() => new ForearmTracker(), []);
  const poseTick = useRef(0);
  const wristPlane = useRef({ x: 0, y: 0 });
  const missCount = useRef(0);
  const inferenceFailures = useRef(0);
  const lastVideoTime = useRef(-1);
  const lastReadingAt = useRef(0);
  const fpsWindow = useRef({ frames: 0, since: 0 });

  const { size } = useThree();
  const semiMajorMm = useTryOnStore((s) => s.braceletSemiMajorMm);
  const setSemiMajorMm = useTryOnStore((s) => s.setBraceletSemiMajorMm);
  const setBraceletReading = useTryOnStore((s) => s.setBraceletReading);
  const setStatus = useTryOnStore((s) => s.setStatus);
  const setFps = useTryOnStore((s) => s.setFps);

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

  /**
   * The pose model, for the elbow — and deliberately not blocking.
   *
   * A bracelet is placed from the hand and merely *corrected* by the forearm, so
   * a pose model that is slow to load, or missing altogether, must cost the
   * wearer a bent-wrist correction and nothing else. Tying the piece's
   * appearance to it would trade a placement that is sometimes off for one that
   * is sometimes absent, which is the worse of the two.
   */
  useEffect(() => {
    let cancelled = false;
    getPoseLandmarker()
      .then((lm) => {
        if (!cancelled) poseRef.current = lm;
      })
      .catch((err: unknown) => {
        console.warn(
          "[bracelet] no pose model, so a bent wrist will seat the band off the " +
            "forearm's real axis",
          err,
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A recalibration changes what every millimetre means, so the measurement
  // restarts rather than being averaged across the change.
  const metricBias = useTryOnStore((s) => s.metricBias);
  useEffect(() => {
    solver.reset();
    forearm.reset();
  }, [metricBias, solver, forearm]);

  useFrame(() => {
    const group = groupRef.current;
    const occluder = occluderRef.current;
    const shadow = shadowRef.current;
    const landmarker = landmarkerRef.current;
    if (!group || !occluder || !shadow) return;
    if (!landmarker || !video || video.readyState < 2 || video.videoWidth === 0) return;

    // MediaPipe rejects a repeated timestamp, and re-running detection on a frame
    // we have already seen costs a full inference for no new information.
    if (video.currentTime === lastVideoTime.current) return;
    lastVideoTime.current = video.currentTime;

    const now = performance.now();
    const state = useTryOnStore.getState();
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

    let hand = null;
    try {
      hand = landmarker.detectForVideo(video, now);
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

    // Where the hand model puts the wrist, so the forearm tracker can tell which
    // of the two arms in the pose belongs to it.
    const wrist = hand.landmarks?.[0]?.[0];
    if (wrist && poseRef.current && poseTick.current++ % POSE_EVERY === 0) {
      try {
        const body = poseRef.current.detectForVideo(video, now);
        // The masks are an output of the shared landmarker that this mode has no
        // use for. They hold WASM memory until closed, so they are closed here
        // rather than left for the necklace's copy of this code to worry about.
        body.segmentationMasks?.forEach((m) => m.close());
        projectToAnchorPlane(wrist.x, wrist.y, geometry, wristPlane.current);
        forearm.update(body, geometry, wristPlane.current);
      } catch {
        // The elbow is a refinement; losing it is not worth a dropped frame.
      }
    }

    const options: WristSolverOptions = {
      anchor: state.wristAnchor,
      autoFit: state.braceletAutoFit,
      diameterMm: state.braceletDiameterMm,
      metricBias: state.metricBias,
      forearm: forearm.hint,
      smoothing: state.smoothing,
    };

    const pose = solver.solve(hand, geometry, options, now);

    if (pose) {
      missCount.current = 0;

      group.quaternion.copy(pose.quaternion);
      // The band lies on the anchor plane. It has no depth of its own to place
      // it at — unlike the ring, nothing here is ordered against the rest of the
      // hand, so the only thing a depth would add is MediaPipe's z noise.
      group.position.set(pose.position.x, pose.position.y, 0);

      // Everything inside the group is authored in millimetres, so the group's
      // scale is the conversion — and it is taken from the size the solver
      // *drew*, divided by the size the geometry was *built* at. Any error in
      // the millimetre estimate therefore cancels: it can change how many stones
      // a row is given, and nothing about what appears on screen.
      group.scale.setScalar(pose.radius / semiMajorMm);
      group.visible = true;

      if (Math.abs(pose.semiMajorMm - semiMajorMm) > REBUILD_STEP_MM) {
        setSemiMajorMm(pose.semiMajorMm);
      }

      // In millimetres, like everything else inside the group. Sized off the
      // *drawn* band rather than off the raw measurement, so the arm always
      // fills the band it is wearing however the size was arrived at.
      const major = semiMajorMm * WRIST_OCCLUDER.press;
      const minor = major * WRIST_DEPTH_RATIO;
      occluder.scale.set(major, minor, semiMajorMm * WRIST_OCCLUDER.length);
      occluder.position.z = semiMajorMm * WRIST_OCCLUDER.rise;

      shadow.scale.x = major * SHADOW_CLEARANCE;
      shadow.scale.y = minor * SHADOW_CLEARANCE;

      if (now - lastReadingAt.current > READING_INTERVAL_MS) {
        lastReadingAt.current = now;
        setBraceletReading({
          widthMm: pose.breadthMm,
          circumferenceMm: pose.circumferenceMm,
          fittingDiameterMm: pose.fittingDiameterMm,
          spread: pose.spread,
          settled: pose.settled,
        });
      }

      if (state.status !== "tracking") setStatus("tracking");
    } else if (++missCount.current > MISS_GRACE_FRAMES) {
      group.visible = false;
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
    <group ref={groupRef} visible={false}>
      <WristOccluder ref={occluderRef} />
      <ContactShadow ref={shadowRef} bandWidth={bracelet.spec.bandWidthMm} />
      <ADBracelet3D
        spec={bracelet.spec}
        semiMajorMm={semiMajorMm}
        metal={metal}
        quality="live"
      />
    </group>
  );
}
