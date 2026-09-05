"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { ACESFilmicToneMapping } from "three";
import { ANCHOR_DISTANCE, CAMERA_FOV } from "@/lib/hand/projection";
import { fixedFraming, framingTransform } from "@/lib/hand/framing";
import { StudioEnvironment } from "@/components/three/StudioEnvironment";
import { TrackedRing } from "@/components/three/TrackedRing";
import { TrackedNecklace } from "@/components/three/TrackedNecklace";
import { TrackedBracelet } from "@/components/three/TrackedBracelet";
import { getNecklace, NECKLACES } from "@/lib/jewellery/catalog";
import { getBracelet, BRACELETS } from "@/lib/jewellery/bracelets";
import { getEarring, EARRINGS } from "@/lib/jewellery/earrings";
import { TrackedEarrings } from "@/components/three/TrackedEarrings";
import { useTryOnStore } from "@/lib/store/tryon";
import type { Ring } from "@/lib/rings/types";
import { useCamera } from "./useCamera";
import { CameraGate } from "./CameraGate";
import { TrackingHud } from "./TrackingHud";
import { DebugOverlay } from "./DebugOverlay";
import { NeckDebugOverlay } from "./NeckDebugOverlay";
import { EarDebugOverlay } from "./EarDebugOverlay";
import { CardCalibration } from "./CardCalibration";

/**
 * The composited try-on view: a webcam frame with a transparent WebGL layer
 * locked on top of it.
 *
 * Both layers must agree on geometry exactly. The video is `object-fit: cover`
 * and the canvas fills the same box, so the pose solver replays that same crop
 * when it projects landmarks. The 3D camera's FOV and distance come from the
 * same constants the solver uses, which is what keeps a ring measured in
 * "fractions of the frame height" landing on the right pixels.
 */
