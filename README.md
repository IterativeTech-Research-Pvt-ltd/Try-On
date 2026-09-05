# Ring Try-On

Virtual jewellery try-on in the browser: rings and bracelets on your hand,
necklaces on your neck, earrings on your ears. Your camera tracks you, and the piece is rendered as real
3D geometry onto you — sized in millimetres, oriented in 3D, and correctly hidden
where your body passes in front of it.

Everything runs on-device. No video is uploaded.

Earrings are built, tested and documented below, but the mode is not offered in
the UI yet — the option is commented out in `TryOnStudio`, and restoring it is a
one-line change.

## Running it

```bash
npm install     # also fetches the MediaPipe runtime + model into public/
npm run dev     # http://localhost:3000
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run verify` | Solver + geometry test suites (no camera needed) |
| `npm run setup:mediapipe` | Re-fetch the tracking runtime and model |

The MediaPipe WASM runtime and the 7.5 MB hand-landmarker model are **not** in
git — they are 41 MB of fully reproducible binaries, restored by
`scripts/fetch-mediapipe.mjs` on install. They are served from this origin rather
than a CDN so the try-on works offline, under a strict CSP, and without a third
party learning that anyone opened the page.

## Deploying to Vercel

Works with no configuration — import the repo and deploy. Framework detection picks
up Next.js, and `postinstall` fetches the tracking assets during install, before the
build runs.

Two things worth knowing, both already handled:

- **The 47 MB of tracking assets are not in git.** They are restored on the build
  server by `scripts/fetch-mediapipe.mjs`, which needs outbound network access to
  `storage.googleapis.com`. On a build server (`CI` or `VERCEL` set) a failed or
  truncated download **fails the build deliberately**. Deploying without them would
  produce a green build and a try-on that silently cannot track anything — nothing
  would surface until a visitor opened their camera. If your build environment has
  no network access, commit `public/mediapipe/` instead and drop it from
  `.gitignore`.
- **They are cached for a year.** A visitor downloads an 11.7 MB WASM runtime plus a
  7.5 MB model for rings, and 5.5 MB more for necklaces. Next.js serves `public/`
  with `max-age=0` by default, which would revalidate all of it on every visit, so
  `next.config.ts` marks `/mediapipe/*` immutable. They are versioned artifacts —
  the runtime is pinned by the installed package and each model URL carries its own
  version — so a different version is a different file.

The camera needs a secure context, which Vercel provides. Nothing runs server-side:
tracking and rendering are entirely in the browser, and no video is uploaded, so
there is nothing to configure and no environment variables to set.

Verified by building a clean `git archive` checkout with `npm ci` and serving it: all
seven routes return 200, both models and the WASM runtime are reachable, and the
cache headers apply to the assets without touching the pages.

## How the placement works

Two landmark sets come back from MediaPipe each frame, and each is reliable at
exactly one thing:

- **Where** the ring goes comes from the normalized *image* landmarks. Anchoring
  to the image guarantees the band sits on the pixels of the finger, with no
  dependence on an unknown camera intrinsic. The seat is
  `lerp(MCP, PIP, positionAlongFinger)` — recomputed every frame, never a fixed
  screen coordinate.
- **Which way it is turned** comes from the metric *world* landmarks, which carry
  real 3D structure that flat image coordinates cannot express. The band's axis is
  the finger's own direction; the roll comes from the palm plane.
- **How big** it is comes from both. The world landmarks measure the finger in
  millimetres; a least-squares fit between the two spaces gives pixels-per-metre.
  That is what lets a US 7 render as an actual US 7.

Depth is referenced to the palm, so the band has a real Z — not pinned to a
plane — and lives in the same 3D space as the occluders. Displacing it in Z would
move it on screen, so the position and scale are both compensated by the
perspective divide; the test suite asserts that identity to 1e-9.

### Occlusion

A ring is a closed loop, so half of it is behind your finger — but the renderer
has no idea your finger exists. So there is a depth-only stand-in for the hand: a
cylinder through the band, tapered capsules down every finger, and a slab for the
palm, all writing depth and no colour. Anything behind them fails the depth test
and vanishes behind a hand that was never drawn. A translucent sleeve just outside
the band darkens the skin at its edges — the contact shadow that stops the ring
looking stuck on top of the picture.

### Sizing accuracy

