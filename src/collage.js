/** Collage templates and cover-crop math. Pure functions shared by the live
 * preview (main thread) and the export job (worker). No DOM in here. */

export const COLLAGE_RATIOS = ['1:1', '4:5', '3:4', '2:3', '3:2', '16:9', '9:16']
export const COLLAGE_DEFAULT_RATIO = '1:1'
export const COLLAGE_MAX_CELLS = 9

/**
 * A template is a rows x cols unit grid plus one span per cell:
 * [row, col, rowSpan, colSpan]. `spans: null` means a uniform grid where
 * every cell is 1x1.
 */
export const COLLAGE_TEMPLATES = [
  { id: '2-side', label: '2 side', rows: 1, cols: 2, spans: null },
  { id: '2-stack', label: '2 stack', rows: 2, cols: 1, spans: null },
  { id: '3-row', label: '3 row', rows: 1, cols: 3, spans: null },
  { id: '3-col', label: '3 column', rows: 3, cols: 1, spans: null },
  {
    id: '3-left',
    label: '3 feature left',
    rows: 2,
    cols: 2,
    spans: [
      [0, 0, 2, 1],
      [0, 1, 1, 1],
      [1, 1, 1, 1],
    ],
  },
  {
    id: '3-top',
    label: '3 feature top',
    rows: 2,
    cols: 2,
    spans: [
      [0, 0, 1, 2],
      [1, 0, 1, 1],
      [1, 1, 1, 1],
    ],
  },
  { id: '4-grid', label: '4 grid', rows: 2, cols: 2, spans: null },
  { id: '4-row', label: '4 row', rows: 1, cols: 4, spans: null },
  { id: '4-col', label: '4 column', rows: 4, cols: 1, spans: null },
  { id: '6-grid', label: '6 grid', rows: 2, cols: 3, spans: null },
  { id: '6-tall', label: '6 tall', rows: 3, cols: 2, spans: null },
  { id: '9-grid', label: '9 grid', rows: 3, cols: 3, spans: null },
]

export function getTemplate(id) {
  return COLLAGE_TEMPLATES.find((template) => template.id === id) ?? null
}

export function uniformTemplate(rows, cols) {
  const safeRows = Math.min(4, Math.max(1, Math.round(rows) || 1))
  const safeCols = Math.min(4, Math.max(1, Math.round(cols) || 1))
  return {
    id: 'custom',
    label: `${safeCols}×${safeRows}`,
    rows: safeRows,
    cols: safeCols,
    spans: null,
  }
}

export function cellCount(template) {
  if (template.spans) return template.spans.length
  return template.rows * template.cols
}

/**
 * Pick a near-square uniform grid that fits `count` photos, capped at
 * COLLAGE_MAX_CELLS so a single export job stays within memory budget.
 */
export function fitGridForCount(count) {
  const target = Math.min(Math.max(1, count), COLLAGE_MAX_CELLS)
  let best = null
  for (let rows = 1; rows <= 4; rows += 1) {
    for (let cols = 1; cols <= 4; cols += 1) {
      const cells = rows * cols
      if (cells < target || cells > COLLAGE_MAX_CELLS) continue
      const score = (cells - target) * 10 + Math.abs(rows - cols)
      if (!best || score < best.score) best = { rows, cols, score }
    }
  }
  return uniformTemplate(best.rows, best.cols)
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

/**
 * Pixel rects for every cell of a template on a W x H canvas with a `gap`
 * band between cells. Rects are floats; callers round when stroking text.
 */
export function layoutCells(template, width, height, gap) {
  const { rows, cols } = template
  const unitWidth = (width - gap * (cols - 1)) / cols
  const unitHeight = (height - gap * (rows - 1)) / rows
  const toRect = ([row, col, rowSpan, colSpan]) => ({
    x: col * (unitWidth + gap),
    y: row * (unitHeight + gap),
    w: colSpan * unitWidth + (colSpan - 1) * gap,
    h: rowSpan * unitHeight + (rowSpan - 1) * gap,
  })

  if (template.spans) return template.spans.map(toRect)

  const rects = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      rects.push(toRect([row, col, 1, 1]))
    }
  }
  return rects
}

/**
 * Source rect that makes a photo cover a cell (no letterboxing), then zooms
 * around a focal point. fx/fy are 0..1 (0 = left/top, 1 = right/bottom).
 */
export function coverSourceRect(sourceWidth, sourceHeight, destWidth, destHeight, zoom = 1, fx = 0.5, fy = 0.5) {
  const scale = Math.max(destWidth / sourceWidth, destHeight / sourceHeight) * Math.max(1, zoom || 1)
  const sw = Math.min(sourceWidth, destWidth / scale)
  const sh = Math.min(sourceHeight, destHeight / scale)
  return {
    sx: (sourceWidth - sw) * clamp01(fx),
    sy: (sourceHeight - sh) * clamp01(fy),
    sw,
    sh,
  }
}

/**
 * New focal point after dragging a photo by (dx, dy) canvas pixels inside
 * its cell. Dragging right reveals the left side of the photo, so fx falls.
 * Measured from the drag start so repeated moves never accumulate error.
 */
export function panAdjust(sourceWidth, sourceHeight, destWidth, destHeight, adjust, dx, dy) {
  const { zoom = 1, fx = 0.5, fy = 0.5 } = adjust
  const src = coverSourceRect(sourceWidth, sourceHeight, destWidth, destHeight, zoom, fx, fy)
  const scale = destWidth / src.sw
  const spanX = sourceWidth - src.sw
  const spanY = sourceHeight - src.sh
  return {
    fx: spanX > 0 ? clamp01(fx - dx / scale / spanX) : fx,
    fy: spanY > 0 ? clamp01(fy - dy / scale / spanY) : fy,
  }
}

/**
 * Shrink a gap measured in pixels until every cell keeps at least `minCell`
 * pixels on each side. Keeps extreme gap sliders from collapsing the grid.
 */
export function clampGap(template, width, height, gap, minCell = 8) {
  let safe = Math.max(0, gap)
  for (;;) {
    const rects = layoutCells(template, width, height, safe)
    const smallest = Math.min(...rects.map((rect) => Math.min(rect.w, rect.h)))
    if (smallest >= minCell || safe <= 0) return safe
    safe -= 1
  }
}
