import resize from '@jsquash/resize'
import encodeJpeg from '@jsquash/jpeg/encode'
import encodeWebp from '@jsquash/webp/encode'
import encodePng from '@jsquash/png/encode'
import { outputGeometry } from './geometry.js'
import { RATIOS, borderWidth, frameSize } from './geometry.js'
import { clampGap, coverSourceRect, layoutCells } from './collage.js'

/**
 * How far the browser's own scaler may shrink a photo before jsquash takes
 * over. Decoding a 24 MP photo straight into an ImageData costs ~96 MB per
 * worker; two intermediate steps stay sharp and keep that cost small.
 */
const PRE_SHRINK = 2

const FORMATS = {
  jpeg: {
    extension: 'jpg',
    type: 'image/jpeg',
    encode: (data, quality) =>
      encodeJpeg(data, {
        quality,
        progressive: true,
        optimize_coding: true,
        auto_subsample: true,
      }),
  },
  webp: {
    extension: 'webp',
    type: 'image/webp',
    encode: (data, quality) => encodeWebp(data, { quality, method: 4 }),
  },
  png: {
    extension: 'png',
    type: 'image/png',
    encode: (data) => encodePng(data),
  },
}

function drawToImageData(bitmap, width, height) {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, width, height)
  return context.getImageData(0, 0, width, height)
}

/**
 * Paints the border band, then lays the frame over the middle of it. The border
 * sits outside the frame, so the frame is inset by the border on every side.
 */
function compose(imageData, canvas, border, settings) {
  const width = canvas.width + border * 2
  const height = canvas.height + border * 2

  const surface = new OffscreenCanvas(width, height)
  const context = surface.getContext('2d', { willReadFrequently: true })

  context.fillStyle = settings.borderColor
  context.fillRect(0, 0, width, height)

  if (border > 0) {
    context.fillStyle = settings.background
    context.fillRect(border, border, canvas.width, canvas.height)
  }

  context.putImageData(
    imageData,
    border + Math.round((canvas.width - imageData.width) / 2),
    border + Math.round((canvas.height - imageData.height) / 2),
  )

  return context.getImageData(0, 0, width, height)
}

/**
 * Shrink a decoded photo toward twice its cell size before drawing, so a
 * 9-cell collage of 24 MP photos never holds 9 full frames at once. Falls
 * back to the original bitmap when the browser cannot resize on decode.
 */
async function fitBitmap(bitmap, destWidth, destHeight) {
  const capWidth = Math.max(1, Math.ceil(destWidth * 2))
  const capHeight = Math.max(1, Math.ceil(destHeight * 2))
  if (bitmap.width <= capWidth && bitmap.height <= capHeight) return bitmap
  const scale = Math.min(capWidth / bitmap.width, capHeight / bitmap.height)
  try {
    const small = await createImageBitmap(bitmap, {
      resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
      resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
      resizeQuality: 'high',
    })
    bitmap.close()
    return small
  } catch {
    return bitmap
  }
}

/**
 * Compose N photos into one framed grid and encode it like a single photo.
 * `job` carries the worker message: { files, cells, template, ratio,
 * gapPercent, settings }. files[i] is a File or null for an empty slot;
 * cells[i] is { zoom, fx, fy } with fx/fy in 0..1. Empty slots stay on the
 * background color so a half-filled grid still exports.
 */
export async function processCollage(job) {
  const { files, cells, template, ratio, gapPercent, settings } = job
  const frame = frameSize(settings.width, RATIOS[ratio] ?? 1, settings.borderPercent)
  const border = borderWidth(settings.width, settings.borderPercent)
  const gap = clampGap(
    template,
    frame.width,
    frame.height,
    Math.round(frame.width * (Math.max(0, gapPercent || 0) / 100)),
  )
  const rects = layoutCells(template, frame.width, frame.height, gap)

  const surface = new OffscreenCanvas(frame.width, frame.height)
  const context = surface.getContext('2d', { willReadFrequently: true })
  context.fillStyle = settings.background
  context.fillRect(0, 0, frame.width, frame.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'

  let count = 0
  for (let index = 0; index < rects.length; index += 1) {
    const file = files[index]
    if (!file) continue
    let bitmap
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      throw new Error(`Photo ${index + 1} cannot be decoded by this browser`)
    }
    try {
      const rect = rects[index]
      const fit = await fitBitmap(bitmap, rect.w, rect.h)
      const adjust = cells[index] || {}
      const src = coverSourceRect(
        fit.width,
        fit.height,
        rect.w,
        rect.h,
        adjust.zoom ?? 1,
        adjust.fx ?? 0.5,
        adjust.fy ?? 0.5,
      )
      context.drawImage(fit, src.sx, src.sy, src.sw, src.sh, rect.x, rect.y, rect.w, rect.h)
      if (fit !== bitmap) fit.close()
      count += 1
    } finally {
      bitmap.close()
    }
  }

  if (count === 0) throw new Error('Add at least one photo to the collage')

  let framed = context.getImageData(0, 0, frame.width, frame.height)
  if (border > 0) {
    const outer = new OffscreenCanvas(frame.width + border * 2, frame.height + border * 2)
    const outerContext = outer.getContext('2d', { willReadFrequently: true })
    outerContext.fillStyle = settings.borderColor
    outerContext.fillRect(0, 0, outer.width, outer.height)
    outerContext.putImageData(framed, border, border)
    framed = outerContext.getImageData(0, 0, outer.width, outer.height)
  }

  const format = FORMATS[settings.format] ?? FORMATS.jpeg
  const buffer = await format.encode(framed, settings.quality)

  return {
    blob: new Blob([buffer], { type: format.type }),
    extension: format.extension,
    width: framed.width,
    height: framed.height,
    count,
  }
}

export async function processImage(file, settings) {
  let bitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('This browser cannot decode the file')
  }

  const sourceWidth = bitmap.width
  const sourceHeight = bitmap.height
  const { canvas, border, photo } = outputGeometry(sourceWidth, sourceHeight, settings)

  const shrink = Math.max(sourceWidth, sourceHeight) > Math.max(photo.width, photo.height) * PRE_SHRINK
  const decodeWidth = shrink ? photo.width * PRE_SHRINK : photo.width
  const decodeHeight = shrink ? photo.height * PRE_SHRINK : photo.height

  let imageData
  try {
    imageData = drawToImageData(bitmap, decodeWidth, decodeHeight)
  } finally {
    bitmap.close()
  }

  if (shrink) {
    imageData = await resize(imageData, {
      width: photo.width,
      height: photo.height,
      method: settings.method,
      fitMethod: 'stretch',
      premultiply: true,
      linearRGB: true,
    })
  }

  const framed =
    border > 0 || imageData.width !== canvas.width || imageData.height !== canvas.height
      ? compose(imageData, canvas, border, settings)
      : imageData

  const format = FORMATS[settings.format] ?? FORMATS.jpeg
  const buffer = await format.encode(framed, settings.quality)

  return {
    blob: new Blob([buffer], { type: format.type }),
    extension: format.extension,
    width: framed.width,
    height: framed.height,
    sourceWidth,
    sourceHeight,
  }
}
