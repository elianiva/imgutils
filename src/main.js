import './style.css'
import { zipSync } from 'fflate'
import { createPool } from './pool.js'
import { borderWidth, frameSize, RATIOS } from './geometry.js'
import {
  COLLAGE_TEMPLATES,
  cellCount,
  clampGap,
  coverSourceRect,
  fitGridForCount,
  getTemplate,
  layoutCells,
  panAdjust,
  uniformTemplate,
} from './collage.js'
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
  tabSingle: $('#tab-single'),
  tabCollage: $('#tab-collage'),
  singleView: $('#single-view'),
  collageView: $('#collage-view'),
  collageCanvas: $('#collage-canvas'),
  collageMeta: $('#collage-meta'),
  collageRatio: $('#collage-ratio'),
  collageSizeHint: $('#collage-size-hint'),
  collageGap: $('#collage-gap'),
  collageGapValue: $('#collage-gap-value'),
  templatePicker: $('#template-picker'),
  gridRows: $('#grid-rows'),
  gridCols: $('#grid-cols'),
  collageFiles: $('#collage-files'),
  cellFile: $('#cell-file'),
  collageAdd: $('#collage-add'),
  collageShuffle: $('#collage-shuffle'),
  collageClear: $('#collage-clear'),
  cellList: $('#cell-list'),
  cellTemplate: $('#cell-template'),
  cellCount: $('#cell-count'),
  cellZoom: $('#cell-zoom'),
  cellZoomValue: $('#cell-zoom-value'),
  cellFx: $('#cell-fx'),
  cellFxValue: $('#cell-fx-value'),
  cellFy: $('#cell-fy'),
  cellFyValue: $('#cell-fy-value'),
  cellLeft: $('#cell-left'),
  cellRight: $('#cell-right'),
  cellReset: $('#cell-reset'),
  collageSave: $('#collage-save'),
  collageStatus: $('#collage-status'),
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
  updateCollageChrome()
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
    saveBlob(new Blob([zipSync(archive, { level: 0 })], { type: 'application/zip' }), `imgutils-${timestamp()}.zip`)
  } finally {
    elements.zip.disabled = false
  }
}

/* Collage mode ------------------------------------------------------- */

const PREVIEW_WIDTH = 960

const collage = {
  ratio: '1:1',
  templateId: '4-grid',
  rows: 2,
  cols: 2,
  gap: 2,
  slots: [],
  selected: 0,
  saving: false,
  replaceIndex: -1,
}

let collageKey = 0
let collageToken = 0
let collagePreviewQueued = false
/** Last preview layout in canvas pixels, for pointer hit-testing. */
let collageHit = { rects: [], offsetX: 0, offsetY: 0 }

function makeSlot(file) {
  const slot = { key: `slot-${(collageKey += 1)}`, file, url: null, bitmap: null, broken: false, zoom: 1, fx: 0.5, fy: 0.5 }
  if (file) slot.url = URL.createObjectURL(file)
  return slot
}

function freeSlot(slot) {
  if (!slot) return
  if (slot.url) URL.revokeObjectURL(slot.url)
  if (slot.bitmap) slot.bitmap.close()
}

function resolveCollageTemplate() {
  if (collage.templateId === 'custom') return uniformTemplate(collage.rows, collage.cols)
  return getTemplate(collage.templateId) ?? uniformTemplate(collage.rows, collage.cols)
}

function syncCollageSlots(note) {
  const count = cellCount(resolveCollageTemplate())
  while (collage.slots.length < count) collage.slots.push(null)
  while (collage.slots.length > count) freeSlot(collage.slots.pop())
  collage.selected = Math.min(collage.selected, Math.max(0, collage.slots.length - 1))
  if (note) setCollageStatus(note)
}

function setCollageStatus(message) {
  elements.collageStatus.textContent = message
}

function selectedSlot() {
  return collage.slots[collage.selected] ?? null
}

/** Export canvas size at the real output width, mirroring the worker math. */
function collageExportSize() {
  const settings = readSettings()
  const frame = frameSize(settings.width, RATIOS[collage.ratio] ?? 1, settings.borderPercent)
  const border = borderWidth(settings.width, settings.borderPercent)
  return { width: frame.width + border * 2, height: frame.height + border * 2 }
}

