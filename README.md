# imgutils

A client-side batch image compressor and framer. Drop in camera photos, resize
them, frame them to a social aspect ratio, and export the result.

Nothing is uploaded. All decoding, resizing, and encoding run in Web Workers in
your browser.

## Commands

```sh
pnpm install
pnpm dev       # development server
pnpm build     # production bundle in dist/
pnpm preview   # serve the production bundle
```

## Features

- Bulk import by file picker or drag and drop.
- Resize to a target width with jsquash. The default is 1080 px and Lanczos3.
- Encode to JPEG, WebP, or PNG at a selectable quality.
- Frame to an aspect ratio, such as 4:5. The photo is centered on the frame, so
  a landscape photo sits in the middle of a portrait frame.
- Add a border. The width is a percentage of the frame, and the border wraps the
  frame from the outside, so the output width stays on target and the frame
  shrinks to make room.
- Monochrome, square-cornered layout that works on a phone: the settings panel
  collapses, results show two per row, and the actions sit in a bottom bar.

## How the pipeline works

Each file goes through these steps in a worker:

1. **Decode.** `createImageBitmap` with `imageOrientation: 'from-image'` applies
   the EXIF orientation tag, so camera photos are not sideways.
2. **Resize.** If the source is more than twice the target size, the browser
   scales it to twice the target size first. jsquash then applies Lanczos3 to
   the exact target size. The two steps bound the memory that a 24 MP photo
   needs and avoid aliasing from a single large reduction.
3. **Frame.** The width is the target for the whole output, so a 4:5 frame at
   1080 gives 1080 × 1350 and a 16:9 frame gives 1080 × 608. The photo is
   centered on the background color.
4. **Border.** The border wraps the frame, so it takes its share of the target
   width. A 4% border at 1080 is 40 px per side and leaves a 1000 px frame. The
   output width stays 1080.
5. **Encode.** jsquash encodes the result to the selected format.

The pipeline never upscales. A photo smaller than the target keeps its own size
and is centered on the frame.

## Layout

```
index.html          markup and the settings form
src/main.js         state, settings, worker pool, downloads
src/pipeline.js     decode, resize, frame, border, encode (worker side)
src/worker.js       worker message handler
src/pool.js         worker pool with bounded concurrency
src/geometry.js     frame ratios and size math
src/format.js       byte and filename formatting
src/style.css       light theme
```

The worker pool runs one job per CPU core, up to three jobs. Each job can hold a
decoded 24 MP frame, so the limit keeps peak memory in check.
