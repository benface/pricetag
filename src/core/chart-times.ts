// Where a chart's two times go along its bottom edge, from how wide they really are. A time zone's name can be long, so no fixed width is safe.

const GAP = 12

export type PlacedTime = { x: number; row: number }

export function placeChartTimes(widths: number[], { start, end, width }: { start: number; end: number; width: number }): PlacedTime[] {
  const [first = 0, last] = widths
  if (last === undefined) return [{ x: Math.max(0, end - first), row: 0 }]
  // Under the line, each one reaching to its end of it.
  if (start + first + GAP <= end - last) return [{ x: start, row: 0 }, { x: end - last, row: 0 }]
  // Into the margins on either side, staying as close to their points as they can.
  const lastX = Math.max(0, Math.min(end, width - last))
  const firstX = Math.max(0, Math.min(start, lastX - GAP - first))
  if (firstX + first + GAP <= lastX) return [{ x: firstX, row: 0 }, { x: lastX, row: 0 }]
  // Together they're wider than the chart, and neither can lose the part that tells it from the other.
  return [{ x: Math.max(0, Math.min(start, width - first)), row: 0 }, { x: lastX, row: 1 }]
}
