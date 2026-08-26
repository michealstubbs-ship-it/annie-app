import React from 'react'

// Small hand-drawn outline icon set (no external icon library dependency),
// styled to match Lucide's stroke conventions. Used across the sidebar and
// the Overview page instead of emoji, for a more premium, modern feel.
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }

function Svg({ className, children }) {
  return <svg viewBox="0 0 24 24" className={className} {...base}>{children}</svg>
}

export const IconHome = p => <Svg {...p}><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></Svg>
export const IconZap = p => <Svg {...p}><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" /></Svg>
export const IconRadio = p => <Svg {...p}><path d="M4 9a8 8 0 0 1 16 0" /><path d="M2 15a10 10 0 0 1 20 0" /><circle cx="12" cy="17" r="1.6" /></Svg>
export const IconUsers = p => <Svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></Svg>
export const IconBuilding = p => <Svg {...p}><rect x="4" y="3" width="10" height="18" /><rect x="14" y="8" width="6" height="13" /><path d="M8 7h2M8 11h2M8 15h2" /></Svg>
export const IconTrendingUp = p => <Svg {...p}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></Svg>
export const IconBell = p => <Svg {...p}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></Svg>
export const IconCalendar = p => <Svg {...p}><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></Svg>
export const IconCheckSquare = p => <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12l3 3 5-6" /></Svg>
export const IconMessageCircle = p => <Svg {...p}><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4A8.7 8.7 0 0 1 8 19l-5 1 1-4.5A8.4 8.4 0 1 1 21 11.5z" /></Svg>
export const IconBriefcase = p => <Svg {...p}><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M2 13h20" /></Svg>
export const IconUser = p => <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" /></Svg>
export const IconSettings = p => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Svg>
export const IconSparkles = p => <Svg {...p}><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" /><path d="M19 15l.7 2.1L22 18l-2.3.9L19 21l-.7-2.1L16 18l2.3-.9z" /></Svg>
export const IconPlus = p => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
export const IconArrowRight = p => <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>
export const IconCreditCard = p => <Svg {...p}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M6 15h4" /></Svg>
// 2026-08-26 — Invoices nav entry: a receipt/document shape (a page with a
// zig-zag "torn" bottom edge, the universal invoice/receipt glyph) so it
// reads distinctly from Billing's IconCreditCard right above it in the
// sidebar, even though both are "money" pages.
export const IconReceipt = p => <Svg {...p}><path d="M6 2h12v19l-3-2-3 2-3-2-3 2V2z" /><path d="M9 7h6M9 11h6M9 15h4" /></Svg>