function updateCollageMeta() {
  const template = resolveCollageTemplate()
  const filled = collage.slots.filter((slot) => slot?.file).length
  const size = collageExportSize()
  elements.collageMeta.textContent = `${filled}/${collage.slots.length} photos · ${template.label} · exports ${size.width}×${size.height} px`
  elements.collageSizeHint.textContent = `Exports at ${size.width} × ${size.height} px`
  elements.cellCount.textContent = `· ${filled}/${collage.slots.length}`
}

function updateCollageChrome() {
  const filled = collage.slots.filter((slot) => slot?.file).length
  elements.collageSave.disabled = collage.saving || filled === 0
  elements.collageSave.textContent = collage.saving ? 'Working…' : 'Save collage'

  const slot = selectedSlot()
  const empty = !slot?.file
  for (const control of [elements.cellZoom, elements.cellFx, elements.cellFy, elements.cellReset, elements.cellLeft, elements.cellRight]) {
    control.disabled = empty
  }
  elements.cellZoomValue.textContent = `${Math.round((slot?.zoom ?? 1) * 100)}%`
  elements.cellFxValue.textContent = String(Math.round((slot?.fx ?? 0.5) * 100))
  elements.cellFyValue.textContent = String(Math.round((slot?.fy ?? 0.5) * 100))
  if (document.activeElement !== elements.cellZoom) elements.cellZoom.value = String(Math.round((slot?.zoom ?? 1) * 100))
  if (document.activeElement !== elements.cellFx) elements.cellFx.value = String(Math.round((slot?.fx ?? 0.5) * 100))
  if (document.activeElement !== elements.cellFy) elements.cellFy.value = String(Math.round((slot?.fy ?? 0.5) * 100))

  updateCollageMeta()
}

async function collageBitmap(slot) {
  if (!slot?.file || slot.broken) return null
  if (!slot.bitmap) {
    try {
      slot.bitmap = await createImageBitmap(slot.file, { imageOrientation: 'from-image' })
    } catch {
      slot.broken = true
      return null
    }
  }
  return slot.bitmap
}

function requestCollagePreview() {
  if (collagePreviewQueued) return
  collagePreviewQueued = true
  requestAnimationFrame(() => {
    collagePreviewQueued = false
    void renderCollagePreview()
  })
}

async function renderCollagePreview() {
  const token = (collageToken += 1)
  const settings = readSettings()
  const template = resolveCollageTemplate()
  const ratio = RATIOS[collage.ratio] ?? 1
  const frame = frameSize(PREVIEW_WIDTH, ratio, settings.borderPercent)
  const border = borderWidth(PREVIEW_WIDTH, settings.borderPercent)
  const canvas = elements.collageCanvas
  canvas.width = frame.width + border * 2
  canvas.height = frame.height + border * 2

  const context = canvas.getContext('2d')
  context.fillStyle = settings.borderColor
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = settings.background
  context.fillRect(border, border, frame.width, frame.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'

  const gap = clampGap(template, frame.width, frame.height, Math.round(frame.width * (collage.gap / 100)))
  const rects = layoutCells(template, frame.width, frame.height, gap)
  collageHit = {
    rects: rects.map((rect) => ({ x: rect.x + border, y: rect.y + border, w: rect.w, h: rect.h })),
    offsetX: border,
    offsetY: border,
  }

  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index]
    const dx = rect.x + border
    const dy = rect.y + border
    const slot = collage.slots[index]
    const bitmap = await collageBitmap(slot)
    if (token !== collageToken) return
    if (!bitmap) {
      drawEmptyCell(context, dx, dy, rect.w, rect.h, index, slot?.broken)
      continue
    }
    const src = coverSourceRect(bitmap.width, bitmap.height, rect.w, rect.h, slot.zoom, slot.fx, slot.fy)
    context.drawImage(bitmap, src.sx, src.sy, src.sw, src.sh, dx, dy, rect.w, rect.h)
  }

  const selected = collageHit.rects[collage.selected]
  if (selected) {
    context.save()
    context.strokeStyle = '#111'
    context.lineWidth = Math.max(2, canvas.width / 240)
    context.strokeRect(selected.x + 1, selected.y + 1, selected.w - 2, selected.h - 2)
    context.restore()
  }
}

