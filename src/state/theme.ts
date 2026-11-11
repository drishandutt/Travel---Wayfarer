import { useCallback, useEffect, useState } from 'react'

// Light or dark. By default it follows the time of day: light from 7 in the morning, dark from
// 7 in the evening, switching on its own. Picking Light or Dark in the Profile fixes it; the
// pick is remembered on this device.
export type Theme = 'light' | 'dark'
export type ThemeMode = 'auto' | Theme

const KEY = 'wayfarer:theme-mode'
const META = { light: '#f5f5f7', dark: '#000000' }
export const DAY_STARTS = 7
export const NIGHT_STARTS = 19

function saved(): ThemeMode {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'auto'
  } catch {
    return 'auto'
  }
}

export const byClock = (d = new Date()): Theme => (d.getHours() >= DAY_STARTS && d.getHours() < NIGHT_STARTS ? 'light' : 'dark')
const resolve = (mode: ThemeMode): Theme => (mode === 'auto' ? byClock() : mode)

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(saved)
  const [theme, setTheme] = useState<Theme>(() => resolve(saved()))

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[theme])
  }, [theme])

  // on Auto, look at the clock every minute, and whenever the app comes back to the front
  useEffect(() => {
    setTheme(resolve(mode))
    if (mode !== 'auto') return
    const check = () => setTheme(byClock())
    const t = setInterval(check, 60_000)
    const back = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', back)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', back) }
  }, [mode])

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m)
    try { if (m === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, m) } catch { /* storage blocked: applies for this visit */ }
  }, [])

  return { theme, mode, setMode }
}
