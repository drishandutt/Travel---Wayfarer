// Currency helpers. Amounts are integers in the minor unit, and Intl knows how many
// decimals each currency has (yen 0, rupees 2, Kuwaiti dinar 3).

export const CURRENCIES = [
  'INR', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'SGD', 'AED', 'THB', 'IDR', 'MYR', 'VND', 'PHP', 'KRW', 'CNY', 'HKD', 'TWD', 'NZD', 'CHF',
  'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'ZAR', 'BRL', 'MXN', 'ARS', 'CLP', 'COP', 'PEN', 'EGP', 'MAD', 'KES', 'NPR', 'LKR', 'BDT', 'PKR', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'ILS', 'RON',
]

const digitsCache = new Map<string, number>()

export function currencyDigits(code: string): number {
  let d = digitsCache.get(code)
  if (d === undefined) {
    try { d = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2 } catch { d = 2 }
    digitsCache.set(code, d)
  }
  return d
}

export const isCurrencyCode = (code: string) => /^[A-Z]{3}$/.test(code)

export function fmtMoney(minor: number, code: string, opts: { compact?: boolean; sign?: boolean } = {}): string {
  const d = currencyDigits(code)
  const major = minor / 10 ** d
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      // whole amounts stay short: ₹1,200 rather than ₹1,200.00
      minimumFractionDigits: minor % 10 ** d === 0 || opts.compact ? 0 : d,
      maximumFractionDigits: opts.compact ? 0 : d,
      signDisplay: opts.sign ? 'exceptZero' : 'auto',
    }).format(major)
  } catch {
    return `${code} ${major.toFixed(d)}`
  }
}

export function currencySymbol(code: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find(p => p.type === 'currency')?.value ?? code
  } catch {
    return code
  }
}

// Turns the ways people write numbers around the world into plain "1234.5".
function plainNumber(s: string, digits: number): string {
  const dot = s.lastIndexOf('.')
  const comma = s.lastIndexOf(',')
  // with both, the later one is the decimal point: "1,200.50" and "1.200,50"
  if (dot >= 0 && comma >= 0) {
    return dot > comma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.')
  }
  // "12,50" is a decimal comma; "1,200" is thousands
  if (comma >= 0) return /^\d+,\d{1,2}$/.test(s) && digits > 0 ? s.replace(',', '.') : s.replace(/,/g, '')
  // "150.000" is thousands, unless this currency really has three decimals
  if (digits < 3 && /^\d{1,3}(\.\d{3})+$/.test(s)) return s.replace(/\./g, '')
  return s
}

// Reads what someone typed into minor units without going through a float,
// so "19.99" is exactly 1999.
export function parseAmount(text: string, code: string): number | null {
  const d = currencyDigits(code)
  const s = plainNumber(text.trim().replace(/\s/g, '').replace(/^[^\d.,-]+/, ''), d)
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null
  const [whole, frac = ''] = s.split('.')
  if (frac.length > d && /[1-9]/.test(frac.slice(d))) return null
  const minor = Number(whole || '0') * 10 ** d + Number((frac + '0'.repeat(d)).slice(0, d) || '0')
  return Number.isSafeInteger(minor) ? minor : null
}

// The other direction, for prefilling an input when editing.
export function amountToInput(minor: number, code: string): string {
  const d = currencyDigits(code)
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  if (d === 0) return `${sign}${abs}`
  const whole = Math.floor(abs / 10 ** d)
  const frac = String(abs % 10 ** d).padStart(d, '0').replace(/0+$/, '')
  return `${sign}${whole}${frac ? `.${frac}` : ''}`
}

// Same as parseAmount, but an adjustment may be negative.
export function parseSigned(text: string, code: string): number | null {
  const s = text.trim().replace(/^[−–]/, '-')
  if (s.startsWith('-')) { const n = parseAmount(s.slice(1), code); return n === null ? null : -n }
  return parseAmount(s.replace(/^\+/, ''), code)
}

// "25.5" -> 2550 (percent to basis points, shares to hundredths), exact to two decimals.
export function parseHundredths(text: string): number | null {
  const s = text.trim().replace(',', '.')
  if (!/^\d*\.?\d{0,2}$/.test(s) || s === '' || s === '.') return null
  const [whole, frac = ''] = s.split('.')
  const n = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2))
  return Number.isSafeInteger(n) ? n : null
}

export const hundredthsToInput = (n: number) => {
  const frac = String(n % 100).padStart(2, '0').replace(/0+$/, '')
  return `${Math.floor(n / 100)}${frac ? `.${frac}` : ''}`
}

// Best guess at someone's home currency, from their browser's region.
const REGION: Record<string, string> = {
  IN: 'INR', US: 'USD', GB: 'GBP', AU: 'AUD', CA: 'CAD', SG: 'SGD', AE: 'AED', JP: 'JPY', NZ: 'NZD', CH: 'CHF', ZA: 'ZAR', BR: 'BRL', MX: 'MXN', TH: 'THB', ID: 'IDR', MY: 'MYR', PH: 'PHP', KR: 'KRW', CN: 'CNY', HK: 'HKD', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', TR: 'TRY', NP: 'NPR', LK: 'LKR', BD: 'BDT', PK: 'PKR', SA: 'SAR',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', PT: 'EUR', IE: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', GR: 'EUR',
}

export function homeCurrency(): string {
  try {
    const region = new Intl.Locale(navigator.language).region
    return (region && REGION[region]) || 'USD'
  } catch {
    return 'USD'
  }
}