function drawEmptyCell(context, x, y, w, h, index, broken) {
  context.save()
  context.strokeStyle = '#a8a8a8'
  context.setLineDash([6, 5])
  context.lineWidth = 1.5
  context.strokeRect(x + 8, y + 8, Math.max(1, w - 16), Math.max(1, h - 16))
  context.setLineDash([])
  context.fillStyle = '#6b6b6b'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  const size = Math.max(13, Math.min(28, Math.min(w, h) * 0.12))
  context.font = `600 ${size}px system-ui, sans-serif`
  context.fillText(broken ? 'Failed' : `${index + 1}`, x + w / 2, y + h / 2 - (broken ? 0 : size * 0.6))
  if (!broken) {
    context.font = `400 ${Math.max(10, size * 0.55)}px system-ui, sans-serif`
    context.fillText('Empty', x + w / 2, y + h / 2 + size * 0.6)
  }
  context.restore()
}

function renderTemplatePicker() {
  elements.templatePicker.replaceChildren()
  const activeId = collage.templateId

  const chips = [...COLLAGE_TEMPLATES]
  if (activeId === 'custom') {
    chips.push({ ...uniformTemplate(collage.rows, collage.cols), id: 'custom', label: `Custom ${collage.cols}×${collage.rows}` })
  }

  for (const template of chips) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'template-chip'
    button.setAttribute('aria-pressed', String(template.id === activeId))
    if (template.id === activeId) button.classList.add('is-active')

    const mini = document.createElement('span')
    mini.className = 'template-mini'
    mini.setAttribute('aria-hidden', 'true')
    mini.style.gridTemplateRows = `repeat(${template.rows}, 1fr)`
    mini.style.gridTemplateColumns = `repeat(${template.cols}, 1fr)`
    const spans = template.spans ?? []
    if (template.spans) {
      for (const [row, col, rowSpan, colSpan] of spans) {
        const cell = document.createElement('i')
        cell.style.gridArea = `${row + 1} / ${col + 1} / span ${rowSpan} / span ${colSpan}`
        mini.append(cell)
      }
    } else {
      for (let index = 0; index < template.rows * template.cols; index += 1) mini.append(document.createElement('i'))
    }

    const label = document.createElement('span')
    label.className = 'template-label'
    label.textContent = template.label

    button.append(mini, label)
    button.addEventListener('click', () => {
      if (template.id === 'custom') return
      collage.templateId = template.id
      collage.rows = template.rows
      collage.cols = template.cols
      elements.gridRows.value = String(template.rows)
      elements.gridCols.value = String(template.cols)
      syncCollageSlots()
      refreshCollageUI()
    })
    elements.templatePicker.append(button)
  }
}

function renderCellList() {
  elements.cellList.replaceChildren()
  collage.slots.forEach((slot, index) => {
    const node = elements.cellTemplate.content.firstElementChild.cloneNode(true)
    node.dataset.index = String(index)
    node.classList.toggle('is-selected', index === collage.selected)
    node.classList.toggle('is-empty', !slot?.file)

    const thumb = node.querySelector('.cell-thumb')
    const image = node.querySelector('img')
    const badge = node.querySelector('.cell-index')
    const empty = node.querySelector('.cell-empty')
    badge.textContent = String(index + 1)
    if (slot?.file) {
      image.src = slot.url
      image.alt = slot.file.name
      empty.hidden = true
    } else {
      image.removeAttribute('src')
      image.alt = ''
      empty.hidden = false
    }

    thumb.addEventListener('click', () => selectCell(index))
    thumb.addEventListener('dblclick', () => replaceCell(index))
    node.querySelector('.cell-replace').addEventListener('click', () => replaceCell(index))
    node.querySelector('.cell-remove').addEventListener('click', () => clearCell(index))

    node.addEventListener('dragstart', (event) => {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(index))
    })
    node.addEventListener('dragover', (event) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      node.classList.add('is-drop')
    })
    node.addEventListener('dragleave', () => node.classList.remove('is-drop'))
    node.addEventListener('drop', (event) => {
      event.preventDefault()
      node.classList.remove('is-drop')
      const from = Number(event.dataTransfer.getData('text/plain'))
      if (Number.isInteger(from)) swapCells(from, index)
    })

    elements.cellList.append(node)
  })
}

