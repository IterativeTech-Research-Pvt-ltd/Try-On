import type { GemId, MetalId } from "@/lib/rings/types";
import { AD_PAVE_BAND, AD_TENNIS, type ADBraceletSpec } from "./adBracelet";

/**
 * Bracelets. Kept apart from the ring and necklace catalogues for the same
 * reason those two are kept apart from each other: a bracelet is sized against a
 * different part of the body, in a different unit, and a shared "product" type
 * would only paper over that.
 *
 * Both pieces here are American diamond, and both are set through a full turn.
 * A wrist rotates constantly and without thinking about it, so a bracelet with a
 * decorated front and a plain back spends half of any try-on showing the back —
 * which is why there is no partly-set design in this catalogue at all.
 */
export type Bracelet = {
  id: string;
  name: string;
  collection: string;
  description: string;
  metals: MetalId[];
  gem: GemId;
  spec: ADBraceletSpec;
  carat?: number;
  /** Used where a single carat weight would be meaningless — a set band has
   * dozens of stones, not one. */
  stoneNote?: string;
};

export const BRACELETS: Bracelet[] = [
  {
    id: "ad-pave-band",
    name: "Roshni Band",
    collection: "American Diamond",
    description:
      "A nine-millimetre band carrying three rows of American diamond the whole way round the wrist — a row of four-millimetre brilliants down the centre, each in its own collet, with finer stones channelled between the rails either side. Bridal weight, and the reason it reads at arm's length rather than dissolving into a bright line.",
    metals: ["white-gold", "platinum", "yellow-gold", "rose-gold"],
    gem: "diamond",
    stoneNote: "≈170 stones · 4.0 mm centres · set through 360°",
    spec: AD_PAVE_BAND,
  },
  {
    id: "ad-tennis",
    name: "Saanjh Line",
    collection: "American Diamond",
    description:
      "The classic line bracelet: one unbroken row of 4.4 mm American diamond brilliants, collet set edge to edge with no clasp plate to interrupt them. Slim enough to wear against a watch, and bright from every angle because the row does not stop where the wrist turns away.",
    metals: ["white-gold", "platinum", "yellow-gold", "rose-gold"],
    gem: "diamond",
    stoneNote: "≈36 stones · 4.4 mm brilliants · set through 360°",
    spec: AD_TENNIS,
  },
];

export function getBracelet(id: string): Bracelet | undefined {
  return BRACELETS.find((b) => b.id === id);
}
