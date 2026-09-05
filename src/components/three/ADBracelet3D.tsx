"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { DoubleSide, type InstancedMesh } from "three";
import { METALS } from "@/lib/rings/catalog";
import type { MetalId } from "@/lib/rings/types";
import { createGemGeometry } from "@/lib/rings/geometry";
import { buildADBracelet, type ADBraceletSpec } from "@/lib/jewellery/adBracelet";
import type { RenderQuality } from "./Ring3D";

/**
 * The American-diamond bracelet.
 *
 * Like the collar, its geometry depends on the wearer — a row set edge to edge
 * has as many stones as the wrist has room for — so it is rebuilt when the
 * measured wrist changes rather than being one model that gets scaled. The
 * parent handles millimetres to screen units.
 *
 * Every stone is one shared geometry placed by an instance transform, so a band
 * of a hundred and seventy stones is a single draw call. That matters more here
 * than it did on the collar: this is drawn on top of live hand tracking, where
 * the GPU is already busy, and it is the difference between the piece being
 * dense enough to read as American diamond and being affordable to render.
 */
export function ADBracelet3D({
  spec,
  semiMajorMm,
  metal,
  quality = "showcase",
}: {
  spec: ADBraceletSpec;
  /** Inner semi-major axis of the band, in millimetres. */
  semiMajorMm: number;
  metal: MetalId;
  quality?: RenderQuality;
}) {
  const built = useMemo(() => buildADBracelet(spec, semiMajorMm), [spec, semiMajorMm]);
  const stone = useMemo(() => createGemGeometry("round"), []);
  const stonesRef = useRef<InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = stonesRef.current;
    if (!mesh) return;
    for (let i = 0; i < built.stones.length; i++) mesh.setMatrixAt(i, built.stones[i]);
    mesh.instanceMatrix.needsUpdate = true;
  }, [built]);

  const metalSpec = METALS[metal];

  return (
    <group>
      <mesh geometry={built.metal}>
        <meshPhysicalMaterial
          color={metalSpec.color}
          metalness={1}
          roughness={metalSpec.roughness}
          envMapIntensity={1.7}
          side={DoubleSide}
        />
      </mesh>

      {/*
        Keyed on the count so a change of wrist size rebuilds the buffer rather
        than trying to write more instances than it was allocated for — an
        InstancedMesh's count is fixed at construction.

        Culling is off because the bounding volume an InstancedMesh computes is
        the *source* geometry's, not the instances' — a 4 mm sphere at the
        origin, which is nowhere near where any of these stones are. Left on,
        the whole band winks out as soon as the wrist moves off centre.
      */}
      <instancedMesh
        key={built.stones.length}
        ref={stonesRef}
        args={[undefined, undefined, built.stones.length]}
        geometry={stone}
        frustumCulled={false}
      >
        {/*
          Cubic zirconia, not diamond. Rendered with real refraction in the
          product view and a mirror-bright approximation over live video, where
          the GPU is already running pose tracking — the same pair the collar
          uses, so the two pieces read as the same stone.
        */}
        {quality === "live" ? (
          <meshPhysicalMaterial
            color="#ffffff"
            metalness={0.08}
            roughness={0}
            clearcoat={1}
            clearcoatRoughness={0}
            reflectivity={1}
            iridescence={0.5}
            iridescenceIOR={1.6}
            envMapIntensity={3.4}
            flatShading
          />
        ) : (
          <meshPhysicalMaterial
            color="#ffffff"
            metalness={0}
            roughness={0}
            transmission={1}
            thickness={0.7}
            ior={2.16}
            dispersion={4.2}
            envMapIntensity={2.8}
            flatShading
          />
        )}
      </instancedMesh>
    </group>
  );
}
