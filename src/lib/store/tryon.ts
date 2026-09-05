"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_ONE_EURO, type OneEuroConfig } from "@/lib/hand/oneEuro";
import type { FingerName } from "@/lib/hand/landmarks";
import { anchorFor, type RingAnchor } from "@/lib/hand/anchor";
import {
  DEFAULT_NECKLACE_ANCHOR,
  type NecklaceAnchor,
} from "@/lib/neck/necklacePose";
import { DEFAULT_WRIST_ANCHOR, type WristAnchor } from "@/lib/hand/wristPose";
import { DEFAULT_EAR_ANCHOR, type EarAnchor } from "@/lib/face/earPose";
import { EARRINGS } from "@/lib/jewellery/earrings";
import { BRACELETS } from "@/lib/jewellery/bracelets";
import {
  DEFAULT_DIAMETER_MM,
  semiMajorForDiameterMm,
  snapToStockDiameter,
} from "@/lib/jewellery/wristFit";
import { RINGS } from "@/lib/rings/catalog";
import { DEFAULT_SIZE, sizeToDiameterMm, snapToStockSize } from "@/lib/rings/sizes";
import type { GemId, MetalId } from "@/lib/rings/types";

export type TrackingStatus =
  | "idle"
  | "loading-model"
  | "requesting-camera"
  | "searching"
  | "tracking"
  | "denied"
  | "error";

/** What the camera currently believes about the finger, in real millimetres. */
export type SizeReading = {
  widthMm: number;
  circumferenceMm: number;
  usSize: number;
  /** Interquartile spread as a fraction of the median; lower is steadier. */
  spread: number;
  settled: boolean;
};

/** What the camera currently believes about the wrist, in real millimetres. */
export type BraceletReading = {
  /** Breadth across the wrist. */
  widthMm: number;
  /** What a tape would read round it. */
  circumferenceMm: number;
  /** Inner fitting diameter of the band being drawn. */
  fittingDiameterMm: number;
  spread: number;
  settled: boolean;
};

/** What the camera currently believes about the head. */
export type EarReading = {
  /** Ear-to-ear breadth, in true millimetres. */
  headBreadthMm: number;
  /** How far the head is turned, in degrees. */
  headTurnDeg: number;
  spread: number;
  settled: boolean;
};

export type CalibrationSource = "none" | "card" | "known-size";

type Persisted = {
  metricBias: number;
  calibrationSource: CalibrationSource;
  necklaceAnchor: NecklaceAnchor;
  anchor: RingAnchor;
  wristAnchor: WristAnchor;
  earAnchor: EarAnchor;
};

/**
 * Which piece is being tried on.
 *
 * A real mode rather than a filter over one catalogue: rings and bracelets are
 * tracked by the hand model, necklaces and earrings by the pose model, they are
 * measured against different parts of the body, and "size" means something
 * different in every one of them — a US size, a millimetre circumference, an
 * inner diameter, a drop.
 */
export type TryOnMode = "ring" | "necklace" | "bracelet" | "earring";

