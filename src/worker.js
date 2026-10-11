import { processCollage, processImage } from './pipeline.js'

self.onmessage = async (event) => {
  const message = event.data
  try {
    if (message?.kind === 'collage') {
      const result = await processCollage(message)
      self.postMessage({ ok: true, ...result })
    } else {
      const { file, settings } = message
      const result = await processImage(file, settings)
      self.postMessage({ ok: true, ...result })
    }
  } catch (error) {
    self.postMessage({ ok: false, error: error?.message || String(error) })
  }
}