function refreshCollageUI() {
  renderTemplatePicker()
  renderCellList()
  updateCollageChrome()
  requestCollagePreview()
}

function selectCell(index) {
  if (index < 0 || index >= collage.slots.length) return
  collage.selected = index
  renderCellList()
  updateCollageChrome()
  requestCollagePreview()
}

function swapCells(from, to) {
  if (from === to || from < 0 || to < 0 || from >= collage.slots.length || to >= collage.slots.length) return
  const key = collage.slots[from]?.key
  const moved = collage.slots[from]
  collage.slots[from] = collage.slots[to]
  collage.slots[to] = moved
  const selectedKey = selectedSlot()?.key ?? key
  collage.selected = Math.max(0, collage.slots.findIndex((slot) => slot?.key === selectedKey))
  if (collage.slots[collage.selected]?.key !== selectedKey) collage.selected = to
  refreshCollageUI()
}

function moveSelected(direction) {
  const target = collage.selected + direction
  if (target < 0 || target >= collage.slots.length) return
  swapCells(collage.selected, target)
  collage.selected = target
  refreshCollageUI()
}

function clearCell(index) {
  freeSlot(collage.slots[index])
  collage.slots[index] = null
  if (collage.selected === index) updateCollageChrome()
  renderCellList()
  updateCollageChrome()
  requestCollagePreview()
}

function replaceCell(index) {
  collage.replaceIndex = index
  elements.cellFile.click()
}

function addCollageFiles(fileList) {
  const files = Array.from(fileList).filter(isImageFile)
  if (files.length === 0) {
    setCollageStatus('No images in that drop — JPEG, PNG, WebP, AVIF work.')
    return
  }

  const filled = collage.slots.filter((slot) => slot?.file).length
  let expanded = false
  if (filled + files.length > collage.slots.length) {
    const fit = fitGridForCount(filled + files.length)
    if (fit.rows !== collage.rows || fit.cols !== collage.cols) {
      expanded = true
      const preset = COLLAGE_TEMPLATES.find((template) => !template.spans && template.rows === fit.rows && template.cols === fit.cols)
      collage.templateId = preset ? preset.id : 'custom'
      collage.rows = fit.rows
      collage.cols = fit.cols
      elements.gridRows.value = String(fit.rows)
      elements.gridCols.value = String(fit.cols)
      syncCollageSlots()
    }
  }

  let placed = 0
  for (const file of files) {
    const empty = collage.slots.findIndex((slot) => !slot?.file)
    if (empty === -1) break
    collage.slots[empty] = makeSlot(file)
    placed += 1
  }
  if (placed < files.length) {
    setCollageStatus(`${placed}/${files.length} placed — the grid holds ${collage.slots.length} (max 9).`)
  } else if (expanded) {
    setCollageStatus(`Grid expanded to ${collage.cols}×${collage.rows} to fit ${filled + files.length} photos.`)
  } else {
    setCollageStatus(`${placed} photo${placed === 1 ? '' : 's'} added.`)
  }
  collage.selected = Math.max(0, collage.slots.findIndex((slot) => slot?.file))
  refreshCollageUI()
}

function shuffleCollage() {
  const key = selectedSlot()?.key
  for (let index = collage.slots.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1))
    ;[collage.slots[index], collage.slots[other]] = [collage.slots[other], collage.slots[index]]
  }
  if (key) {
    const kept = collage.slots.findIndex((slot) => slot?.key === key)
    if (kept !== -1) collage.selected = kept
  }
  refreshCollageUI()
}

function clearCollage() {
  for (const slot of collage.slots) freeSlot(slot)
  collage.slots = collage.slots.map(() => null)
  collage.selected = 0
  setCollageStatus('Cleared. Add photos to start a new collage.')
  refreshCollageUI()
}

function selectedAdjust() {
  const slot = selectedSlot()
  if (!slot) return null
  return slot
}

function syncSelectedSliders() {
  updateCollageChrome()
}

