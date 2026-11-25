// SVG board renderer shared by the TV and the phones.
import { RESOURCE_INFO } from './engine.js';
import { iconGroup } from './icons.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hexPoints(h, scale = 0.97) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push(`${(h.x + scale * Math.cos(a)).toFixed(3)},${(h.y + scale * Math.sin(a)).toFixed(3)}`);
  }
  return pts.join(' ');
}

export function boardBounds(board, pad = 0.9) {
  const xs = board.vertices.map((v) => v.x);
  const ys = board.vertices.map((v) => v.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  return { minX, minY, w: Math.max(...xs) + pad - minX, h: Math.max(...ys) + pad - minY };
}

function outpostShape(x, y, color, extra = '') {
  return `<g ${extra}><circle cx="${x}" cy="${y}" r="0.2" fill="${color}" stroke="#0b0b14" stroke-width="0.06"/>
    <circle cx="${x}" cy="${y}" r="0.07" fill="#0b0b14" opacity="0.55"/></g>`;
}

function colonyShape(x, y, color, extra = '') {
  const r = 0.3;
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i + Math.PI / 8;
    pts.push(`${(x + r * Math.cos(a)).toFixed(3)},${(y + r * Math.sin(a)).toFixed(3)}`);
  }
  return `<g ${extra}><polygon points="${pts.join(' ')}" fill="${color}" stroke="#0b0b14" stroke-width="0.06"/>
    <circle cx="${x}" cy="${y}" r="0.12" fill="none" stroke="#0b0b14" stroke-width="0.05"/></g>`;
}