A camera alone cannot know how big your hand is. MediaPipe's world landmarks are
regressed against a canonical hand, so for anyone whose hands are not average the
millimetres carry a constant error that no filtering removes.

Two ways to fix it, both in the studio's sizing panel:

- **Bank card.** Every card is 85.60 mm wide by ISO/IEC 7810. Hold one against
  your fingers, line it up with the outline, and that one frame gives true scale.
- **A size you already know.** Enter it and every later measurement is corrected
  to match.

The panel labels the reading **Estimate** or **Exact** so it is always clear which
you are looking at.

### Bracelets

A wrist cannot be measured directly: the hand model's landmarks stop at the wrist,
so there is nothing below it to measure *between*. Everything is derived from the
hand and continued past it.

**The whole placement comes from the image landmarks, and that is the opposite of
what the ring does.** A ring has to be turned correctly about its own finger,
because a stone belongs on the back of the hand and nowhere else — only the metric
world landmarks carry that, so the ring solver pays for their noise and spends
real effort resolving it. A bracelet set the whole way round is symmetric about
the forearm, so nothing *needs* the third dimension, and taking it anyway buys
nothing while inheriting MediaPipe's noisiest output. The visible result of that
trade was a band that tipped and swam against an arm which had not moved.

So the frame is built in the picture plane — along the arm is the palm's own
direction on screen, across is perpendicular to it — and then **lifted out of the
plane by two angles, each recovered from foreshortening rather than from depth:**

- **Forearm lean.** The palm's true length is a fixed anatomical span, and the
  plane-scale fit converts it into the length it would project to lying square to
  the lens. What it actually measures on screen, over that, is the cosine of its
  lean.
- **Wrist roll.** The same trick on the span between the knuckles. The two cues
  separate cleanly, because each rotation leaves the other's span alone: the
  knuckle line is the axis the arm leans about, and the palm's length is the axis
  the wrist rolls about.

**A One Euro filter's `beta` carries the signal's units, and every one of them
here was set as though it did not.** That single mistake, repeated in three
places, was most of what made the piece unreliable in motion: a landmark travels
about a plane unit a second, so the shared default of 0.035 lifted a 1.7 Hz
cutoff to 1.735 Hz and the adaptive half of the filter never ran at all. What was
left was a fixed low-pass, and the band trailed the hand by a fixed lag on every
movement — three times as visible on a bracelet as on a ring, for the same reason
everything else is. The bracelet now sets its own coefficients, scaled to what
each filter is actually smoothing; the Smoothing slider still drives `minCutoff`
and still does exactly what it says.

That scale fit is taken from the **raw** landmarks rather than the smoothed ones,
and its filter's speed coefficient is scaled by the fit's own magnitude. Both are
about lag rather than accuracy, and both mattered: a One Euro filter's `beta`
multiplies a derivative so it carries the signal's units, and a scale in plane
units per metre is some thirty times a landmark coordinate — so a beta tuned for
landmarks leaves the scale a fixed low-pass. Together with smoothing the same
quantity twice, once on the landmarks and again on the fit, that put the drawn
size **a quarter of its own width behind an ordinary hand movement**, taking a
second to catch up. Now it is under four percent and caught up the moment the
hand stops. Nothing about a still hand can show that up, which is why it survived
a suite that only ever tested one.

Both inputs are robust in a way raw depth is not — a least-squares scale fit, and
two 3D anatomical lengths that do not foreshorten at all. Depth is consulted for
exactly two bits, which way each angle leans, and even those are latched until the
evidence is unambiguous. Feeding the solver eight millimetres of noise on every
landmark's `z` moves the band by under a fifth of a millimetre.

**That fit is taken over the palm alone, and it matters more than it sounds.**
Over all twenty-one landmarks it reports an average distance, and the fingers
reach far enough out of the palm's plane that once the arm tips, the average stops
describing the knuckles the spans actually live on. Fitting the whole hand put the
recovered lean seven degrees out, showed a quarter of it as a roll instead, and
sized the band off an average distance rather than the wrist's own — which had the
piece swelling by a third on an arm reaching toward the camera. Over the palm
quad, the lean comes back within half a degree and the size within one percent.

Two more things fall out. The basis is orthonormal and right-handed by
construction, so there is no chirality to get wrong; and because the projection
has already applied the preview's mirror, a mirrored frame needs no special case.

