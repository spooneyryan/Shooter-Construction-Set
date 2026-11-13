// Headless tile painting: the operations a grid editor is made of.
//
// The third construction set in this repository, and the first whose canvas
// is a grid — so the paint, line, rectangle, flood and stamp live here, in
// `editor`, beside the selection and command plumbing the other two already
// share. Nothing here touches the DOM, and every operation is copy-on-write:
// it returns a new cell array when something changed and THE SAME array when
// nothing did, which is exactly what an undo stack wants to know.
//
// Coordinates are cells, not pixels. Out-of-range coordinates clip rather
// than throw: dragging a rectangle past the edge of the map is something an
// author does every few seconds, not an error.

/**
 * @param {number[]} cells Row-major grid.
 * @param {number} cols
 * @param {number} rows
 * @param {number} x
 * @param {number} y
 * @returns {number} The value at (x, y); 0 outside the grid.
 */
export function readCell(cells, cols, rows, x, y) {
  if (x < 0 || x >= cols || y < 0 || y >= rows) return 0;
  return cells[y * cols + x] ?? 0;
}

/** @returns {number[]} A new array with the cell set; the same one if unchanged. */
export function paintCell(cells, cols, rows, x, y, value) {
  if (x < 0 || x >= cols || y < 0 || y >= rows) return cells;
  const index = y * cols + x;
  if (cells[index] === value) return cells;
  const next = cells.slice();
  next[index] = value;
  return next;
}

/**
 * Bresenham between two cells, endpoints included — the drag-paint stroke.
 *
 * @returns {number[]}
 */
export function paintLine(cells, cols, rows, x0, y0, x1, y1, value) {
  let next = cells;
  let changed = false;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    if (x >= 0 && x < cols && y >= 0 && y < rows) {
      const index = y * cols + x;
      if (next[index] !== value) {
        if (!changed) { next = next.slice(); changed = true; }
        next[index] = value;
      }
    }
    if (x === x1 && y === y1) break;
    const doubled = 2 * error;
    if (doubled >= dy) { error += dy; x += sx; }
    if (doubled <= dx) { error += dx; y += sy; }
  }
  return next;
}

/** A filled rectangle between two corners, either order, clipped. */
export function paintRect(cells, cols, rows, x0, y0, x1, y1, value) {
  const left = Math.max(0, Math.min(x0, x1));
  const right = Math.min(cols - 1, Math.max(x0, x1));
  const top = Math.max(0, Math.min(y0, y1));
  const bottom = Math.min(rows - 1, Math.max(y0, y1));
  let next = cells;
  let changed = false;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const index = y * cols + x;
      if (next[index] !== value) {
        if (!changed) { next = next.slice(); changed = true; }
        next[index] = value;
      }
    }
  }
  return next;
}

/**
 * Flood fill from a cell, 4-connected, bounded by the grid. A fill on a
 * cell that already holds the value is a no-op, not an infinite loop.
 */
export function fillRegion(cells, cols, rows, x, y, value) {
  const from = readCell(cells, cols, rows, x, y);
  if (x < 0 || x >= cols || y < 0 || y >= rows || from === value) return cells;
  const next = cells.slice();
  const queue = [[x, y]];
  while (queue.length > 0) {
    const [cx, cy] = queue.pop();
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
    const index = cy * cols + cx;
    if (next[index] !== from) continue;
    next[index] = value;
    queue.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  return next;
}

/**
 * Paste a block of cells with its top-left at (x, y), clipped at the edges.
 * A negative value in the stamp is transparent — it leaves the target cell —
 * so a copied selection can be non-rectangular.
 *
 * @param {{cols: number, rows: number, cells: number[]}} stamp
 */
export function stampCells(cells, cols, rows, x, y, stamp) {
  let next = cells;
  let changed = false;
  for (let sy = 0; sy < stamp.rows; sy += 1) {
    for (let sx = 0; sx < stamp.cols; sx += 1) {
      const value = stamp.cells[sy * stamp.cols + sx];
      if (value < 0) continue;
      const tx = x + sx;
      const ty = y + sy;
      if (tx < 0 || tx >= cols || ty < 0 || ty >= rows) continue;
      const index = ty * cols + tx;
      if (next[index] !== value) {
        if (!changed) { next = next.slice(); changed = true; }
        next[index] = value;
      }
    }
  }
  return next;
}

/** Cut a rectangle out as a stamp, for copy and for pattern brushes. */
export function liftCells(cells, cols, rows, x0, y0, x1, y1) {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.abs(x1 - x0) + 1;
  const height = Math.abs(y1 - y0) + 1;
  const lifted = new Array(width * height).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      lifted[y * width + x] = readCell(cells, cols, rows, left + x, top + y);
    }
  }
  return { cols: width, rows: height, cells: lifted };
}
