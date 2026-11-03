// Tiny inline icon set — no icon dependency needed for a handful of glyphs.
const base = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const WalkIcon = () => (
  <svg {...base}><circle cx="13" cy="4" r="2" /><path d="M9 21l2-6 3 3v3M7 12l3-4 4 1 3 3M11 15l-1-5" /></svg>
)
export const TransitIcon = () => (
  <svg {...base}><rect x="5" y="3" width="14" height="14" rx="3" /><path d="M5 11h14M8 21l2-4M16 21l-2-4" /><circle cx="9" cy="14" r=".6" /><circle cx="15" cy="14" r=".6" /></svg>
)
export const BedIcon = () => (
  <svg {...base}><path d="M3 18V7M3 14h18v4M21 14v-3a3 3 0 0 0-3-3h-7v6" /><circle cx="7" cy="11" r="2" /></svg>
)
export const SparkIcon = () => (
  <svg {...base}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></svg>
)
export const SendIcon = () => (
  <svg {...base} width={18} height={18}><path d="M4 12l16-8-6 16-2-6-8-2z" /></svg>
)
export const PauseIcon = () => (
  <svg {...base}><path d="M12 7v5l3 2" /><circle cx="12" cy="12" r="9" /></svg>
)
export const ChevronIcon = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg {...base} width={16} height={16}><path d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} /></svg>
)
export const ChatIcon = () => (
  <svg {...base} width={18} height={18}><path d="M4 5h16v11H9l-5 4z" /></svg>
)
export const RouteIcon = () => (
  <svg {...base} width={18} height={18}><circle cx="6" cy="18" r="2" /><circle cx="18" cy="6" r="2" /><path d="M8 18h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7" /></svg>
)
export const SunIcon = () => (
  <svg {...base} width={16} height={16}><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></svg>
)
export const MoonIcon = () => (
  <svg {...base} width={16} height={16}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></svg>
)
