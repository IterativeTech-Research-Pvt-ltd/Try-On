import type { GemId, MetalId } from "@/lib/rings/types";
import {
  AD_DROP,
  AD_JHUMKA,
  AD_STUD,
  buildADEarring,
  type ADEarringSpec,
} from "./adEarring";

/**
 * Earrings. Kept apart from the other three catalogues for the reason they are
 * all kept apart: a different part of the body, a different tracker, and a
 * different meaning of "size" — an earring is sold by its *drop*, which is the
 * one dimension a shopper can hold against something they already own.
 */
export type Earring = {
  id: string;
  name: string;
  collection: string;
  description: string;
  metals: MetalId[];
  gem: GemId;
  spec: ADEarringSpec;
  carat?: number;
  stoneNote?: string;
};

/** How far a design actually hangs below the lobe, in millimetres. */
export function dropOf(earring: Earring): number {
  return buildADEarring(earring.spec).reachMm;
}

export const EARRINGS: Earring[] = [
  {
    id: "ad-jhumka",
    name: "Meher Jhumka",
    collection: "American Diamond",
    description:
      "A domed bell hung from a collet-set stud, ringed twice in American diamond and finished with a full fringe of drops around the lip. The shape earrings mean across half the world, and the one that most rewards being real geometry — a bell turns as the wearer does, and no flat cut-out survives a turned head.",
    metals: ["yellow-gold", "rose-gold", "white-gold", "platinum"],
    gem: "diamond",
    stoneNote: "≈67 stones · 24-drop fringe · hangs 28 mm",
    spec: AD_JHUMKA,
  },
  {
    id: "ad-drop",
    name: "Noor Drop",
    collection: "American Diamond",
    description:
      "One clean American diamond falling from a smaller one on a fine link, with three graduated stones set up the drop. Light enough for every day and long enough to catch the light when you turn your head.",
    metals: ["white-gold", "platinum", "yellow-gold", "rose-gold"],
    gem: "diamond",
    stoneNote: "5 stones · 9 mm drop stone · hangs 21 mm",
    spec: AD_DROP,
  },
  {
    id: "ad-stud",
    name: "Tara Stud",
    collection: "American Diamond",
    description:
      "A six-millimetre American diamond ringed by a close-set halo, sitting flat against the lobe. The one piece here that does not hang — so it is also the one that keeps turning with your head instead of staying upright.",
    metals: ["white-gold", "platinum", "yellow-gold", "rose-gold"],
    gem: "diamond",
    stoneNote: "15 stones · 6 mm centre · sits flat",
    spec: AD_STUD,
  },
];

export function getEarring(id: string): Earring | undefined {
  return EARRINGS.find((e) => e.id === id);
}