**Which way the arm runs** starts as the palm's own direction carried past the
wrist, and is then **turned toward the elbow**. The hand model's twenty-one
landmarks end at the wrist, so there is nothing below it to measure a forearm
between — the palm's direction is exact while the hand is in line with the arm
and wrong by the angle of the bend when it is not. Wrong as a *rotation about the
wrist*, too, so a hand held at a right angle did not tip the band, it put it
beside the arm, a band-radius-and-a-third off.

No amount of work on the hand's own points recovers a direction they do not
contain, so bracelet mode runs the pose model alongside — the same one the
necklace uses — purely for the elbow, on one frame in three. It arrives as a
*hint* with a confidence and the axis rotates toward it by that much, because the
elbow is the joint the lite pose weights are weakest at and it is often half out
of frame. The piece is placed from the hand and merely corrected by the arm, so a
pose model that is slow to load or missing altogether costs a bent-wrist
correction and nothing else.

**Seat** is the wrist landmark plus just under one band radius down that
direction — foreshortened by the recovered lean, or the band walks off the end of
an arm that has got shorter on screen.

**Size** is the wearer's measured breadth times that palm scale, carried the
length of the palm to the wrist's own distance from the lens, since the scale
describes the palm and the band sits further down the arm. Written as a
multiplication throughout, and deliberately: the one correction that still
divides is fenced, and it is driven by the lean, which has already been faded out
wherever the evidence for it is weak — so it multiplies by one exactly when it is
least sure of itself. A rolled wrist looks narrower and the band narrows with it,
but by being *turned*, not by being drawn smaller; drawing it smaller took the
band's width along the arm down too, which nothing about a roll should touch.

The forearm occluder is an **open tube**, unlike the ring's capped cylinder. A
fingertip is a real surface that really does hide what is behind it; a forearm
has no such end, it carries on out of the frame both ways. Capping it invents a
surface that is not there — and the moment the arm leans toward the lens that
invented cap lands between the camera and the band and hides the whole bracelet
rather than its far arc.

The world landmarks' millimetres are still read, but only to *report* a size in
the sizing panel and to decide how many stones a row gets — the renderer divides
the drawn radius by the built one, so an error there cancels out of what appears
on screen.

The band itself is an ellipse, not a circle — a wrist is about three-quarters as
deep as it is wide, and a circular band drawn at the right circumference is
visibly too deep from the side. The forearm occluder takes the same section. A few
degrees of drape keep the band off perfectly square-on, because a band exactly
perpendicular to the screen projects its near and far rims onto each other and
reads as a flat hoop painted on the arm.

Both bracelets are American diamond, set through a full 360°. The stone count in
each row comes from the band's own measured perimeter rather than a fixed number,
so a larger wrist gets more stones instead of larger ones, and every row closes on
itself — a piece with a plain back spends half of any try-on showing the back.
All of the stones are one geometry placed by instance transform, so a
hundred-and-seventy-stone band is a single draw call on top of live tracking.

### Earrings

**Tracked by a third model, and that was not the first attempt.** Earrings were
built on the pose model, because the necklace already used it and it has ear
landmarks. It has eleven coarse face points inferred as part of a whole-body
estimate, and they wander by more than an earring is wide — so the pieces sat
near a face rather than on its ears, and nothing downstream could fix an anchor
that was not there. The necklace is right to use that model; a necklace hangs off
a shoulder line half a metre across. A lobe is not that.

The face model spends all 478 of its points on the face alone. Three things fall
out of the dense silhouette that the previous build had to estimate and got
wrong:

- **Where the ear is**, from MediaPipe's own canonical face model rather than
  from reasoning about it. The mesh has no ear or lobe vertex — it stops at the
  silhouette — so an anchor has to be chosen from what it does have, and in that
  model's units the two candidate contour points sit at heights +0.67 and −1.05
  against a nose tip at −1.13 and a chin at −9.40. An earlobe is level with the
  nose, so the lower point is the one at lobe height and the upper is a
  centimetre above it, up by the ear canal. Both earlier guesses hung the pieces
  high, which is what "they are on my face" turned out to mean.
- **How far the head is turned, from the nose.** It sits on the midline and well
  forward of the silhouette, so a turn swings it off centre; its offset over the
  face's width is the *tangent* of the turn. A tangent rather than a cosine
  matters: foreshortening cues are flat near zero, where a one percent error is
  worth eight degrees, and that is exactly where heads spend their time. This one
  is best conditioned in the pose people actually hold, and comes out signed, so
  there is no direction to resolve and nothing to latch.
