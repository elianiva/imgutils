/** Frame presets. The value is width / height, so 4:5 is portrait. */
export const RATIOS = {
  original: null,
  '1:1': 1,
  '4:5': 4 / 5,
  '5:4': 5 / 4,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
}

/**
 * Border width for a target output width. The border sits outside the frame, so
 * the frame is narrower than the target and the output width stays on target.
 * A 4% border at a 1080 px width is 40 px, leaving a 1000 px frame.
 */
export function borderWidth(width, percent) {
  const fraction = percent / 100
  return Math.round((fraction / (1 + 2 * fraction)) * width)
}

/**
 * Frame size for a ratio at a target output width. Returns null when the frame
 * follows the photo's own ratio, which needs the source size.
 */
export function frameSize(width, ratio, borderPercent) {
  if (!ratio) return null
  const inner = width - borderWidth(width, borderPercent) * 2
  return { width: inner, height: Math.max(1, Math.round(inner / ratio)) }
}

/**
 * Scale a source down to fit a box, keeping its aspect ratio. Never upscales.
 * Pass `Infinity` for a box dimension that must not constrain the result.
 */
function fitInside(sourceWidth, sourceHeight, boxWidth, boxHeight) {
  const scale = Math.min(1, boxWidth / sourceWidth, boxHeight / sourceHeight)
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  }
}

/**
 * Output canvas, the border band around it, and the photo inside the canvas.
 * The width is the target for the whole output, so the border takes its share
 * and the frame is contained in what is left.
 */
export function outputGeometry(sourceWidth, sourceHeight, { width, frame, borderPercent }) {
  const ratio = RATIOS[frame] ?? null
  const border = borderWidth(width, borderPercent)

  // Without a frame the canvas is the photo, so the two always agree.
  if (!ratio) {
    const photo = fitInside(sourceWidth, sourceHeight, width - border * 2, Infinity)
    return { canvas: photo, border, photo }
  }

  const canvas = frameSize(width, ratio, borderPercent)
  const photo = fitInside(sourceWidth, sourceHeight, canvas.width, canvas.height)
  return { canvas, border, photo }
}
