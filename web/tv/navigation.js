export function directionalTarget(rects, index, direction) {
  if (!rects.length) return -1;
  if (!rects[index]) return 0;
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  const center = rect => [rect.left + rect.width / 2, rect.top + rect.height / 2];
  const origin = center(rects[index]);
  let best = index;
  let score = Infinity;
  rects.forEach((rect, candidate) => {
    if (candidate === index) return;
    const point = center(rect);
    const forward = (point[horizontal ? 0 : 1] - origin[horizontal ? 0 : 1]) * sign;
    const sideways = Math.abs(point[horizontal ? 1 : 0] - origin[horizontal ? 1 : 0]);
    if (forward <= 1) return;
    const distance = forward + sideways * 3;
    if (distance < score) { score = distance; best = candidate; }
  });
  return best;
}