- **How big to draw the piece**, from the face's width against a nominal.
  Bizygomatic breadth is one of the tightest dimensions on an adult body, so a
  fixed figure beats anything a camera can infer without a ruler in shot — and it
  is what stopped a 28 mm earring being drawn across someone's face when a metric
  model mis-measured their head.

None of it needs a metric model, a distance or any depth: every quantity is a
length on screen and every answer is a ratio of two of them.

The piece **hangs rather than being stuck on**: vertical comes first and the ear
yields to it, so tipping your head leaves a jhumka pointing at the floor. Build
the frame the other way round and the two constraints fight — outward tips with
the ear line, up must stay square to outward, so up tips too and the earring
rolls after all. **The two are also not the same size**: on a head turned
forty-five degrees the near ear is most of a face width closer to the lens, so
the near earring is genuinely larger, and one shared conversion draws them
identically and the head reads flat.

A depth-only sphere stands in for the head, so the far earring goes behind the
cheek rather than through it. It is deliberately a little narrower than the face:
as wide as the silhouette and it swallows the near earring too.

**Show diagnostics** matters more here than anywhere else, because "it is not on
my ears" covers several unrelated faults that look identical in the finished
render. The overlay draws the tracker's own landmarks in blue and the lobe it
hung each piece from in gold, so: blue dots off the face is a tracking problem;
blue right and gold wrong is the lobe drop, which is a slider rather than a bug;
gold right and no jewellery is the head's stand-in swallowing the pair; and
nothing at all is a refused solve, which says so in words.

## Adding an imported ring

A GLB drops into the same placement path as the generated rings, provided it is
normalised to the convention they use:

```
bore radius 1  ·  +Z along the finger  ·  +Y toward the back of the hand
origin at the centre of the bore
```

Everything downstream — the pose solver, the finger occluder, the contact shadow, the
depth compensation — is expressed in multiples of the band's inner radius, so a model
in those terms needs no special handling anywhere.

```bash
npx tsx scripts/fit-glb-ring.mjs public/models/ring.glb
```

That prints the scale to paste into the ring's `glb` block. It finds the bore as the
largest **enclosed** empty circle across every vertex, which is worth knowing because
two more obvious methods both pick the wrong axis on a real ring: the smallest
bounding-box extent is not the band's width once a head spreads along the finger, and
the inertia tensor's largest principal moment identifies the hole axis only for a thin
loop — with a substantial head, all three moments land within 20% of each other.

The `design` block still has to be filled in for an imported ring, because the
occluder and the contact shadow are sized from it. Use the **shank's** dimensions, not
the model's overall extent: `npm run verify` compares the declared numbers against the
mesh and fails if they disagree.

## Testing

`npm run verify` runs four suites against synthetic data, so none of them needs a
camera:

- **Solver** — drives the ring pose solver with a synthetic hand built from known
  anthropometric dimensions and a real pinhole projection, then asserts scale
  recovery, finger measurement, seat position, orientation, true-scale sizing,
  metric bias, mirroring, depth placement, chirality on a flat hand, a full 360°
  rotation sweep, and a pose matrix (tilts, rolls, near/far, bent finger, frame
  edge, mirrored selfie).
- **Necklace** — the same treatment for the pose solver, driven by a synthetic
  upper body: neck measurement from two cues, anchor placement, turning the head,
  a shoulder leaving frame, and that the neck occluder never swallows the piece.
- **Bracelet** — wrist measurement, seat position down the forearm, the arm swung
  right round the frame, leaned toward and away from the lens, and rolled. The
  placement decisions are pinned directly: eight millimetres of noise on every
  landmark's depth must barely move the piece, a lean must not be read as a roll,
  the seat must foreshorten with the arm, and a roll must narrow the band without
  touching its width along the arm. A bent wrist is checked from both sides: it
  has to put the band off the arm when there is no elbow to consult, and back on
  it when there is. One section shakes *every* landmark, image ones included, and
  watches the largest single-frame step rather than the average — the failures
  worth catching there are discontinuities, and a latched sign or a clamp that
  swaps one size law for another sits perfectly still either side of its jump. It also checks the band itself, because two of
  its failure modes are silent: a left-handed stone frame still produces a
  quaternion and sets stones facing the wrong way, and a row laid from a fixed
  count instead of the band's measured length leaves a gap at the back that only
  appears when the wearer turns their wrist.
