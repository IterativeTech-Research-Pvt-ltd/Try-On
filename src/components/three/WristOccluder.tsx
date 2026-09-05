"use client";

import { forwardRef, useMemo } from "react";
import { CylinderGeometry, type Mesh } from "three";

/**
 * An invisible stand-in for the length of forearm the band encircles.
 *
 * Same trick as FingerOccluder, and necessary for the same reason: without it
 * the bracelet renders as a complete closed loop floating over the video, with
 * the far side of the band plainly visible straight through the arm. Real
 * occlusion needs real geometry, so a cylinder is placed where the forearm is
 * and writes depth while writing no colour. The far arc then fails the depth
 * test and disappears behind an arm the renderer cannot actually see.
 *
 * **The cross-section is elliptical, and here that is right** — which is the
 * opposite of the ring's occluder, where an ellipse was a mistake. A finger
 * under a band conforms to the band's circular bore, so modelling it as a rigid
 * oval left gaps. A wrist does no such thing: it is a rigid structure, markedly
 * flatter than it is wide, and the band takes *its* section rather than the
 * other way round. Making this circular would push it well outside the band at
 * the back and front of the wrist, where it would then hide the near arc too.
 *
 * Authored with a semi-major axis of 1 and unit length along +Z, to match the
 * band axis the pose solver produces. The caller owns the scale, the roll and
 * the offset along the arm, because all three change every frame.
 */
export const WristOccluder = forwardRef<Mesh>(function WristOccluder(_props, ref) {
  const geometry = useMemo(() => {
    // **Open-ended, unlike the ring's.** That occluder is capped because a
    // fingertip is a real surface that really does hide things behind it. A
    // forearm has no such end — it carries on out of the frame in both
    // directions — so capping this one invents a surface that is not there, and
    // the moment the arm leans toward the lens that invented cap lands between
    // the camera and the band and hides the entire bracelet rather than its far
    // arc. An open tube cannot do that: the band sits outside its silhouette, so
    // looking straight down the arm shows the whole ring, which is exactly what
    // looking down your own forearm does.
    const g = new CylinderGeometry(1, 1, 1, 36, 1, true);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);

  return (
    // Ahead of everything the piece draws, so the arm's depth is laid down
    // before any metal or stone is tested against it.
    <mesh ref={ref} geometry={geometry} renderOrder={-2}>
      <meshBasicMaterial colorWrite={false} depthWrite depthTest />
    </mesh>
  );
});
