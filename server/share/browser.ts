import { existsSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext } from 'playwright-core'

// One headless Chromium for reading shared links, started on the first link and closed again
// after a few idle minutes. Production gets Chromium from Debian (railpack.json); a Mac uses
// Playwright's own download or Google Chrome. Set CHROMIUM_PATH to choose another.

const IDLE_MS = 5 * 60_000
const MAX_OPEN = 2

export interface Cookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

export function chromiumPath(): string | null {
  const candidates = [
    process.env.CHROMIUM_PATH,
    (() => { try { return chromium.executablePath() } catch { return undefined } })(),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  return candidates.find(p => p && existsSync(p)) ?? null
}

let browser: Promise<Browser> | null = null
let idle: NodeJS.Timeout | undefined
let open = 0
const waiting: (() => void)[] = []

async function launch(): Promise<Browser> {
  const executablePath = chromiumPath()
  if (!executablePath) throw new Error('No Chromium on this server')
  const b = await chromium.launch({
    executablePath,
    headless: true,
    // containers have a small /dev/shm and no sandbox user
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio', '--disable-blink-features=AutomationControlled'],
  })
  b.on('disconnected', () => { browser = null })
  return b
}

// A fresh context per link, with the site's saved session in it, closed afterwards.
export async function withPage<T>(cookies: Cookie[], fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
  if (open >= MAX_OPEN) await new Promise<void>(r => waiting.push(r))
  open++
  clearTimeout(idle)
  try {
    browser ??= launch().catch(err => { browser = null; throw err })
    const b = await browser
    const ctx = await b.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      locale: 'en-GB',
      viewport: { width: 1280, height: 900 },
    })
    try {
      if (cookies.length) await ctx.addCookies(cookies)
      // pictures, video and fonts aren't read, so they needn't be fetched
      await ctx.route('**/*', route => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()))
      return await fn(ctx)
    } finally {
      await ctx.close().catch(() => {})
    }
  } finally {
    open--
    waiting.shift()?.()
    if (!open) idle = setTimeout(() => { void closeBrowser() }, IDLE_MS).unref()
  }
}

export async function closeBrowser() {
  const b = browser
  browser = null
  await (await b?.catch(() => null))?.close().catch(() => {})
}