async function saveCollage() {
  if (collage.saving) return
  const filled = collage.slots.filter((slot) => slot?.file)
  if (filled.length === 0) {
    setCollageStatus('Add at least one photo first.')
    return
  }
  collage.saving = true
  updateCollageChrome()
  setCollageStatus('Working…')
  try {
    const settings = readSettings()
    const template = resolveCollageTemplate()
    const response = await pool.run({
      kind: 'collage',
      files: collage.slots.map((slot) => slot?.file ?? null),
      cells: collage.slots.map((slot) => ({ zoom: slot?.zoom ?? 1, fx: slot?.fx ?? 0.5, fy: slot?.fy ?? 0.5 })),
      template: { rows: template.rows, cols: template.cols, spans: template.spans },
      ratio: collage.ratio,
      gapPercent: collage.gap,
      settings,
    })
    if (!response.ok) throw new Error(response.error)
    saveBlob(response.blob, `collage-${timestamp()}.${response.extension}`)
    setCollageStatus(`Saved ${response.width}×${response.height} · ${formatBytes(response.blob.size)} · ${response.count} photo${response.count === 1 ? '' : 's'}.`)
  } catch (error) {
    setCollageStatus(error?.message || String(error))
  } finally {
    collage.saving = false
    updateCollageChrome()
  }
}

function setMode(mode) {
  const single = mode !== 'collage'
  document.body.dataset.mode = single ? 'single' : 'collage'
  elements.tabSingle.classList.toggle('is-active', single)
  elements.tabCollage.classList.toggle('is-active', !single)
  elements.tabSingle.setAttribute('aria-selected', String(single))
  elements.tabCollage.setAttribute('aria-selected', String(!single))
  elements.singleView.hidden = !single
  elements.collageView.hidden = single
  if (single) {
    elements.summary.textContent = ''
    updateChrome()
  } else {
    elements.summary.textContent = 'Collage · one image for the feed'
    refreshCollageUI()
  }
}

function collagePoint(event) {
  const rect = elements.collageCanvas.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / rect.width) * elements.collageCanvas.width,
    y: ((event.clientY - rect.top) / rect.height) * elements.collageCanvas.height,
  }
}

function hitCell(point) {
  return collageHit.rects.findIndex(
    (rect) => point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h,
  )
}

let panDrag = null