type TryOnState = Persisted & {
  mode: TryOnMode;
  ringId: string;
  necklaceId: string;
  braceletId: string;
  earringId: string;
  metal: MetalId;
  /**
   * Stone the wearer picked, or null to use whichever the ring was designed around.
   *
   * Null rather than a concrete default so that switching rings shows each one as
   * designed, instead of carrying the last ring's stone across to a piece it was
   * never meant for.
   */
  gem: GemId | null;
  finger: FingerName;

  /** US size the ring is drawn at when auto-fit is off. */
  ringSize: number;
  /** Draw at the measured finger width rather than the chosen size. */
  autoFit: boolean;
  /** Live measurement from the camera, or null before one settles. */
  reading: SizeReading | null;
  /** True once we have auto-selected a size from the first settled reading. */
  sizeAdopted: boolean;
  /** True while the card-alignment overlay is up. */
  calibratingWithCard: boolean;

  /** Where the ring sits, in finger-relative terms. Never screen coordinates. */
  anchor: RingAnchor;
  /** Where the necklace sits, in neck-relative terms. */
  necklaceAnchor: NecklaceAnchor;
  /** Where the bracelet sits, in wrist-relative terms. */
  wristAnchor: WristAnchor;
  /**
   * Inner semi-major axis the band is currently built at, in millimetres.
   *
   * Published from the tracker with a dead band rather than read every frame:
   * the number of stones in a row comes from the wrist's own circumference, so
   * this is what the geometry is rebuilt on, and a wrist does not change size.
   */
  braceletSemiMajorMm: number;
  /** Inner fitting diameter the band is drawn at when auto-fit is off. */
  braceletDiameterMm: number;
  /** Draw at the measured wrist rather than the chosen size. */
  braceletAutoFit: boolean;
  /** Live wrist measurement from the camera, or null before one settles. */
  braceletReading: BraceletReading | null;
  /** True once a size has been adopted from the first settled wrist reading. */
  braceletSizeAdopted: boolean;
  /** Where the earrings hang, in head-relative terms. */
  earAnchor: EarAnchor;
  /** Live head measurement from the camera, or null before one settles. */
  earReading: EarReading | null;
  /** Measured neck radius in millimetres; drives how the chain is laid. */
  neckSizeMm: number;
  /** What the camera measured about the neck, for the sizing panel. */
  neckReading: {
    circumferenceMm: number;
    lengthMm: number;
    /** True when the head-breadth cue was usable, so the estimate used two. */
    twoCues: boolean;
  } | null;
  mirrored: boolean;
  flipGem: boolean;
  /**
   * Hide the necklace where something that is not the wearer covers them, using the
   * pose model's per-pixel mask.
   *
   * Off by default. It is the only thing here that can hide the piece *entirely* if
   * the mask is wrong — it writes depth wherever the mask says not-the-wearer — and
   * it has already done so once. Basic visibility should not depend on a refinement.
   */
  maskOcclusion: boolean;
  /**
   * Drift the piece's lighting toward the room the camera can see.
   *
   * On by default. A piece lit by a studio the wearer is not standing in is one of the
   * two reasons rendered jewellery reads as a sticker; the other is the absence of a
   * contact shadow where it rests on skin.
   */
  adaptLighting: boolean;
  /** Fixed magnification of the centre of the frame, 1 being uncropped. */
  zoom: number;
  /**
   * Keep the setting turned toward the viewer instead of riding round with the
   * hand.
   *
   * Off by default, because a ring's stone belongs on the back of the finger: it
   * should be on show when the back of the hand faces the camera and hidden behind
   * the finger when the palm does. Turning it on trades that for always being able
   * to see the stone, which is occasionally useful and never realistic.
   */
  settingFacesCamera: boolean;
  /**
   * Measure the finger's width from the video pixels rather than from hand
   * proportions. Off by default: it is unbiased when it works and badly wrong
   * when it locks onto a crease instead of the finger's edge.
   */
  usePixelProbe: boolean;
  showDiagnostics: boolean;
  smoothing: OneEuroConfig;
  status: TrackingStatus;
  errorMessage: string | null;
  fps: number;

  setRing: (ringId: string) => void;
  setMetal: (metal: MetalId) => void;
  setGem: (gem: GemId | null) => void;
  setFinger: (finger: FingerName) => void;
  setRingSize: (size: number) => void;
  setAutoFit: (autoFit: boolean) => void;
  setReading: (reading: SizeReading | null) => void;
  startCardCalibration: () => void;
  cancelCardCalibration: () => void;
  applyCardCalibration: (bias: number) => void;
  calibrateToKnownSize: (knownSize: number) => void;
  resetCalibration: () => void;
  setAnchor: (patch: Partial<RingAnchor>) => void;
  setMode: (mode: TryOnMode) => void;
  setNecklace: (necklaceId: string) => void;
  setNecklaceAnchor: (patch: Partial<NecklaceAnchor>) => void;
  setBracelet: (braceletId: string) => void;
  setWristAnchor: (patch: Partial<WristAnchor>) => void;
  setBraceletSemiMajorMm: (mm: number) => void;
  setBraceletDiameterMm: (mm: number) => void;
  setBraceletAutoFit: (autoFit: boolean) => void;
  setBraceletReading: (reading: BraceletReading | null) => void;
  setEarring: (earringId: string) => void;
  setEarAnchor: (patch: Partial<EarAnchor>) => void;
  setEarReading: (reading: EarReading | null) => void;
  /** Discards any hand-dialled offsets and returns to what the camera measures. */
  resetPlacement: () => void;
  setNeckSizeMm: (mm: number) => void;
  setNeckReading: (reading: TryOnState["neckReading"]) => void;
  toggleMirrored: () => void;
  toggleFlipGem: () => void;
  setZoom: (zoom: number) => void;
  toggleMaskOcclusion: () => void;
  toggleAdaptLighting: () => void;
  toggleSettingFacesCamera: () => void;
  togglePixelProbe: () => void;
  toggleDiagnostics: () => void;
  setSmoothing: (smoothing: Partial<OneEuroConfig>) => void;
  setStatus: (status: TrackingStatus, errorMessage?: string | null) => void;
  setFps: (fps: number) => void;
};

