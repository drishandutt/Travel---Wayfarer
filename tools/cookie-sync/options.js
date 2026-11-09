import { SITES, settings } from './sites.js'

const $ = id => document.getElementById(id)
const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago` }

async function render() {
  const s = await settings()
  const { status = {} } = await chrome.storage.local.get('status')
  $('server').value = s.server
  $('token').value = s.token
  $('sites').replaceChildren(...SITES.map(site => {
    const li = document.createElement('li')
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: s.enabled.includes(site.site), value: site.site })
    const name = Object.assign(document.createElement('span'), { textContent: site.name })
    const st = status[site.site]
    const note = Object.assign(document.createElement('small'), {
      textContent: !st ? 'Not synced yet' : st.ok ? `Synced ${ago(st.at)}` : st.error,
      className: !st ? '' : st.ok ? 'ok' : 'bad',
    })
    li.append(box, name, note)
    return li
  }))
}

async function save() {
  const server = $('server').value.trim().replace(/\/+$/, '')
  const token = $('token').value.trim()
  const enabled = [...document.querySelectorAll('#sites input:checked')].map(i => i.value)
  // another Wayfarer server needs the extension's permission to reach it
  try {
    const origin = `${new URL(server).origin}/*`
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      const ok = await chrome.permissions.request({ origins: [origin] })
      if (!ok) { $('msg').textContent = 'Chrome needs permission to reach that address.'; return }
    }
  } catch { $('msg').textContent = 'That address doesn’t look right.'; return }
  await chrome.storage.sync.set({ server, token, enabled })
  await sync()
}

async function sync() {
  $('msg').textContent = 'Syncing…'
  await chrome.runtime.sendMessage('sync-now')
  $('msg').textContent = 'Done.'
  await render()
}

$('save').addEventListener('click', save)
$('sync').addEventListener('click', sync)
render()
