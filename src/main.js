import './style.css'
import { zipSync } from 'fflate'
import { createPool } from './pool.js'
import { borderWidth, frameSize, RATIOS } from './geometry.js'
import { formatBytes, outputFileName, timestamp } from './format.js'

const $ = (selector) => document.querySelector(selector)

const elements = {
  panel: $('#settings-panel'),
  form: $('#settings'),
  width: $('#width'),
  method: $('#method'),
  format: $('#format'),
  quality: $('#quality'),
  frame: $('#frame'),
  background: $('#background'),
  borderPercent: $('#borderPercent'),
  borderColor: $('#borderColor'),
  add: $('#add'),
  reprocess: $('#reprocess'),
  zip: $('#zip'),
  clear: $('#clear'),
  drop: $('#drop'),
  files: $('#files'),
  results: $('#results'),
  summary: $('#summary'),
  progress: $('#progress'),
  progressBar: $('#progress-bar'),
  progressLabel: $('#progress-label'),
  qualityValue: $('#quality-value'),
  borderValue: $('#border-value'),
  borderHint: $('#border-hint'),
  frameHint: $('#frame-hint'),
  cardTemplate: $('#card-template'),
  actions: $('.topbar-actions'),
  preview: $('#preview'),
  previewOriginal: $('#preview-original'),
  previewOutput: $('#preview-output'),
  previewOriginalMeta: $('#preview-original-meta'),
  previewOutputMeta: $('#preview-output-meta'),
  previewName: $('#preview-name'),
  previewClose: $('#preview-close'),
}

/** Each concurrent worker can hold a decoded 24 MP frame, so stay modest. */
const pool = createPool(Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1)))

const items = []
const cards = new Map()
const queue = []
let draining = false
let nextId = 0

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(number, min), max)
}

// Read from the controls rather than FormData: a disabled control is excluded
// from FormData, and the quality slider is disabled for PNG output.
function readSettings() {
  return {
    width: clampNumber(elements.width.value, 100, 8000, 1080),
    method: elements.method.value,
    format: elements.format.value,
    quality: clampNumber(elements.quality.value, 1, 100, 90),
    frame: elements.frame.value,
    background: elements.background.value,
    borderPercent: clampNumber(elements.borderPercent.value, 0, 20, 0),
    borderColor: elements.borderColor.value,
  }
}

function isImageFile(file) {
  return file.type.startsWith('image/') || /\.(jpe?g|png|webp|avif|heic|heif)$/i.test(file.name)
}

function createCard(item) {
  const node = elements.cardTemplate.content.firstElementChild.cloneNode(true)
  node.querySelector('.card-name').textContent = item.file.name
  node.querySelector('.thumb').addEventListener('click', () => openPreview(item))
  node.querySelector('.card-retry').addEventListener('click', () => schedule([item]))
  elements.results.append(node)
  updateCard(item)
  return node
}

function updateCard(item) {
  const node = cards.get(item.id)
  if (!node) return

  const thumb = node.querySelector('.thumb')
  const image = node.querySelector('.thumb img')
  const badge = node.querySelector('.badge')
  const dims = node.querySelector('.card-dims')
  const sizes = node.querySelector('.card-sizes')
  const save = node.querySelector('.card-save')
  const retry = node.querySelector('.card-retry')

  node.dataset.status = item.status
  node.classList.toggle('is-stale', item.stale)

  if (item.status === 'done') {
    image.src = item.outputUrl
    image.alt = item.file.name
    badge.hidden = true
    dims.textContent = `${item.result.sourceWidth}×${item.result.sourceHeight} → ${item.result.width}×${item.result.height}`
    sizes.textContent = `${formatBytes(item.file.size)} → ${formatBytes(item.result.blob.size)}`
    save.href = item.outputUrl
    save.download = outputFileName(item.file.name, item.result.extension)
    save.hidden = false
    retry.hidden = true
  } else if (item.status === 'error') {
    image.removeAttribute('src')
    image.alt = ''
    badge.hidden = false
    badge.textContent = 'Failed'
    dims.textContent = item.error
    sizes.textContent = ''
    save.hidden = true
    retry.hidden = false
  } else {
    image.removeAttribute('src')
    image.alt = ''
    badge.hidden = false
    badge.textContent = item.status === 'processing' ? 'Working' : 'Queued'
    dims.textContent = item.status === 'processing' ? 'Compressing…' : 'Waiting'
    sizes.textContent = ''
    save.hidden = true
    retry.hidden = true
  }

  if (item.stale && item.status === 'done') {
    badge.hidden = false
    badge.textContent = 'Stale'
  }

  thumb.disabled = item.status !== 'done'
}