export const useTryOnStore = create<TryOnState>()(
  persist(
    (set, get) => ({
      mode: "ring",
      ringId: RINGS[0].id,
      necklaceId: "infinity-heart",
      braceletId: BRACELETS[0].id,
      earringId: EARRINGS[0].id,
      metal: RINGS[0].metals[0],
      gem: null,
      finger: "ring",

      ringSize: DEFAULT_SIZE,
      autoFit: true,
      metricBias: 1,
      calibrationSource: "none",
      reading: null,
      sizeAdopted: false,
      calibratingWithCard: false,

      anchor: anchorFor("ring"),
      necklaceAnchor: DEFAULT_NECKLACE_ANCHOR,
      wristAnchor: DEFAULT_WRIST_ANCHOR,
      braceletSemiMajorMm: semiMajorForDiameterMm(DEFAULT_DIAMETER_MM),
      braceletDiameterMm: DEFAULT_DIAMETER_MM,
      braceletAutoFit: true,
      braceletReading: null,
      braceletSizeAdopted: false,
      earAnchor: DEFAULT_EAR_ANCHOR,
      earReading: null,
      neckSizeMm: 57,
      neckReading: null,
      mirrored: true,
      flipGem: false,
      maskOcclusion: false,
      adaptLighting: true,
      zoom: 1.7,
      settingFacesCamera: false,
      usePixelProbe: false,
      showDiagnostics: false,
      smoothing: DEFAULT_ONE_EURO,
      status: "idle",
      errorMessage: null,
      fps: 0,

      setRing: (ringId) =>
        set((state) => {
          const ring = RINGS.find((r) => r.id === ringId);
          if (!ring) return state;
          // Carry the current metal over when the new ring offers it, so switching
          // designs does not silently change what the shopper is looking at.
          const metal = ring.metals.includes(state.metal) ? state.metal : ring.metals[0];
          return { ringId, metal };
        }),
      setMetal: (metal) => set({ metal }),
      setGem: (gem) => set({ gem }),
      setFinger: (finger) =>
        // A different finger is a different measurement, and a different anchor:
        // a ring rides higher on a pinky than on an index finger.
        set((s) => ({
          finger,
          anchor: anchorFor(finger, {
            widthMultiplier: s.anchor.widthMultiplier,
            rotationOffset: s.anchor.rotationOffset,
          }),
          reading: null,
          sizeAdopted: false,
        })),

      setRingSize: (ringSize) => set({ ringSize, autoFit: false }),
      setAutoFit: (autoFit) => set({ autoFit }),

      setReading: (reading) =>
        set((state) => {
          if (!reading) return { reading };
          // The first steady reading picks the size for the user, so the ring they
          // see is the one that would actually fit. After that it is theirs.
          if (!state.sizeAdopted && reading.settled) {
            return {
              reading,
              ringSize: snapToStockSize(reading.usSize),
              sizeAdopted: true,
            };
          }
          return { reading };
        }),

      startCardCalibration: () => set({ calibratingWithCard: true }),
      cancelCardCalibration: () => set({ calibratingWithCard: false }),

      applyCardCalibration: (bias) =>
        set({
          metricBias: bias,
          calibrationSource: "card",
          calibratingWithCard: false,
          // The previous reading was computed with the old bias.
          reading: null,
          sizeAdopted: false,
        }),

      calibrateToKnownSize: (knownSize) => {
        const { reading, metricBias } = get();
        if (!reading) return;
        const measured = reading.usSize;
        if (!(measured > 0)) return;
        // Reported diameter scales as 1/bias, so to make the reading read
        // `knownSize` the bias moves by the ratio of the two diameters.
        const next =
          metricBias * (sizeToDiameterMm(measured) / sizeToDiameterMm(knownSize));
        if (!Number.isFinite(next) || next < 0.5 || next > 2) return;
        set({
          metricBias: next,
          calibrationSource: "known-size",
          ringSize: snapToStockSize(knownSize),
          sizeAdopted: true,
          reading: null,
        });
      },

      resetCalibration: () =>
        set({
          metricBias: 1,
          calibrationSource: "none",
          sizeAdopted: false,
          reading: null,
        }),

      setAnchor: (patch) => set((s) => ({ anchor: { ...s.anchor, ...patch } })),
      setMode: (mode) =>
        // Switching piece switches tracking model, so nothing measured for the old
        // one carries over. The framing changes too: a ring wants a tight crop on
        // one hand, whereas a necklace is not placed at all until both shoulders
        // are in frame, so it needs a wider view.
        set({
          mode,
          status: "loading-model",
          reading: null,
          sizeAdopted: false,
          braceletReading: null,
          braceletSizeAdopted: false,
          earReading: null,
          // A bracelet sits between the hand modes and the body ones: it needs
          // the forearm in frame as well as the hand.
          //
          // Earrings want a *closer* view than a necklace — the piece is a couple
          // of centimetres on the side of a head — but the crop is fixed on the
          // middle of the frame, and a head is habitually above the middle. Past
          // about 1.5 the crop starts cutting off the very ears it was tightened
          // for, which reads as the earrings not being placed rather than as the
          // view being wrong. Better to open with everything visible and leave
          // the zoom slider to anyone who wants a closer look.
          zoom:
            mode === "necklace"
              ? 1.2
              : mode === "bracelet"
                ? 1.4
                : mode === "earring"
                  ? 1.5
                  : 1.7,
        }),
      setNecklace: (necklaceId) => set({ necklaceId }),
      setNecklaceAnchor: (patch) =>
        set((s) => ({ necklaceAnchor: { ...s.necklaceAnchor, ...patch } })),

      setBracelet: (braceletId) =>
        set((state) => {
          const bracelet = BRACELETS.find((b) => b.id === braceletId);
          if (!bracelet) return state;
          // Carry the metal over when the new piece offers it, so switching
          // design does not silently change what the shopper is looking at.
          const metal = bracelet.metals.includes(state.metal)
            ? state.metal
            : bracelet.metals[0];
          return { braceletId, metal };
        }),
      setWristAnchor: (patch) =>
        set((s) => ({ wristAnchor: { ...s.wristAnchor, ...patch } })),
      setBraceletSemiMajorMm: (braceletSemiMajorMm) => set({ braceletSemiMajorMm }),
      setBraceletDiameterMm: (braceletDiameterMm) =>
        set({ braceletDiameterMm, braceletAutoFit: false }),
      setBraceletAutoFit: (braceletAutoFit) => set({ braceletAutoFit }),
      setBraceletReading: (reading) =>
        set((state) => {
          if (!reading) return { braceletReading: reading };
          // The first steady reading picks the size, so the piece on screen is
          // the one that would actually fit. After that it is the wearer's.
          if (!state.braceletSizeAdopted && reading.settled) {
            return {
              braceletReading: reading,
              braceletDiameterMm: snapToStockDiameter(reading.fittingDiameterMm),
              braceletSizeAdopted: true,
            };
          }
          return { braceletReading: reading };
        }),

      setEarring: (earringId) =>
        set((state) => {
          const earring = EARRINGS.find((e) => e.id === earringId);
          if (!earring) return state;
          const metal = earring.metals.includes(state.metal)
            ? state.metal
            : earring.metals[0];
          return { earringId, metal };
        }),
      setEarAnchor: (patch) =>
        set((s) => ({ earAnchor: { ...s.earAnchor, ...patch } })),
      setEarReading: (earReading) => set({ earReading }),

      resetPlacement: () =>
        set((s) => ({
          necklaceAnchor: DEFAULT_NECKLACE_ANCHOR,
          wristAnchor: DEFAULT_WRIST_ANCHOR,
          earAnchor: DEFAULT_EAR_ANCHOR,
          anchor: anchorFor(s.anchor.finger),
        })),
      setNeckSizeMm: (neckSizeMm) => set({ neckSizeMm }),
      setNeckReading: (neckReading) => set({ neckReading }),
      toggleMirrored: () => set((s) => ({ mirrored: !s.mirrored })),
      toggleFlipGem: () => set((s) => ({ flipGem: !s.flipGem })),
      setZoom: (zoom) => set({ zoom }),
      toggleMaskOcclusion: () =>
        set((s) => ({ maskOcclusion: !s.maskOcclusion })),
      toggleAdaptLighting: () =>
        set((s) => ({ adaptLighting: !s.adaptLighting })),
      toggleSettingFacesCamera: () =>
        set((s) => ({ settingFacesCamera: !s.settingFacesCamera })),
      togglePixelProbe: () =>
        set((s) => ({ usePixelProbe: !s.usePixelProbe, reading: null, sizeAdopted: false })),
      toggleDiagnostics: () => set((s) => ({ showDiagnostics: !s.showDiagnostics })),
      setSmoothing: (smoothing) =>
        set((s) => ({ smoothing: { ...s.smoothing, ...smoothing } })),
      setStatus: (status, errorMessage = null) => set({ status, errorMessage }),
      setFps: (fps) => set({ fps }),
    }),
    {
      name: "aurelia-tryon",
      // A hand does not change size between visits, so the calibration is worth
      // keeping. Nothing else here is; a stale ring or status would be confusing.
      // Anything the wearer had to dial in by hand is worth keeping. Making
      // someone re-find the same offset on every visit is the sort of thing that
      // makes a manual control feel like a workaround rather than a preference.
      // Nothing *measured* is persisted — that is re-derived from the camera each
      // session, and a stale measurement would be worse than none.
      partialize: (state): Persisted => ({
        metricBias: state.metricBias,
        calibrationSource: state.calibrationSource,
        necklaceAnchor: state.necklaceAnchor,
        anchor: state.anchor,
        wristAnchor: state.wristAnchor,
        earAnchor: state.earAnchor,
      }),
      /**
       * Merge the anchors field by field rather than replacing them.
       *
       * The default merge overwrites each persisted key wholesale, which is fine
       * for a number and wrong for a shaped object: an anchor that gains a field
       * between visits comes back from an older session missing it, and a
       * missing offset is not a stale value but a NaN — the piece vanishes off
       * screen with nothing to say why. Layering the stored fields over the
       * current defaults keeps a returning visitor's adjustments without letting
       * their shape go stale.
       */
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<Persisted>;
        return {
          ...current,
          ...stored,
          anchor: { ...current.anchor, ...stored.anchor },
          necklaceAnchor: { ...current.necklaceAnchor, ...stored.necklaceAnchor },
          wristAnchor: { ...current.wristAnchor, ...stored.wristAnchor },
          earAnchor: { ...current.earAnchor, ...stored.earAnchor },
        };
      },
    },
  ),
);
