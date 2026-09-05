import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { WASM_PATH } from "@/lib/hand/tracker";

export const FACE_MODEL_PATH = "/mediapipe/models/face_landmarker.task";

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

/**
 * Creates the shared FaceLandmarker, for earrings.
 *
 * A third model, and the only one that had to be added rather than reused —
 * which is worth justifying, because the pose model already reaches the ears.
 *
 * It reaches them with eleven coarse points inferred as part of a whole-body
 * estimate, on a frame the model downsamples with the whole body in it. That is
 * ample for a necklace, which wants a shoulder line and a rough head direction,
 * and it is nowhere near enough to hang a two-centimetre piece off a lobe: the
 * ear landmarks wander by more than an earring is wide. This model spends all
 * 478 of its points on the face alone, which is the whole reason it is here.
 *
 * Served from our own origin like the other two, so the studio works offline.
 */
async function create(): Promise<FaceLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

  const build = (delegate: "GPU" | "CPU") =>
    FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL_PATH, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      /**
       * Neither of the model's optional heads is asked for, and that is not an
       * oversight.
       *
       * The transformation matrix was requested at first, on the reasoning that
       * being *told* the head's rotation beats inferring it. The solver ended up
       * inferring it anyway — from the nose, which turned out to be better
       * conditioned than a matrix is convenient — and the request stayed behind.
       * It is not free: it loads the face-geometry sub-graph, whose delegate
       * initialisation writes to stderr on every construction, which a browser
       * surfaces as an error and a dev overlay puts in front of the user.
       *
       * Asking for an output nothing reads is worth checking for whenever a
       * model logs something alarming and the code appears to be fine.
       */
      outputFacialTransformationMatrixes: false,
      outputFaceBlendshapes: false,
      minFaceDetectionConfidence: 0.4,
      minFacePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });

  try {
    return await build("GPU");
  } catch {
    return await build("CPU");
  }
}

export function getFaceLandmarker(): Promise<FaceLandmarker> {
  landmarkerPromise ??= create().catch((err) => {
    // Let a later attempt retry rather than caching the rejection forever.
    landmarkerPromise = null;
    throw err;
  });
  return landmarkerPromise;
}

export type { FaceLandmarkerResult };

/**
 * Face-mesh landmarks this project reads, from the published face-oval ring.
 *
 * The mesh has no ear or lobe vertex — it stops at the face's silhouette — so an
 * earring is hung off the contour's widest points, which sit at the tragion, the
 * notch in front of the ear canal. Which of the two is the wearer's left is not
 * assumed: it is decided each frame from the head's own rotation, so a mirrored
 * preview needs no special case.
 */
export const FM = {
  /** The two widest points of the face oval, level with the ear canal. */
  SIDE_A: 234,
  SIDE_B: 454,
  /** The oval a little below those, toward the jaw — the lobe's direction. */
  UNDER_A: 93,
  UNDER_B: 323,
  /** Chin and brow, for the head's own vertical. */
  CHIN: 152,
  BROW: 10,
  NOSE_TIP: 1,
} as const;

/** How many landmarks the model always returns. */
export const FACE_LANDMARK_COUNT = 478;
