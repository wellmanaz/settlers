// Resource icons as plain SVG paths (no emoji or symbol fonts, so they look the
// same on the Xbox browser and on every phone). Drawn in a 24x24 box centred on 0,0.
const PATHS = {
  ice: `<g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
      <path d="M0 -10V10M-8.7 -5L8.7 5M-8.7 5L8.7 -5"/>
      <path d="M-3 -8.5L0 -5.5L3 -8.5M-3 8.5L0 5.5L3 8.5M-8.8 -1.2L-5 -2.6L-5.8 -6.6M8.8 1.2L5 2.6L5.8 6.6M-8.8 1.2L-5 2.6L-5.8 6.6M8.8 -1.2L5 -2.6L5.8 -6.6"/></g>`,
  carbon: `<path d="M0 -10.5L8.5 0L0 10.5L-8.5 0Z" fill="currentColor"/>
      <path d="M-8.5 0H8.5M0 -10.5L-3.2 0L0 10.5L3.2 0Z" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1.2"/>`,
  metal: `<path d="M-10.5 6L-6.5 -3H6.5L10.5 6Z" fill="currentColor"/>
      <path d="M-6.5 -3L-4 -8H4L6.5 -3" fill="currentColor" opacity="0.7"/>
      <path d="M-8 3.5H8" stroke="#000" stroke-opacity="0.25" stroke-width="1.4"/>`,
  crystal: `<path d="M0 -11L4 -3L2.2 10H-2.2L-4 -3Z" fill="currentColor"/>
      <path d="M-5.5 -4L-9 3L-5.5 9.5L-3.5 1Z M5.5 -4L9 3L5.5 9.5L3.5 1Z" fill="currentColor" opacity="0.75"/>`,
  biomass: `<path d="M-9 9C-9.5 -3 -1 -10 9.5 -9.5C9.5 1 2.5 9.5 -9 9Z" fill="currentColor"/>
      <path d="M-9 9L4.5 -4.5" stroke="#ffffff" stroke-opacity="0.4" stroke-width="1.4" stroke-linecap="round"/>`,
};

// Inline <svg> for HTML (chips, buttons, legends). Colour comes from CSS `color`.
export function iconSvg(res, cls = 'ico') {
  return `<svg class="${cls}" viewBox="-12 -12 24 24" aria-hidden="true">${PATHS[res] || ''}</svg>`;
}

// A <g> for use inside the board SVG, centred at x,y and `size` board units wide.
export function iconGroup(res, x, y, size, color, opacity = 1) {
  if (!PATHS[res]) return '';
  const s = (size / 24).toFixed(4);
  return `<g transform="translate(${x} ${y}) scale(${s})" color="${color}" opacity="${opacity}">${PATHS[res]}</g>`;
}