- **Earring** — face measurement, where the pair hangs, a tipped head, a turned
  head, and the same combined-movement section the bracelet has. Its synthetic
  subject is transcribed from MediaPipe's canonical face model, which is the
  second lesson this suite has taught the hard way: the first version made a face
  up, gave it a nose 0.39 of its width forward where a real one is 0.657, and
  passed every check while over-estimating real head turns by nearly half. The
  version before that passed everything while the pieces sat beside people's
  ears, because it was built on the pose model. **A synthetic subject can only
  ever validate the arithmetic — the anatomy has to come from somewhere real.** Two of its checks exist because the faults they catch were
  made: a hanging piece must stay upright through a forty-five degree head tilt,
  and a stud — which does not hang — must sit *on* the lobe rather than above it.
- **Geometry** — checks every generated ring for degenerate triangles, inverted
  winding via signed volume, physically plausible band dimensions, and that the
  floral head clears its shank.

Press the **Show diagnostics** toggle in the studio to overlay the tracked
skeleton, the finger axis, the ring's bounding box, and the numeric rotation,
scale and measured width.

## Layout

```
src/lib/hand/          hand tracking: landmarks, filtering, projection, ring and wrist solvers
src/lib/neck/          pose tracking and the necklace solver
src/lib/face/          face tracking and the earring solver
src/lib/rings/         ring geometry, catalogue, sizing tables
src/lib/jewellery/     necklace, bracelet and earring geometry, catalogues, wrist fit
src/components/three/  3D rendering: pieces, materials, occluders, shadows
src/components/tryon/  the try-on studio UI
src/components/site/   catalogue and product pages
scripts/               verification suites and asset setup
```

## Known limitations

- **Rings** are occluded geometrically, not per-pixel — stand-ins for the hand,
  which means anything else that comes between the camera and your hand has no
  representation in the scene and the ring draws over it. The hand model produces no
  segmentation mask, so fixing this needs a second model.
- **Necklaces** do use a per-pixel mask, so a foreign object held in front hides the
  piece. It separates you from everything else, though, not one part of you from
  another — your own hand still counts as you, so raising it to your throat will not
  hide the necklace.
- **Bracelets** are placed from the hand, because the hand model has no landmark
  below the wrist, so the whole palm has to stay visible even though the piece
  sits under it. A bent wrist is corrected from the pose model's elbow, which
  means bracelet mode is the only one running two models at once — and when the
  elbow is out of shot or the pose model has not loaded, the bend goes
  uncorrected rather than the piece disappearing.
- The **ring** and the **necklace** still take `DEFAULT_ONE_EURO`'s speed
  coefficient, which is in the wrong units for every signal they apply it to, and
  the ring additionally fits its scale from already-smoothed landmarks. Both
  therefore lag a moving subject the way the bracelet used to. It shows less on a
  ring, because the error is proportional and a ring is a third the size — but it
  is the same bug, left alone here rather than changed without being asked for.
- **Earrings** are placed from the face silhouette's widest points, which sit at
  the notch in front of the ear canal rather than at the lobe — so the drop below
  them is a population average, and someone with unusually long lobes will want
  the placement slider. Earring mode is also the only one that loads a third
  model, so it costs an extra 3.8 MB on first visit.
- On a hand doing everything at once the bracelet's size is within about four
  percent for half the frames and eight for nineteen in twenty, and the band sits
  within a tenth of its own radius of where it belongs. Those are the numbers the
  combined-motion check pins; they are not zero, and the honest reason is that
  every one of them is ultimately a filter's lag against a moving subject.
- A bracelet's two lean angles come from a cosine, which is worst conditioned
  exactly where it is measured most often — near square-on, a one percent error in
  the scale is worth eight degrees of recovered angle. It is the right way round,
  since a band tipped a few degrees when it should be flat is not something anyone
  can see, but it means the angles are an estimate and the *seat* is what is
  actually accurate. Past about sixty degrees of roll the cosine law itself gives
  out, because the two knuckles are no longer the same distance from the lens.
- One hand at a time.
- MediaPipe's relative depth is its noisiest output, so neighbouring-finger
  occlusion is biased slightly backwards — the failure mode is showing a little
  too much ring rather than deleting part of it.
- Measuring the finger from video pixels is off by default; it is unbiased when it
  works, and undersizes the ring when it mistakes a crease for the finger's edge.