// opts:
//   highlight: { kind: 'vertex'|'edge'|'hex', ids: number[] }
//   selected:  { kind, id }
//   previews:  [{ kind, id, item, color }]
//   flashRoll: number (tiles with this number glow)
//   compact:   boolean (phone: bigger hit targets, no beacon text)
export function renderBoard(state, opts = {}) {
  const { board } = state;
  const { highlight, selected, previews = [], flashRoll, compact } = opts;
  const b = boardBounds(board);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.minX} ${b.minY} ${b.w} ${b.h}" class="board-svg" preserveAspectRatio="xMidYMid meet">`);
  out.push(`<defs>
    <radialGradient id="tileShade" cx="50%" cy="40%" r="65%">
      <stop offset="0%" stop-color="#fff" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.25"/>
    </radialGradient>
  </defs>`);

  // Beacons (behind tiles so the lines tuck under).
  const cx = board.hexes.reduce((s, h) => s + h.x, 0) / board.hexes.length;
  const cy = board.hexes.reduce((s, h) => s + h.y, 0) / board.hexes.length;
  for (const beacon of board.beacons) {
    const [a, c] = board.edges[beacon.edge].v.map((id) => board.vertices[id]);
    const mx = (a.x + c.x) / 2;
    const my = (a.y + c.y) / 2;
    const dx = mx - cx;
    const dy = my - cy;
    const len = Math.hypot(dx, dy) || 1;
    const bx = mx + (dx / len) * 0.55;
    const by = my + (dy / len) * 0.55;
    const info = beacon.res ? RESOURCE_INFO[beacon.res] : null;
    const fill = info ? info.light || info.color : '#e5e7eb';
    out.push(`<g class="beacon">
      <line x1="${a.x}" y1="${a.y}" x2="${bx}" y2="${by}" stroke="${fill}" stroke-width="0.05" stroke-dasharray="0.08 0.06"/>
      <line x1="${c.x}" y1="${c.y}" x2="${bx}" y2="${by}" stroke="${fill}" stroke-width="0.05" stroke-dasharray="0.08 0.06"/>
      <circle cx="${bx}" cy="${by}" r="0.3" fill="#11121f" stroke="${fill}" stroke-width="0.06"/>
      <text x="${bx}" y="${by + (info ? -0.04 : 0.07)}" text-anchor="middle" font-size="${info ? 0.16 : 0.2}" font-weight="700" fill="${fill}">${beacon.rate}:1</text>
      ${info ? iconGroup(beacon.res, bx, by + 0.13, 0.2, fill) : ''}
    </g>`);
  }

  // Tiles.
  const hexPick = highlight?.kind === 'hex' ? new Set(highlight.ids) : null;
  for (const h of board.hexes) {
    const info = RESOURCE_INFO[h.res];
    const glow = flashRoll && h.num === flashRoll && h.id !== state.raider;
    const pickable = hexPick?.has(h.id);
    const isSel = selected?.kind === 'hex' && selected.id === h.id;
    out.push(`<g class="tile${glow ? ' tile-glow' : ''}${pickable ? ' pickable' : ''}" ${pickable ? `data-pick="hex" data-id="${h.id}"` : ''}>
      <polygon points="${hexPoints(h)}" fill="${info.color}" stroke="#0b0b14" stroke-width="0.05"/>
      <polygon points="${hexPoints(h)}" fill="url(#tileShade)"/>
      ${h.res !== 'void' ? iconGroup(h.res, h.x, h.y - 0.5, 0.36, info.ink, 0.8) : `<text x="${h.x}" y="${h.y - 0.1}" text-anchor="middle" font-size="0.2" fill="${info.ink}" opacity="0.7">dust cloud</text>`}
      ${h.num ? `<circle cx="${h.x}" cy="${h.y + 0.12}" r="0.3" fill="#f8f5ea" stroke="#0b0b14" stroke-width="0.03"/>
        <text x="${h.x}" y="${h.y + 0.24}" text-anchor="middle" font-size="${h.num === 6 || h.num === 8 ? 0.36 : 0.3}" font-weight="800" fill="${h.num === 6 || h.num === 8 ? '#d62839' : '#1b1b2b'}">${h.num}</text>` : ''}
      ${pickable ? `<polygon points="${hexPoints(h, 0.9)}" fill="#ffffff" fill-opacity="0.12" stroke="#ffffff" stroke-width="0.08" class="pulse"/>` : ''}
      ${isSel ? `<polygon points="${hexPoints(h, 0.9)}" fill="none" stroke="#ffe066" stroke-width="0.14"/>` : ''}
    </g>`);
  }

  // Raiders.
  const rh = board.hexes[state.raider];
  if (rh) {
    out.push(`<g class="raider">
      <ellipse cx="${rh.x + 0.42}" cy="${rh.y + 0.42}" rx="0.27" ry="0.17" fill="#14101f" stroke="#ff4d6d" stroke-width="0.05"/>
      <polygon points="${rh.x + 0.2},${rh.y + 0.42} ${rh.x + 0.42},${rh.y + 0.18} ${rh.x + 0.64},${rh.y + 0.42}" fill="#ff4d6d"/>
      <text x="${rh.x + 0.42}" y="${rh.y + 0.47}" text-anchor="middle" font-size="0.12" font-weight="800" fill="#ffd6de">RAID</text>
    </g>`);
  }

  // Conduits.
  const color = (pid) => state.players[pid]?.color || '#fff';
  for (const [e, owner] of Object.entries(state.conduits)) {
    const [a, c] = board.edges[e].v.map((id) => board.vertices[id]);
    out.push(`<line x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" stroke="#0b0b14" stroke-width="0.2" stroke-linecap="round"/>`);
    out.push(`<line x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" stroke="${color(owner)}" stroke-width="0.12" stroke-linecap="round"/>`);
  }

  // Legal edges.
  if (highlight?.kind === 'edge') {
    for (const id of highlight.ids) {
      const [a, c] = board.edges[id].v.map((v) => board.vertices[v]);
      out.push(`<g data-pick="edge" data-id="${id}" class="pickable">
        <line x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" stroke="#ffffff" stroke-opacity="0.55" stroke-width="0.12" stroke-linecap="round" class="pulse"/>
        <line x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" stroke="transparent" stroke-width="${compact ? 0.45 : 0.3}"/>
      </g>`);
    }
  }

  // Buildings.
  for (const [v, bld] of Object.entries(state.buildings)) {
    const vert = board.vertices[v];
    out.push(bld.kind === 'colony' ? colonyShape(vert.x, vert.y, color(bld.owner)) : outpostShape(vert.x, vert.y, color(bld.owner)));
  }

  // Legal vertices.
  if (highlight?.kind === 'vertex') {
    for (const id of highlight.ids) {
      const vert = board.vertices[id];
      out.push(`<g data-pick="vertex" data-id="${id}" class="pickable">
        <circle cx="${vert.x}" cy="${vert.y}" r="0.16" fill="#ffffff" fill-opacity="0.35" stroke="#ffffff" stroke-width="0.05" class="pulse"/>
        <circle cx="${vert.x}" cy="${vert.y}" r="${compact ? 0.42 : 0.3}" fill="transparent"/>
      </g>`);
    }
  }

  // Selection and previews (ghost pieces).
  const ghosts = [...previews];
  if (selected && selected.kind !== 'hex' && selected.item) ghosts.push({ ...selected, color: selected.color || '#ffe066' });
  for (const g of ghosts) {
    if (g.kind === 'vertex' && board.vertices[g.id]) {
      const vert = board.vertices[g.id];
      out.push(`<circle cx="${vert.x}" cy="${vert.y}" r="0.42" fill="none" stroke="#ffe066" stroke-width="0.06" class="pulse"/>`);
      out.push((g.item === 'colony' ? colonyShape : outpostShape)(vert.x, vert.y, g.color, 'opacity="0.8"'));
    } else if (g.kind === 'edge' && board.edges[g.id]) {
      const [a, c] = board.edges[g.id].v.map((v) => board.vertices[v]);
      out.push(`<line x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" stroke="#ffe066" stroke-width="0.26" stroke-linecap="round" stroke-opacity="0.7" class="pulse"/>`);
      out.push(`<line x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" stroke="${g.color}" stroke-width="0.12" stroke-linecap="round"/>`);
    } else if (g.kind === 'hex' && board.hexes[g.id]) {
      out.push(`<polygon points="${hexPoints(board.hexes[g.id], 0.9)}" fill="none" stroke="#ffe066" stroke-width="0.14" class="pulse"/>`);
    }
  }

  out.push('</svg>');
  return out.join('');
}

// Wire tap/click handling on a container that holds a rendered board.
export function onBoardPick(container, handler) {
  container.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-pick]');
    if (!el || !container.contains(el)) return;
    handler(el.dataset.pick, Number(el.dataset.id));
  });
}

export { esc };
