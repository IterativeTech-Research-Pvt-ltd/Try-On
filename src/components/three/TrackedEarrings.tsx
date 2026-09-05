"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3, type Group, type Mesh } from "three";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { FACE_MODEL_PATH, getFaceLandmarker } from "@/lib/face/tracker";
import {
  EarPoseSolver,
  NOMINAL_FACE_WIDTH_MM,
  type EarSolverOptions,
} from "@/lib/face/earPose";
import { ANCHOR_DISTANCE, type FrameGeometry } from "@/lib/hand/projection";
import { fixedFraming } from "@/lib/hand/framing";
import { clearEarDebug, publishEarDebug } from "@/lib/face/debugBus";
import { useTryOnStore } from "@/lib/store/tryon";
import type { MetalId } from "@/lib/rings/types";
import type { Earring } from "@/lib/jewellery/earrings";
import { ADEarring3D } from "./ADEarring3D";
import {
  HeadOccluder,
  HEAD_DEPTH,
  HEAD_HEIGHT,
  HEAD_RISE,
  HEAD_WIDTH,
} from "./HeadOccluder";

/** Frames the head may go missing before the pair is hidden. */
const MISS_GRACE_FRAMES = 8;

/** Publish the size reading about twice a second, not every frame. */
const READING_INTERVAL_MS = 450;

const RISE = new Vector3();

export function TrackedEarrings({
  video,
  metal,
  earring,
}: {
  video: HTMLVideoElement | null;
  metal: MetalId;
  earring: Earring;
}) {
  const leftRef = useRef<Group>(null);
  const rightRef = useRef<Group>(null);
  const headRef = useRef<Mesh>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const solver = useMemo(() => new EarPoseSolver(), []);
  const missCount = useRef(0);
  const lastVideoTime = useRef(-1);
  const lastReadingAt = useRef(0);
  const fpsWindow = useRef({ frames: 0, since: 0 });

  const { size } = useThree();
  const setEarReading = useTryOnStore((s) => s.setEarReading);
  const setStatus = useTryOnStore((s) => s.setStatus);
  const setFps = useTryOnStore((s) => s.setFps);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading-model");
    getFaceLandmarker()
      .then((lm) => {
        if (cancelled) return;
        landmarkerRef.current = lm;
        setStatus("searching");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const detail = err instanceof Error ? err.message : String(err);
        setStatus(
          "error",
          `Could not load the face tracking model (${FACE_MODEL_PATH}). ${detail} — run "npm run setup:mediapipe" if the file is missing.`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [setStatus]);

  useFrame(() => {
    const left = leftRef.current;
    const right = rightRef.current;
    const head = headRef.current;
    const landmarker = landmarkerRef.current;
    if (!left || !right || !head) return;
    if (!landmarker || !video || video.readyState < 2 || video.videoWidth === 0) return;
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

    const options: EarSolverOptions = {
      anchor: state.earAnchor,
      smoothing: state.smoothing,
    };

    let pose = null;
    try {
      pose = solver.solve(landmarker.detectForVideo(video, now), geometry, options, now);
    } catch {
      return;
    }

    if (pose) {
      missCount.current = 0;

      // Nothing is drawn until the millimetres-to-plane-units bridge is real: a
      // group left at scale 1 would draw a 28 mm earring as 28 screen heights.
      if (pose.unitsPerMm <= 0) {
        left.visible = false;
        right.visible = false;
        head.scale.setScalar(0);
        return;
      }

      for (const [group, place] of [
        [left, pose.left],
        [right, pose.right],
      ] as const) {
        group.visible = place.visible;
        group.quaternion.copy(place.quaternion);
        // Real depth, with the perspective divide undone so the screen position
        // and size stay the ones the solver measured. See TrackedRing.
        const z = place.depth;
        const k = (ANCHOR_DISTANCE - z) / ANCHOR_DISTANCE;
        group.position.set(place.position.x * k, place.position.y * k, z);
        group.scale.setScalar(place.scale * k);
      }

      // The head, sized off the wearer's own face width and tipped with them.
      const breadth = pose.widthUnits;
      head.scale.set(
        (breadth * HEAD_WIDTH) / 2,
        (breadth * HEAD_HEIGHT) / 2,
        (breadth * HEAD_DEPTH) / 2,
      );
      RISE.copy(pose.up).multiplyScalar(breadth * HEAD_RISE);
      head.position.set(pose.centre.x + RISE.x, pose.centre.y + RISE.y, 0);
      head.rotation.set(0, 0, pose.headRoll);

      if (now - lastReadingAt.current > READING_INTERVAL_MS) {
        lastReadingAt.current = now;
        setEarReading({
          headBreadthMm: NOMINAL_FACE_WIDTH_MM,
          headTurnDeg: (pose.headTurn * 180) / Math.PI,
          spread: pose.spread,
          settled: pose.settled,
        });
      }

      if (state.showDiagnostics) {
        publishEarDebug({
          ear: { left: pose.leftEar, right: pose.rightEar },
          mouth: pose.chin,
          nose: pose.nose,
          lobe: { left: pose.left.position, right: pose.right.position },
          headCentre: { x: head.position.x, y: head.position.y },
          headWidth: breadth * HEAD_WIDTH,
          headHeight: breadth * HEAD_HEIGHT,
          breadthUnits: breadth,
          headBreadthMm: NOMINAL_FACE_WIDTH_MM,
          headTurnDeg: (pose.headTurn * 180) / Math.PI,
          headRollDeg: (pose.headRoll * 180) / Math.PI,
          dropMm: NOMINAL_FACE_WIDTH_MM * state.earAnchor.dropBelowEar,
          visible: { left: pose.left.visible, right: pose.right.visible },
          stamp: now,
        });
      }

      if (state.status !== "tracking") setStatus("tracking");
    } else if (++missCount.current > MISS_GRACE_FRAMES) {
      clearEarDebug();
      left.visible = false;
      right.visible = false;
      head.scale.setScalar(0);
      if (state.status !== "error") {
        setStatus(
          "searching",
          solver.lastRejection === "no-face"
            ? "Looking for your face — bring your head into the frame."
            : undefined,
        );
      }
    }

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
      <HeadOccluder ref={headRef} />
      <group ref={leftRef} visible={false}>
        <ADEarring3D spec={earring.spec} metal={metal} quality="live" />
      </group>
      <group ref={rightRef} visible={false}>
        <ADEarring3D spec={earring.spec} metal={metal} quality="live" />
      </group>
    </>
  );
}
