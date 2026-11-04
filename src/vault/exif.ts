// Reads when and where a JPEG was taken from its EXIF block. Only what the vault sorts by:
// the camera's DateTimeOriginal and the GPS position. Everything else is skipped.

export interface PhotoFacts {
  takenAt: string | null
  lat: number | null
  lng: number | null
}

const NONE: PhotoFacts = { takenAt: null, lat: null, lng: null }

export function readExif(buf: ArrayBuffer): PhotoFacts {
  const v = new DataView(buf)
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return NONE
  let at = 2
  while (at + 4 <= v.byteLength) {
    if (v.getUint8(at) !== 0xff) return NONE
    const marker = v.getUint8(at + 1)
    // start of the image data: no EXIF before it
    if (marker === 0xda) return NONE
    const size = v.getUint16(at + 2)
    if (marker === 0xe1 && at + 10 <= v.byteLength && v.getUint32(at + 4) === 0x45786966) {
      try { return parseTiff(v, at + 10, Math.min(v.byteLength, at + 2 + size)) } catch { return NONE }
    }
    at += 2 + size
  }
  return NONE
}

function parseTiff(v: DataView, start: number, end: number): PhotoFacts {
  const little = v.getUint16(start) === 0x4949
  const u16 = (o: number) => v.getUint16(start + o, little)
  const u32 = (o: number) => v.getUint32(start + o, little)
  const inside = (o: number, n: number) => start + o + n <= end

  // tag → offset of its 12-byte entry, for one directory
  const entries = (ifd: number) => {
    const out = new Map<number, number>()
    if (!inside(ifd, 2)) return out
    const n = u16(ifd)
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12
      if (!inside(e, 12)) break
      out.set(u16(e), e)
    }
    return out
  }
  const ascii = (e: number) => {
    const count = u32(e + 4)
    const off = count > 4 ? u32(e + 8) : e + 8
    if (!inside(off, count)) return null
    let s = ''
    for (let i = 0; i < count; i++) {
      const c = v.getUint8(start + off + i)
      if (!c) break
      s += String.fromCharCode(c)
    }
    return s
  }
  const rationals = (e: number) => {
    const count = u32(e + 4)
    const off = u32(e + 8)
    if (!inside(off, count * 8)) return null
    const out: number[] = []
    for (let i = 0; i < count; i++) {
      const den = u32(off + i * 8 + 4)
      out.push(den ? u32(off + i * 8) / den : 0)
    }
    return out
  }

  const ifd0 = entries(u32(4))
  let takenAt: string | null = null
  const exifPtr = ifd0.get(0x8769)
  if (exifPtr !== undefined) {
    const exif = entries(u32(exifPtr + 8))
    const raw = (exif.has(0x9003) ? ascii(exif.get(0x9003)!) : null) ?? (ifd0.has(0x0132) ? ascii(ifd0.get(0x0132)!) : null)
    const m = raw?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
    if (m && m[1] !== '0000') takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
  }

  let lat: number | null = null
  let lng: number | null = null
  const gpsPtr = ifd0.get(0x8825)
  if (gpsPtr !== undefined) {
    const gps = entries(u32(gpsPtr + 8))
    const coord = (refTag: number, valTag: number, neg: string) => {
      if (!gps.has(refTag) || !gps.has(valTag)) return null
      const ref = ascii(gps.get(refTag)!)
      const [d, m, s] = rationals(gps.get(valTag)!) ?? []
      if (d === undefined) return null
      const value = d + (m ?? 0) / 60 + (s ?? 0) / 3600
      return ref?.toUpperCase() === neg ? -value : value
    }
    lat = coord(1, 2, 'S')
    lng = coord(3, 4, 'W')
    // 0,0 is what some cameras write when they had no fix
    if (lat === 0 && lng === 0) lat = lng = null
    if (lat !== null && Math.abs(lat) > 90) lat = null
    if (lng !== null && Math.abs(lng) > 180) lng = null
    if (lat === null || lng === null) lat = lng = null
  }
  return { takenAt, lat, lng }
}

