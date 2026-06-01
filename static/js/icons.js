// Inline SVG icons for items and chrome.
//
// Returns an SVG string; embed via element.innerHTML = icon("hint").
// Stroke uses currentColor so callers can theme via CSS color property.
//
// All icons share a 24×24 viewBox and a consistent 1.75px stroke so they
// align across slot, toast, tooltip, and help-screen contexts.

const ICONS = {
  hint: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <circle cx="10.5" cy="10.5" r="5.75"/>
      <path d="M14.6 14.6l4.6 4.6"/>
      <circle cx="10.5" cy="10.5" r="1.6" fill="currentColor" stroke="none"/>
    </svg>`,

  blind: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M3 12.5c2.6-4.5 6-6.5 9-6.5s6.4 2 9 6.5"/>
      <path d="M3 12.5c2.6 4 6 5.7 9 5.7s6.4-1.7 9-5.7"/>
      <line x1="5" y1="5" x2="19" y2="19"/>
    </svg>`,

  shuffle: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M3 7h3.5l4 5"/>
      <path d="M3 17h3.5l10.5-10"/>
      <path d="M17 7h4v4"/>
      <path d="M13.5 12l3.5 5h4"/>
      <path d="M17 13v4h4"/>
    </svg>`,

  shield: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M12 3l-7.5 2.5v6.2c0 4.3 3 8.1 7.5 9.8 4.5-1.7 7.5-5.5 7.5-9.8V5.5z"/>
      <path d="M9 12.2l2.3 2.3 4.2-4.5"/>
    </svg>`,

  overload: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M4 17a8 8 0 0 1 16 0"/>
      <line x1="12" y1="17" x2="16.5" y2="10.5"/>
      <circle cx="12" cy="17" r="1.4" fill="currentColor" stroke="none"/>
      <path d="M19.4 13.2l1.5-.5M17.7 9.9l1.2-1M4.6 13.2l-1.5-.5M6.3 9.9l-1.2-1"/>
    </svg>`,

  freeze: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <line x1="12" y1="2.5" x2="12" y2="21.5"/>
      <line x1="3.8" y1="7.25" x2="20.2" y2="16.75"/>
      <line x1="20.2" y1="7.25" x2="3.8" y2="16.75"/>
      <path d="M12 5.6l-2.1-1.5M12 5.6l2.1-1.5M12 18.4l-2.1 1.5M12 18.4l2.1 1.5"/>
      <path d="M5.9 9.1l-2.6.2M5.9 9.1l.2 2.6M18.1 14.9l2.6-.2M18.1 14.9l-.2-2.6"/>
      <path d="M18.1 9.1l2.6.2M18.1 9.1l-.2 2.6M5.9 14.9l-2.6-.2M5.9 14.9l.2 2.6"/>
    </svg>`,

  // UI chrome
  home: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M4 10.5L12 4l8 6.5"/>
      <path d="M6 9.5V20h12V9.5"/>
      <path d="M10 20v-5h4v5"/>
    </svg>`,

  menu: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <line x1="4" y1="7" x2="20" y2="7"/>
      <line x1="4" y1="12" x2="20" y2="12"/>
      <line x1="4" y1="17" x2="20" y2="17"/>
    </svg>`,

  close: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <line x1="6" y1="6" x2="18" y2="18"/>
      <line x1="18" y1="6" x2="6" y2="18"/>
    </svg>`,

  // Mode glyphs (home screen)
  solo: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <circle cx="12" cy="8" r="3.5"/>
      <path d="M5 20c1-3.5 4-5.5 7-5.5s6 2 7 5.5"/>
    </svg>`,

  match: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <circle cx="8" cy="9" r="3"/>
      <circle cx="16" cy="9" r="3"/>
      <path d="M3 19c1-2.5 3-4 5-4s4 1.5 5 4"/>
      <path d="M11 19c1-2.5 3-4 5-4s4 1.5 5 4"/>
    </svg>`,

  create: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="16" height="16" rx="3"/>
      <line x1="12" y1="9" x2="12" y2="15"/>
      <line x1="9" y1="12" x2="15" y2="12"/>
    </svg>`,

  join: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M14 4h5v16h-5"/>
      <path d="M3 12h12"/>
      <polyline points="11,8 15,12 11,16"/>
    </svg>`,

  audioOn: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M4 9v6h4l5 4V5L8 9H4z"/>
      <path d="M16 8c1.5 1 2.5 2.5 2.5 4s-1 3-2.5 4"/>
    </svg>`,

  audioOff: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M4 9v6h4l5 4V5L8 9H4z"/>
      <line x1="16" y1="9" x2="21" y2="14"/>
      <line x1="21" y1="9" x2="16" y2="14"/>
    </svg>`,

  discard: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <line x1="7" y1="7" x2="17" y2="17"/>
      <line x1="17" y1="7" x2="7" y2="17"/>
    </svg>`,

  flame: `
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"
         aria-hidden="true" focusable="false">
      <path d="M12 2c2 4 5 6 5 11a5 5 0 1 1-10 0c0-3 1-4 3-7-1 4 1 5 2 5 0-3 0-5 0-9z"/>
    </svg>`,

  trophy: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M7 4h10v3c0 3.5-2.2 6-5 6s-5-2.5-5-6V4z"/>
      <path d="M7 6H4c0 2.5 1.5 4 3 4"/>
      <path d="M17 6h3c0 2.5-1.5 4-3 4"/>
      <line x1="10" y1="17" x2="14" y2="17"/>
      <line x1="12" y1="13" x2="12" y2="17"/>
      <rect x="8" y="19" width="8" height="1.5"/>
    </svg>`,

  replay: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M4 12a8 8 0 1 0 2.5-5.8"/>
      <polyline points="4,3 4,7 8,7"/>
    </svg>`,

  apple: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M12 6.2c-1.6-1.3-3.6-1.5-5.2-.6C4.6 6.8 3.7 9.4 4.3 12c.6 2.7 2.3 6.5 4.5 7.5 1.1.5 2.1.1 3.2-.3 1.1.4 2.1.8 3.2.3 2.2-1 3.9-4.8 4.5-7.5.6-2.6-.3-5.2-2.5-6.4-1.6-.9-3.6-.7-5.2.6z"
            fill="#C44536"/>
      <path d="M12 6.2V4.4c0-1 .7-1.9 1.8-2.2" stroke="#5A3E2B" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M12.6 5c.6-1.6 2.2-2.6 3.8-2.4.2 1.7-.9 3.3-2.6 3.6-.5.1-.9 0-1.2-.2z"
            fill="#5B7553"/>
      <ellipse cx="9" cy="10" rx="1.5" ry="2.1" fill="rgba(255,255,255,0.4)" transform="rotate(-20 9 10)"/>
    </svg>`,

  golden: `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M12 6.2c-1.6-1.3-3.6-1.5-5.2-.6C4.6 6.8 3.7 9.4 4.3 12c.6 2.7 2.3 6.5 4.5 7.5 1.1.5 2.1.1 3.2-.3 1.1.4 2.1.8 3.2.3 2.2-1 3.9-4.8 4.5-7.5.6-2.6-.3-5.2-2.5-6.4-1.6-.9-3.6-.7-5.2.6z"
            fill="#E5A21F"/>
      <path d="M12 6.2V4.4c0-1 .7-1.9 1.8-2.2" stroke="#7A5A20" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M12.6 5c.6-1.6 2.2-2.6 3.8-2.4.2 1.7-.9 3.3-2.6 3.6-.5.1-.9 0-1.2-.2z"
            fill="#5B7553"/>
      <ellipse cx="9" cy="10" rx="1.5" ry="2.1" fill="rgba(255,255,255,0.5)" transform="rotate(-20 9 10)"/>
    </svg>`,

  burst: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>`,

  play: `
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"
         aria-hidden="true" focusable="false">
      <path d="M7 4.5v15l13-7.5z"/>
    </svg>`,

  mail: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <rect x="3" y="5" width="18" height="14" rx="2.5"/>
      <path d="M4 7l8 6 8-6"/>
    </svg>`,

  help: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5"/>
      <path d="M9.6 9.4a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .8-1 1.5v.4"/>
      <circle cx="11.9" cy="16.4" r="0.6" fill="currentColor" stroke="none"/>
    </svg>`,

  ban: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`,

  pause: `
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"
         aria-hidden="true" focusable="false">
      <rect x="6" y="4.5" width="4" height="15" rx="0.8"/>
      <rect x="14" y="4.5" width="4" height="15" rx="0.8"/>
    </svg>`,
};

/** Return inline SVG markup for `name`, or empty string when unknown. */
export function icon(name) {
  return ICONS[name] || "";
}

/** Set the innerHTML of `el` to the SVG markup for `name`. */
export function setIcon(el, name) {
  if (el) el.innerHTML = ICONS[name] || "";
}
