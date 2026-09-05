"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { DoubleSide, type InstancedMesh } from "three";
import { METALS } from "@/lib/rings/catalog";
import type { MetalId } from "@/lib/rings/types";
import { createGemGeometry } from "@/lib/rings/geometry";
import { buildADEarring, type ADEarringSpec } from "@/lib/jewellery/adEarring";
import type { RenderQuality } from "./Ring3D";

/**
 * One American-diamond earring, modelled hanging from the origin.
 *
 * Unlike the collar and the bracelet this does not depend on the wearer at all —
 * a 28 mm jhumka is 28 mm on everybody, so the geometry is built once per design
 * and only the scale that converts it to screen units changes. The stones are a
 * single instanced draw, as everywhere else.
 */
export function ADEarring3D({
  spec,
  metal,
  quality = "showcase",
}: {
  spec: ADEarringSpec;
  metal: MetalId;
  quality?: RenderQuality;
}) {
  const built = useMemo(() => buildADEarring(spec), [spec]);
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

      {/* See ADBracelet3D for why the count is a key and culling is off. */}
      <instancedMesh
        key={built.stones.length}
        ref={stonesRef}
        args={[undefined, undefined, built.stones.length]}
        geometry={stone}
        frustumCulled={false}
      >
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
