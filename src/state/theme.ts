import { useCallback, useEffect, useState } from 'react'

// Light or dark. Follows the device until the viewer picks one; the pick is remembered.
export type Theme = 'light' | 'dark'

const KEY = 'wayfarer:theme'
const META = { light: '#f5f5f7', dark: '#000000' }

function saved(): Theme | null {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : null
  } catch {
    return null
  }
}

const device = (): Theme => (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => saved() ?? device())

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[theme])
  }, [theme])

  // no explicit choice yet: keep following the device
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const on = () => { if (!saved()) setTheme(device()) }
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const toggle = useCallback(() => {
    setTheme(t => {
      const next: Theme = t === 'dark' ? 'light' : 'dark'
      try { localStorage.setItem(KEY, next) } catch { /* storage blocked: applies for this visit */ }
      return next
    })
  }, [])

  return [theme, toggle]
}
