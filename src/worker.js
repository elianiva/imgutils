import { processImage } from './pipeline.js'

self.onmessage = async (event) => {
  const { file, settings } = event.data
  try {
    const result = await processImage(file, settings)
    self.postMessage({ ok: true, ...result })
  } catch (error) {
    self.postMessage({ ok: false, error: error?.message || String(error) })
  }
}
