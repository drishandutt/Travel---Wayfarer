import { useState } from 'react'
import { createPortal } from 'react-dom'
import { categoryOf } from '../../money/categories'
import { fmtMoney } from '../../money/currency'
import { receiptUrl } from '../../money/client'
import { shrinkImage, niceDate, timeAgo } from '../../money/util'
import { tripDay } from '../../money/engine'
import { Avatar, Modal, useCtx } from './parts'

const METHOD_LABEL = { equal: 'split equally', exact: 'split by exact amounts', percent: 'split by percentages', shares: 'split by shares', adjust: 'split with adjustments', itemized: 'split by item' }

export function ExpenseDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { s, g, fmt, name, editExpense, toast, online } = useCtx()
  const e = s.expenses.find(x => x.id === id)
  const [text, setText] = useState('')
  const [viewing, setViewing] = useState<string | null>(null)
  if (!e) return null

  const comments = s.comments.filter(c => c.expenseId === e.id)
  const history = s.activity.filter(a => a.ref === e.id && a.kind.startsWith('expense-')).slice(0, 8)
  const cat = categoryOf(e.category)
  const day = tripDay(e.date, s.group.trip)
  const foreign = e.currency !== s.group.currency
  const memberIds = [...new Set([...Object.keys(e.basePaid), ...Object.keys(e.baseOwed)])]

  const send = () => {
    const body = text.trim()
    if (!body) return
    setText('')
    g.actions.addComment(e.id, body)
  }

  const addPhoto = async (file: File) => {
    try {
      await g.actions.call('POST', `/expenses/${e.id}/receipts`, undefined, await shrinkImage(file))
    } catch (err) {
      toast((err as Error).message)
    }
  }

  return (
    <Modal
      eyebrow={`${cat.label}${e.privateTo ? ' · just for you' : ''}`}
      title={e.title}
      onClose={() => (viewing ? setViewing(null) : onClose())}
      footer={e.deletedAt ? (
        <button className="cta" onClick={() => { g.actions.restoreExpense(e.id, e.title); toast('Restored') }}>Restore expense</button>
      ) : (
        <>
          <button className="danger" onClick={() => {
            if (!confirm(`Delete “${e.title}”? Everyone’s balances will update. You can restore it later.`)) return
            g.actions.deleteExpense(e.id, e.title)
            toast('Deleted. You can restore it from the bottom of Expenses.')
            onClose()
          }}>Delete</button>
          <span className="m-spacer" />
          <button className="cta" onClick={() => { onClose(); editExpense(e.id) }}>Edit</button>
        </>
      )}
    >
      {e.deletedAt && <p className="m-banner bad">Deleted by {name(e.deletedBy)} {timeAgo(e.deletedAt)}. It doesn’t count towards any balance.</p>}
      {e.pending && <p className="m-banner">Saved on this device. It’ll sync when you’re back online.</p>}

      <div className="m-detail-amount">
        <b>{fmtMoney(e.amount, e.currency)}</b>
        {foreign && <small>≈ {fmt(e.baseAmount)} at 1 {e.currency} = {e.fxRate} {s.group.currency}</small>}
        <small>{cat.emoji} {niceDate(e.date)}{day ? ` · Day ${day}` : ''}{e.placeName ? ` · 📍 ${e.placeName}` : ''}</small>
      </div>

      {!e.privateTo && (
        <section className="m-section">
          <h4>Who’s in · {METHOD_LABEL[e.split.method]}</h4>
          <ul className="m-who">
            {memberIds.map(mid => {
              const m = s.members.find(x => x.id === mid)
              const paid = e.basePaid[mid] ?? 0
              const owed = e.baseOwed[mid] ?? 0
              return (
                <li key={mid}>
                  <Avatar id={mid} name={m?.name ?? '?'} size={28} ghost={!m?.joined} />
                  <span className="m-row-name">{name(mid)}{m?.left ? ' (left)' : ''}</span>
                  <span className="m-who-line">
                    {paid > 0 && <em>paid {fmt(paid)}</em>}
                    {owed > 0 && <em>{mid === s.me ? 'your share' : 'share'} {fmt(owed)}</em>}
                  </span>
                </li>
              )
            })}
          </ul>
          {e.split.method === 'itemized' && (
            <ul className="m-receipt-lines">
              {(e.split.items ?? []).map(it => (
                <li key={it.id}><span>{it.name || 'Item'}</span><small>{it.memberIds.map(x => name(x)).join(', ')}</small><b>{fmtMoney(it.amount, e.currency)}</b></li>
              ))}
            </ul>
          )}
        </section>
      )}

      {e.notes && <section className="m-section"><h4>Notes</h4><p className="m-prose">{e.notes}</p></section>}

      <section className="m-section">
        <h4>Receipts</h4>
        <div className="m-receipts">
          {e.receipts.map(r => (
            <button key={r} className="m-receipt" onClick={() => setViewing(r)} aria-label="Open receipt photo">
              <img src={receiptUrl(s.group.id, r)} alt="Receipt" loading="lazy" />
            </button>
          ))}
          {online && !e.pending && !e.deletedAt && e.receipts.length < 5 && (
            <label className="m-photo-btn square">
              📷<span>Add</span>
              <input type="file" accept="image/*" onChange={ev => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) addPhoto(f) }} />
            </label>
          )}
          {!e.receipts.length && !online && <small className="m-note">None yet. Photos can be added when you’re online.</small>}
        </div>
      </section>

      {viewing && createPortal(
        <div className="m-lightbox" role="dialog" aria-label="Receipt photo" onClick={() => setViewing(null)}>
          <img src={receiptUrl(s.group.id, viewing)} alt="Receipt" />
          <div className="m-lightbox-bar">
            <button className="ghost" onClick={() => setViewing(null)}>Close</button>
            <button className="danger" onClick={async ev => {
              ev.stopPropagation()
              if (!confirm('Remove this photo?')) return
              await g.actions.call('DELETE', `/receipts/${viewing}`).catch(err => toast((err as Error).message))
              setViewing(null)
            }}>Remove</button>
          </div>
        </div>,
        document.body,
      )}

      {!e.privateTo && (
        <section className="m-section">
          <h4>Comments</h4>
          {comments.length > 0 && (
            <ul className="m-comments">
              {comments.map(c => {
                const m = s.members.find(x => x.id === c.memberId)
                return (
                  <li key={c.id} className={c.pending ? 'pending' : ''}>
                    <Avatar id={c.memberId} name={m?.name ?? '?'} size={26} />
                    <div>
                      <small><b>{name(c.memberId)}</b> · {c.pending ? 'sending…' : timeAgo(c.createdAt)}</small>
                      <p>{c.body}</p>
                    </div>
                    {c.memberId === s.me && !c.pending && (
                      <button className="m-x small" aria-label="Delete comment" onClick={() => g.actions.call('DELETE', `/comments/${c.id}`).catch(err => toast((err as Error).message))}>×</button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <form className="m-comment-box" onSubmit={ev => { ev.preventDefault(); send() }}>
            <input aria-label="Add a comment" placeholder="Add a comment" value={text} maxLength={1000} onChange={ev => setText(ev.target.value)} />
            <button className="ghost" disabled={!text.trim()}>Send</button>
          </form>
        </section>
      )}

      <section className="m-section">
        <h4>History</h4>
        <ul className="m-history">
          {history.map(a => (
            <li key={a.seq}>
              <b>{name(a.actor)}</b>{' '}
              {a.kind === 'expense-added' ? 'added this' : a.kind === 'expense-deleted' ? 'deleted this' : a.kind === 'expense-restored' ? 'restored this' : `changed ${a.detail.changes?.join(', ') ?? 'this'}`}
              {' '}<small>{timeAgo(a.createdAt)}</small>
            </li>
          ))}
          {!history.length && <li>Added by <b>{name(e.createdBy)}</b> <small>{timeAgo(e.createdAt)}</small></li>}
        </ul>
      </section>
    </Modal>
  )
}
