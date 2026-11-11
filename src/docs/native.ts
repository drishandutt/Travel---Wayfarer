import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import type { AlertItem } from './types'

// In the iPhone app, alerts are scheduled on the phone itself, ahead of time, so they arrive
// on the lock screen when due even with no signal. Every refresh brings the phone's schedule
// in line with the server's: new and moved alerts are (re)scheduled, dropped ones cancelled.
// In a browser this does nothing: the app and email cover it.

export const onPhone = () => Capacitor.isNativePlatform()

// iOS keeps 64 pending notifications per app; the soonest go first
const MAX = 60
const TAG = 'wayfarer-alert'

// A stable number per alert, as iOS wants numeric ids
const numberOf = (id: string) => { let h = 0; for (const c of id) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0; return Math.abs(h) || 1 }

export async function phonePermission(): Promise<'granted' | 'denied' | 'prompt' | 'none'> {
  if (!onPhone()) return 'none'
  const p = await LocalNotifications.checkPermissions()
  return p.display === 'granted' ? 'granted' : p.display === 'denied' ? 'denied' : 'prompt'
}

export async function askPhonePermission(): Promise<boolean> {
  if (!onPhone()) return false
  return (await LocalNotifications.requestPermissions()).display === 'granted'
}

let last = ''
export async function scheduleOnPhone(coming: AlertItem[]): Promise<void> {
  if (!onPhone()) return
  try {
    if ((await phonePermission()) !== 'granted') return
    const now = Date.now()
    const want = coming.filter(a => a.dueAt > now + 30_000).sort((a, b) => a.dueAt - b.dueAt).slice(0, MAX)
    const sig = want.map(a => `${a.id}@${a.dueAt}:${a.title}`).join('|')
    if (sig === last) return
    const pending = (await LocalNotifications.getPending()).notifications.filter(n => n.extra?.tag === TAG)
    if (pending.length) await LocalNotifications.cancel({ notifications: pending.map(n => ({ id: n.id })) })
    if (want.length) {
      await LocalNotifications.schedule({
        notifications: want.map(a => ({
          id: numberOf(a.id),
          title: a.title,
          body: a.body.split(' · ').join('\n'),
          schedule: { at: new Date(a.dueAt), allowWhileIdle: true },
          extra: { tag: TAG, alertId: a.id, docId: a.docId },
        })),
      })
    }
    last = sig
  } catch (err) {
    console.warn('[alerts] scheduling on the phone', (err as Error).message)
  }
}

// Tapping a notification opens the documents
export function onAlertTapped(open: () => void): () => void {
  if (!onPhone()) return () => {}
  const h = LocalNotifications.addListener('localNotificationActionPerformed', e => { if (e.notification.extra?.tag === TAG) open() })
  return () => { void h.then(x => x.remove()) }
}