function updateSummary() {
  if (items.length === 0) {
    elements.summary.textContent = ''
    return
  }
  const ready = items.filter((item) => item.status === 'done')
  const inputBytes = items.reduce((sum, item) => sum + item.file.size, 0)
  const outputBytes = ready.reduce((sum, item) => sum + item.result.blob.size, 0)
  elements.summary.textContent = `${ready.length}/${items.length} ready · ${formatBytes(inputBytes)} → ${formatBytes(outputBytes)}`
}

function updateChrome() {
  const stale = items.filter((item) => item.stale)
  const failed = items.filter((item) => item.status === 'error')

  elements.zip.disabled = !items.some((item) => item.status === 'done')
  elements.clear.disabled = items.length === 0
  elements.reprocess.hidden = stale.length + failed.length === 0
  elements.reprocess.disabled = draining
  elements.reprocess.textContent =
    stale.length > 0 ? `Reprocess ${stale.length}` : `Retry ${failed.length}`

  updateSummary()
}

function updateProgress(completed, total) {
  elements.progressBar.style.width = `${Math.round((completed / total) * 100)}%`
  elements.progressLabel.textContent = `Processing ${completed} of ${total}`
  updateSummary()
}

function schedule(targets) {
  for (const item of targets) {
    if (queue.includes(item)) continue
    queue.push(item)
    item.stale = false
    updateCard(item)
  }
  updateChrome()
  if (!draining) void drain()
}

async function drain() {
  draining = true
  try {
    while (queue.length > 0) {
      const batch = queue.splice(0, queue.length)
      await runBatch(batch)
    }
  } finally {
    draining = false
    elements.progress.hidden = true
    updateChrome()
  }
}

async function runBatch(batch) {
  const settings = readSettings()
  let completed = 0

  for (const item of batch) {
    item.status = 'queued'
    item.error = null
    updateCard(item)
  }

  elements.progress.hidden = false
  updateProgress(0, batch.length)

  await Promise.all(
    batch.map(async (item) => {
      try {
        const response = await pool.run(
          { file: item.file, settings },
          {
            onStart: () => {
              item.status = 'processing'
              updateCard(item)
            },
          },
        )
        if (!response.ok) throw new Error(response.error)
        if (item.outputUrl) URL.revokeObjectURL(item.outputUrl)
        item.result = response
        item.outputUrl = URL.createObjectURL(response.blob)
        item.status = 'done'
      } catch (error) {
        item.status = 'error'
        item.error = error?.message || String(error)
        item.result = null
      }
      completed += 1
      updateCard(item)
      updateProgress(completed, batch.length)
    }),
  )
}

function addFiles(fileList) {
  const files = Array.from(fileList).filter(isImageFile)
  if (files.length === 0) return

  const added = files.map((file) => {
    const item = {
      id: `item-${(nextId += 1)}`,
      file,
      status: 'queued',
      error: null,
      result: null,
      outputUrl: null,
      stale: false,
    }
    items.push(item)
    cards.set(item.id, createCard(item))
    return item
  })

  updateChrome()
  schedule(added)
}

function markStale() {
  let changed = false
  for (const item of items) {
    if (item.status === 'done' && !item.stale) {
      item.stale = true
      updateCard(item)
      changed = true
    }
  }
  if (changed) updateChrome()
}

