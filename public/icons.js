// Custom line-art icon set — replaces emoji everywhere in the UI so every
// glyph shares one consistent visual language (1.6px stroke, rounded caps,
// currentColor) instead of relying on the OS's own emoji font.
// Pure presentation: returns markup strings only, no game logic.
(function(){
'use strict';

const PATHS = {
  flag: '<path d="M6 3v18M6 4h11l-3 4 3 4H6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>',
  crypt: '<path d="M6 21V11a6 6 0 0112 0v10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12 6.2V2.2M10 4.2h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4.5 21h15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  warning: '<circle cx="8" cy="9" r="3.3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="16" cy="15" r="3.3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.3 11.3l3.4 3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  shore: '<circle cx="12" cy="8" r="3.1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 14.5q2.5-2.2 5-0t5 0 5 0 3.5-0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2.5 18.8q2.5-2.2 5-0t5 0 5 0 3.5-0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  coin: '<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7.3v9.4M9.2 9.3c0-1.2 1.25-1.9 2.8-1.9s2.8.75 2.8 2c0 2.7-5.6 1-5.6 3.7 0 1.25 1.25 2 2.8 2s2.8-.65 2.8-1.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  crystalball: '<circle cx="12" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.7 19h10.6M8.7 19c0-1.15 1.2-2.2 3.3-2.2s3.3 1.05 3.3 2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M9.3 8.3l1.1-1.1M15 7.8l-1.1 1.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  moon: '<path d="M15.6 4.3a8 8 0 100 15.4 6.6 6.6 0 010-15.4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M18.3 14.6l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" fill="currentColor"/>',
  plane: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>',
  bolt: '<path d="M13 2L4 14h6l-1 8 9-13h-6l1-7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>',
  crown: '<path d="M4 18.5h16l-1.4-8-4 3.1L12 7l-2.6 6.6-4-3.1L4 18.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>',
  ghost: '<path d="M6 20.3V11a6 6 0 0112 0v9.3l-1.8-1.8-1.7 1.8-1.7-1.8-1.7 1.8-1.7-1.8-1.7 1.8-1.7-1.8z" fill="currentColor"/><circle cx="9.6" cy="10.6" r="0.95" fill="var(--panel)"/><circle cx="14.4" cy="10.6" r="0.95" fill="var(--panel)"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 11V8a4 4 0 018 0v3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  house: '<path d="M4 11.2L12 4l8 7.2V20H4z" fill="currentColor"/>',
  hotel: '<path d="M3 11.2L12 4l9 7.2V20H3z" fill="currentColor"/><rect x="10.3" y="1" width="1.4" height="4.2" fill="currentColor"/><path d="M11.7 1h2.6l-2.6 1.7z" fill="currentColor"/>',
  handshake: '<circle cx="9" cy="12" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="15" cy="12" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  whiteflag: '<path d="M6 21V3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M6 4.3c3-1.6 5 1.6 8 0 1-.5 2-.3 2 .5v6c0 .8-1 1-2 .5-3-1.6-5 1.6-8 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>',
  scroll: '<path d="M6.2 4h11a2 2 0 012 2v1a2 2 0 01-2 2H8.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/><path d="M6.2 4a2 2 0 00-2 2v12a2 2 0 002 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M6.2 4a2 2 0 012 2v12a2 2 0 01-2 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M6.2 20h11a2 2 0 002-2v-1a2 2 0 00-2-2H8.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>',
  dice: '<rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8.2" cy="8.2" r="1.35" fill="currentColor"/><circle cx="15.8" cy="8.2" r="1.35" fill="currentColor"/><circle cx="12" cy="12" r="1.35" fill="currentColor"/><circle cx="8.2" cy="15.8" r="1.35" fill="currentColor"/><circle cx="15.8" cy="15.8" r="1.35" fill="currentColor"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  check: '<path d="M4 12.5l5 5L20 6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
  cross: '<path d="M5.5 5.5l13 13M18.5 5.5l-13 13" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>',
  robot: '<rect x="4" y="8.4" width="16" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 8.4V4.2M9 4.2h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="9" cy="13.7" r="1.3" fill="currentColor"/><circle cx="15" cy="13.7" r="1.3" fill="currentColor"/><path d="M9 17h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  estate: '<path d="M4 21V10L12 4l8 6v11H4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 21v-6h6v6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><rect x="10.3" y="0.6" width="1.4" height="4.2" fill="currentColor"/>',
  skull: '<circle cx="12" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10" r="1.3" fill="currentColor"/><circle cx="15" cy="10" r="1.3" fill="currentColor"/><path d="M9.3 14.6h5.4M9.3 17l1 2M14.7 17l-1 2M12 14.6v3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  sparkle: '<path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" fill="currentColor"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 01-10 0V4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 5H4a3 3 0 003 5M17 5h3a3 3 0 01-3 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12 14v3M9 20h6M9.5 17h5l.5 3h-6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>',
};

function Icon(name, cls){
  const p = PATHS[name];
  if (!p) return '';
  return `<svg class="icon icon-${name}${cls?' '+cls:''}" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}

function houseBadge(count){
  if (!count) return '';
  if (count>=5) return `<span class="house-badge hotel">${Icon('hotel')}</span>`;
  let out='';
  for (let i=0;i<count;i++) out += `<span class="house-badge">${Icon('house')}</span>`;
  return out;
}

window.Icon = Icon;
window.houseBadge = houseBadge;
})();
