// @ccllc/arcade/render — the drawing every game here was writing twice.
//
// This package has always drawn nothing, on purpose: a simulation that renders
// is a simulation you cannot replay. That stays true. What is here is not a
// renderer in the sense of deciding how a game looks — every appearance
// decision is still a callback the game supplies. It is the *arithmetic* around
// drawing, which is identical in all of them and wrong in all of them in the
// same way: repainting a picture that did not change.
//
// Four modules, in the order they pay off:
//
//   layers  — a picture cached on its own canvas, repainted only on a key
//             change, plus the scrolling-tilemap case built on it. This is
//             where the frame time actually is: path-drawn tiles cost 3.35 ms
//             a frame and blitting three cached layers costs 0.011 ms.
//   sprites — one cache serving procedural and raster sprites both, because a
//             procedural sprite is a recipe and a recipe can be baked.
//   presenter — a final nearest-neighbour pass for a fixed-size source image,
//               with optional scanline/LCD filters, Abuse's tube shader as an
//               opt-in, and a useful 2d fallback.
//   motion  — poses interpolated between fixed steps by the `alpha` the loop
//             already hands out, so motion is as smooth as the display
//             instead of as coarse as the simulation.
//
// Everything here is presentation, which means the rules that bind the
// simulation do not apply: this code may use the wall clock, floating point and
// `Math.random` freely, and two machines running it may disagree about every
// pixel. What it must never do is feed anything back into `step()`.

export * from "./layers.js";
export * from "./sprites.js";
export * from "./presenter.js";
export * from "./motion.js";