function syncReadouts() {
  const settings = readSettings()
  elements.qualityValue.textContent = String(settings.quality)
  elements.borderValue.textContent = `${settings.borderPercent}%`
  elements.quality.disabled = settings.format === 'png'

  const frame = frameSize(settings.width, RATIOS[settings.frame] ?? null, settings.borderPercent)
  elements.frameHint.textContent = frame
    ? `Frame ${frame.width} × ${frame.height} px`
    : `Width ${settings.width} px`

  const border = borderWidth(settings.width, settings.borderPercent)
  if (border === 0) {
    elements.borderHint.textContent = 'Drawn outside the frame. The output width stays on target.'
  } else if (frame) {
    elements.borderHint.textContent = `${border} px per side · output ${settings.width} × ${frame.height + border * 2} px`
  } else {
    elements.borderHint.textContent = `${border} px per side · output ${settings.width} px wide`
  }
}

let previewOriginalUrl = null

function openPreview(item) {
  if (item.status !== 'done') return

  previewOriginalUrl = URL.createObjectURL(item.file)
  elements.previewOriginal.src = previewOriginalUrl
  elements.previewOutput.src = item.outputUrl
  elements.previewOriginalMeta.textContent = `${item.result.sourceWidth} × ${item.result.sourceHeight} · ${formatBytes(item.file.size)}`
  elements.previewOutputMeta.textContent = `${item.result.width} × ${item.result.height} · ${formatBytes(item.result.blob.size)}`
  elements.previewName.textContent = outputFileName(item.file.name, item.result.extension)
  elements.preview.showModal()
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function uniqueName(taken, name) {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  let index = 2
  while (taken.has(`${stem}-${index}${extension}`)) index += 1
  return `${stem}-${index}${extension}`
}

async function downloadZip() {
  const ready = items.filter((item) => item.status === 'done')
  if (ready.length === 0) return

  elements.zip.disabled = true
  try {
    const taken = new Set()
    const archive = {}
    for (const item of ready) {
      const name = uniqueName(taken, outputFileName(item.file.name, item.result.extension))
      taken.add(name)
      archive[name] = new Uint8Array(await item.result.blob.arrayBuffer())
    }
    saveBlob(new Blob([zipSync(archive, { level: 0 })], { type: 'application/zip' }), `photowalk-${timestamp()}.zip`)
  } finally {
    elements.zip.disabled = false
  }
}

elements.add.addEventListener('click', () => elements.files.click())
elements.drop.addEventListener('click', () => elements.files.click())
elements.drop.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  elements.files.click()
})

elements.files.addEventListener('change', () => {
  addFiles(elements.files.files)
  elements.files.value = ''
})

elements.form.addEventListener('input', () => {
  syncReadouts()
  markStale()
})

elements.reprocess.addEventListener('click', () => {
  schedule(items.filter((item) => item.stale || item.status === 'error'))
})

elements.zip.addEventListener('click', () => void downloadZip())

elements.clear.addEventListener('click', () => {
  for (const item of items) {
    if (item.outputUrl) URL.revokeObjectURL(item.outputUrl)
  }
  items.length = 0
  cards.clear()
  elements.results.replaceChildren()
  updateChrome()
})

elements.previewClose.addEventListener('click', () => elements.preview.close())
elements.preview.addEventListener('click', (event) => {
  if (event.target === elements.preview) elements.preview.close()
})
elements.preview.addEventListener('close', () => {
  if (previewOriginalUrl) URL.revokeObjectURL(previewOriginalUrl)
  previewOriginalUrl = null
  elements.previewOriginal.removeAttribute('src')
  elements.previewOutput.removeAttribute('src')
})

for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (event) => {
    event.preventDefault()
    elements.drop.classList.add('is-over')
  })
}
document.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) elements.drop.classList.remove('is-over')
})
document.addEventListener('drop', (event) => {
  event.preventDefault()
  elements.drop.classList.remove('is-over')
  if (event.dataTransfer) addFiles(event.dataTransfer.files)
})

const wideViewport = window.matchMedia('(min-width: 900px)')

function syncSettingsPanel() {
  elements.panel.open = wideViewport.matches
}

wideViewport.addEventListener('change', syncSettingsPanel)
syncSettingsPanel()

// The action bar wraps on narrow screens, so the page needs its real height as
// bottom padding to keep the last card clear of it.
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--bottombar-h', `${elements.actions.offsetHeight}px`)
}).observe(elements.actions)

syncReadouts()
updateChrome()
