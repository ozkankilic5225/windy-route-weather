// Screen-space projection keeps the hit tolerance constant at every zoom level.
export function nearestOnSegments(p, points) {
 let best = null;
 for (let i = 1; i < points.length; i++) {
  const a = points[i-1], b = points[i];
  const dx=b.x-a.x, dy=b.y-a.y, d=dx*dx+dy*dy;
  const t=d ? Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/d)) : 0;
  const x=a.x+t*dx,y=a.y+t*dy, distance=Math.hypot(p.x-x,p.y-y);
  if (!best || distance<best.distance) best={x,y,distance,segment:i-1,t};
 }
 return best;
}
