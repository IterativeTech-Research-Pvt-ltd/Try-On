"use client";

import { forwardRef, useMemo } from "react";
import { SphereGeometry, type Mesh } from "three";

/**
 * How wide the stand-in is, as a fraction of the ear-to-ear span.
 *
 * Under one on purpose. The ears sit at the very edge of the head, so a
 * stand-in as wide as the span would swallow the earrings the moment they were
 * drawn — including the near one, which is the whole point of the exercise.
 * Slightly narrower leaves both lobes outside it while the head faces the
 * camera, and still hides the far one the moment it swings behind.
 */
export const HEAD_WIDTH = 0.94;

/** Height and depth of the stand-in, in the same ear spans. */
export const HEAD_HEIGHT = 1.25;
export const HEAD_DEPTH = 1.05;

/**
 * How far above the ear line the stand-in is centred, in ear spans.
 *
 * A head extends much further above the ear canal than below it, and the part
 * below is jaw rather than skull. Centring on the ears would leave the crown
 * uncovered and hang the sphere down over the earrings.
 */
export const HEAD_RISE = 0.16;

/**
 * A depth-only stand-in for the head.
 *
 * The same trick as every other occluder here, and needed for the same reason:
 * an earring is a pair, and when the wearer turns, one of the pair is behind
 * their head. Nothing in the scene knows a head exists, so without this the far
 * earring draws straight over the cheek it should be hidden by — which reads
 * less like a rendering fault than like the earrings having come loose.
 *
 * A sphere rather than an ellipsoid mesh: the caller scales it into one, and one
 * unit sphere is cheaper than three. Authored at radius 1 and centred on the ear
 * line, with the rise applied by the caller.
 */
export const HeadOccluder = forwardRef<Mesh>(function HeadOccluder(_props, ref) {
  const geometry = useMemo(() => new SphereGeometry(1, 28, 20), []);

  return (
    // Ahead of the jewellery, so the head's depth is laid down before any of it
    // is tested.
    <mesh ref={ref} geometry={geometry} renderOrder={-2}>
      <meshBasicMaterial colorWrite={false} depthWrite depthTest />
    </mesh>
  );
});