export function TryOnStage({ ring }: { ring: Ring }) {
  const mode = useTryOnStore((s) => s.mode);
  const necklaceId = useTryOnStore((s) => s.necklaceId);
  const necklace = getNecklace(necklaceId) ?? NECKLACES[0];
  const braceletId = useTryOnStore((s) => s.braceletId);
  const bracelet = getBracelet(braceletId) ?? BRACELETS[0];
  const earringId = useTryOnStore((s) => s.earringId);
  const earring = getEarring(earringId) ?? EARRINGS[0];
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLCanvasElement | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  const camera = useCamera(videoRef);
  const mirrored = useTryOnStore((s) => s.mirrored);
  const zoom = useTryOnStore((s) => s.zoom);
  const metal = useTryOnStore((s) => s.metal);
  const setStatus = useTryOnStore((s) => s.setStatus);

  useEffect(() => {
    if (camera.state === "starting") setStatus("requesting-camera");
    else if (camera.state === "denied") setStatus("denied", camera.error);
    else if (camera.state === "error") setStatus("error", camera.error);
  }, [camera.state, camera.error, setStatus]);

  // Hand the element to the render loop only once it is actually playing.
  useEffect(() => {
    if (camera.state === "ready") setVideoEl(videoRef.current);
    else setVideoEl(null);
  }, [camera.state]);

  // The card guide is sized in CSS pixels, so it needs the stage's real box.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setStage({ width, height });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  /**
   * Mirrors the crop the projection is using onto the video element. Because the
   * crop is fixed rather than hand-following, this only needs to run when the
   * zoom, the mirror or the element's box changes.
   */
  useEffect(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container || video.videoWidth === 0) return;
    video.style.transform = framingTransform(
      fixedFraming(zoom),
      video.videoWidth,
      video.videoHeight,
      container.clientWidth,
      container.clientHeight,
      mirrored,
    );
  }, [zoom, mirrored, stage.width, stage.height, videoEl]);

  /**
   * Flattens the two layers into one PNG. The WebGL canvas has to be read in
   * the same tick it was drawn — `preserveDrawingBuffer` keeps the pixels
   * around long enough for `toDataURL` to see anything but black.
   */
  const capture = useCallback((): string | null => {
    const video = videoRef.current;
    const gl = glRef.current;
    const container = containerRef.current;
    if (!video || !gl || !container) return null;

    const rect = container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const out = document.createElement("canvas");
    out.width = Math.round(rect.width * dpr);
    out.height = Math.round(rect.height * dpr);
    const ctx = out.getContext("2d");
    if (!ctx) return null;

    // Reproduce the same cover crop *and* digital zoom the preview is showing,
    // or the still will not match what the user framed.
    const framing = fixedFraming(zoom);
    const scale = Math.max(out.width / video.videoWidth, out.height / video.videoHeight);
    const rw = video.videoWidth * scale * framing.zoom;
    const rh = video.videoHeight * scale * framing.zoom;
    const cu = mirrored ? 1 - framing.centerU : framing.centerU;

    ctx.save();
    if (mirrored) {
      ctx.translate(out.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, out.width / 2 - cu * rw, out.height / 2 - framing.centerV * rh, rw, rh);
    ctx.restore();

    ctx.drawImage(gl, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }, [mirrored, zoom]);

  return (
    <div
      ref={containerRef}
      className="relative mx-auto aspect-[4/5] w-full max-w-md overflow-hidden rounded-3xl bg-neutral-950"
    >
      <video
        ref={videoRef}
        playsInline
        muted
        // Safari will not autoplay an inline stream without this attribute set
        // on the element itself, not just as a property.
        autoPlay
        className="absolute inset-0 h-full w-full object-cover"
        // The mirror and the digital crop are combined into one matrix, applied
        // imperatively from the frame loop. Driving it through React state would
        // re-render the tree thirty times a second.
        style={{ transformOrigin: "0 0", willChange: "transform" }}
      />

      <Canvas
        className="absolute inset-0"
        gl={{
          alpha: true,
          antialias: true,
          preserveDrawingBuffer: true,
          toneMapping: ACESFilmicToneMapping,
        }}
        dpr={[1, 2.5]}
        camera={{ fov: CAMERA_FOV, position: [0, 0, ANCHOR_DISTANCE], near: 0.01, far: 50 }}
        onCreated={({ gl }) => {
          glRef.current = gl.domElement;
        }}
      >
        <StudioEnvironment resolution={256} />
        {/*
          Fills from the viewer's side, in scene space rather than parented to
          the ring. The environment alone is fixed relative to the world, so as
          the hand turns the band rotates through it and some orientations catch
          almost no specular at all — which is what made the ring go dull and
          hard to pick out when the hand turned side-on. Lights that stay put
          relative to the camera guarantee a highlight at every angle.
        */}
        <directionalLight position={[0.4, 0.7, 1.2]} intensity={1.5} />
        <directionalLight position={[-0.8, -0.3, 1]} intensity={0.55} color="#dce8ff" />
        <ambientLight intensity={0.22} />
        {mode === "ring" && <TrackedRing video={videoEl} ring={ring} />}
        {mode === "necklace" && (
          <TrackedNecklace video={videoEl} metal={metal} necklace={necklace} />
        )}
        {mode === "bracelet" && (
          <TrackedBracelet video={videoEl} metal={metal} bracelet={bracelet} />
        )}
        {mode === "earring" && (
          <TrackedEarrings video={videoEl} metal={metal} earring={earring} />
        )}
      </Canvas>

      {/*
        Each overlay reads the mailbox its own solver fills, so showing one in a
        mode that never writes to it would draw a stale skeleton over a live
        picture. The bracelet solver publishes no debug frame, so it gets none.
      */}
      {mode === "necklace" && <NeckDebugOverlay />}
      {mode === "ring" && <DebugOverlay />}
      {mode === "earring" && <EarDebugOverlay />}
      <TrackingHud onCapture={capture} />
      <CardCalibration stageWidth={stage.width} stageHeight={stage.height} />

      {camera.state !== "ready" && (
        <CameraGate
          state={camera.state}
          error={camera.error}
          onStart={() => camera.start()}
        />
      )}
    </div>
  );
}