function bindCollageEvents() {
  elements.tabSingle.addEventListener('click', () => setMode('single'))
  elements.tabCollage.addEventListener('click', () => setMode('collage'))

  elements.collageRatio.addEventListener('change', () => {
    collage.ratio = elements.collageRatio.value
    updateCollageMeta()
    requestCollagePreview()
  })
  elements.collageGap.addEventListener('input', () => {
    collage.gap = clampNumber(elements.collageGap.value, 0, 8, 2)
    elements.collageGapValue.textContent = `${collage.gap}%`
    requestCollagePreview()
  })

  const onGrid = () => {
    const rows = clampNumber(elements.gridRows.value, 1, 4, collage.rows)
    const cols = clampNumber(elements.gridCols.value, 1, 4, collage.cols)
    if (rows * cols > 9) {
      const fit = fitGridForCount(rows * cols)
      elements.gridRows.value = String(fit.rows)
      elements.gridCols.value = String(fit.cols)
      collage.rows = fit.rows
      collage.cols = fit.cols
      collage.templateId = 'custom'
      syncCollageSlots()
      setCollageStatus('Grids hold at most 9 photos — using 3×3.')
    } else {
      collage.rows = rows
      collage.cols = cols
      const preset = COLLAGE_TEMPLATES.find((template) => !template.spans && template.rows === rows && template.cols === cols)
      collage.templateId = preset ? preset.id : 'custom'
      syncCollageSlots()
    }
    refreshCollageUI()
  }
  elements.gridRows.addEventListener('change', onGrid)
  elements.gridCols.addEventListener('change', onGrid)

  elements.collageAdd.addEventListener('click', () => elements.collageFiles.click())
  elements.collageFiles.addEventListener('change', () => {
    addCollageFiles(elements.collageFiles.files)
    elements.collageFiles.value = ''
  })
  elements.cellFile.addEventListener('change', () => {
    const file = Array.from(elements.cellFile.files).find(isImageFile)
    elements.cellFile.value = ''
    if (!file || collage.replaceIndex < 0) return
    freeSlot(collage.slots[collage.replaceIndex])
    collage.slots[collage.replaceIndex] = makeSlot(file)
    collage.selected = collage.replaceIndex
    collage.replaceIndex = -1
    setCollageStatus('Photo replaced.')
    refreshCollageUI()
  })

  elements.collageShuffle.addEventListener('click', shuffleCollage)
  elements.collageClear.addEventListener('click', clearCollage)
  elements.collageSave.addEventListener('click', () => void saveCollage())

  elements.cellZoom.addEventListener('input', () => {
    const slot = selectedAdjust()
    if (!slot) return
    slot.zoom = clampNumber(elements.cellZoom.value, 100, 300, 100) / 100
    syncSelectedSliders()
    requestCollagePreview()
  })
  elements.cellFx.addEventListener('input', () => {
    const slot = selectedAdjust()
    if (!slot) return
    slot.fx = clampNumber(elements.cellFx.value, 0, 100, 50) / 100
    syncSelectedSliders()
    requestCollagePreview()
  })
  elements.cellFy.addEventListener('input', () => {
    const slot = selectedAdjust()
    if (!slot) return
    slot.fy = clampNumber(elements.cellFy.value, 0, 100, 50) / 100
    syncSelectedSliders()
    requestCollagePreview()
  })
  elements.cellReset.addEventListener('click', () => {
    const slot = selectedAdjust()
    if (!slot) return
    slot.zoom = 1
    slot.fx = 0.5
    slot.fy = 0.5
    refreshCollageUI()
  })
  elements.cellLeft.addEventListener('click', () => moveSelected(-1))
  elements.cellRight.addEventListener('click', () => moveSelected(1))

  elements.collageCanvas.addEventListener('pointerdown', (event) => {
    const point = collagePoint(event)
    const index = hitCell(point)
    if (index === -1) return
    selectCell(index)
    const slot = selectedSlot()
    if (!slot?.bitmap) return
    const rect = collageHit.rects[index]
    panDrag = { id: event.pointerId, startX: point.x, startY: point.y, fx: slot.fx, fy: slot.fy, rect }
    try {
      elements.collageCanvas.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic or already-released pointers cannot be captured; the
      // drag still tracks via pointermove on the canvas.
    }
    event.preventDefault()
  })
  elements.collageCanvas.addEventListener('pointermove', (event) => {
    if (!panDrag || event.pointerId !== panDrag.id) return
    const point = collagePoint(event)
    const slot = selectedSlot()
    if (!slot?.bitmap) return
    const next = panAdjust(
      slot.bitmap.width,
      slot.bitmap.height,
      panDrag.rect.w,
      panDrag.rect.h,
      { zoom: slot.zoom, fx: panDrag.fx, fy: panDrag.fy },
      point.x - panDrag.startX,
      point.y - panDrag.startY,
    )
    slot.fx = next.fx
    slot.fy = next.fy
    syncSelectedSliders()
    requestCollagePreview()
  })
  const endPan = (event) => {
    if (panDrag && event.pointerId === panDrag.id) panDrag = null
  }
  elements.collageCanvas.addEventListener('pointerup', endPan)
  elements.collageCanvas.addEventListener('pointercancel', endPan)
  elements.collageCanvas.addEventListener(
    'wheel',
    (event) => {
      const point = collagePoint(event)
      const index = hitCell(point)
      if (index === -1) return
      event.preventDefault()
      if (index !== collage.selected) selectCell(index)
      const slot = selectedSlot()
      if (!slot?.file) return
      slot.zoom = Math.min(3, Math.max(1, slot.zoom * Math.exp(-event.deltaY * 0.0015)))
      syncSelectedSliders()
      requestCollagePreview()
    },
    { passive: false },
  )
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
  updateCollageMeta()
  requestCollagePreview()
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
    if (document.body.dataset.mode === 'collage') return
    elements.drop.classList.add('is-over')
  })
}
document.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) elements.drop.classList.remove('is-over')
})
document.addEventListener('drop', (event) => {
  event.preventDefault()
  elements.drop.classList.remove('is-over')
  if (event.dataTransfer) {
    if (document.body.dataset.mode === 'collage') addCollageFiles(event.dataTransfer.files)
    else addFiles(event.dataTransfer.files)
  }
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

bindCollageEvents()
syncCollageSlots()
setCollageStatus('Add photos to start your collage.')
refreshCollageUI()
setMode('single')

syncReadouts()
updateChrome()
