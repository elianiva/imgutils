import resize from '@jsquash/resize'
import encodeJpeg from '@jsquash/jpeg/encode'
import encodeWebp from '@jsquash/webp/encode'
import encodePng from '@jsquash/png/encode'
import { outputGeometry } from './geometry.js'

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
