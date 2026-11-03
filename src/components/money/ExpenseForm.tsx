import { useEffect, useMemo, useRef, useState } from 'react'
import { newId } from '../../state/persistence'
import { CATEGORIES, categoryForKind, categoryOf, guessCategory } from '../../money/categories'
import { CURRENCIES, amountToInput, currencySymbol, fmtMoney, hundredthsToInput, parseAmount, parseHundredths, parseSigned } from '../../money/currency'
import { SplitError, computeShares, convert, payersProblem } from '../../money/engine'
import { rateTo, todayLocal, useRates } from '../../money/hooks'
import { readLocal, writeLocal } from '../../money/client'
import { niceDate, shrinkImage } from '../../money/util'
import type { CategoryId, Expense, ExpenseInput, Member, MoneyMap, Payer, SplitInput, SplitItem, SplitMethod } from '../../money/types'
import { Avatar, Modal, Toggle, useCtx } from './parts'

export interface ExpensePrefill { title?: string; category?: CategoryId; date?: string; placeId?: string; placeName?: string; amount?: number; private?: boolean }

const METHODS: { id: SplitMethod; label: string; glyph: string; help: string }[] = [
  { id: 'equal', label: 'Equally', glyph: '=', help: 'Everyone ticked pays the same.' },
  { id: 'exact', label: 'Exact', glyph: '1.23', help: 'Enter exactly what each person owes.' },
  { id: 'percent', label: 'Percent', glyph: '%', help: 'Enter each person’s percentage.' },
  { id: 'shares', label: 'Shares', glyph: '⅔', help: 'Great for couples or families: give a couple 2 shares and a solo traveller 1.' },
  { id: 'adjust', label: 'Adjust', glyph: '±', help: 'Split equally, then add or take off for anyone who should pay more or less.' },
  { id: 'itemized', label: 'Items', glyph: '☰', help: 'Split the bill line by line. Tax and tip are shared in proportion to what each person had.' },
]

interface ItemDraft { id: string; name: string; amount: string; memberIds: string[] }

export function ExpenseForm({ existing, prefill, onClose }: { existing?: Expense; prefill?: ExpensePrefill; onClose: () => void }) {
  const { s, g, toast, online } = useCtx()
  const base = s.group.currency
  const trip = s.group.trip
  const rates = useRates(base)
  const id = useRef(existing?.id ?? newId()).current
  // Fixed when the form opens: this is what the edit was based on. A copy still waiting to
  // sync has revision 0, which is revision 1 once it lands.
  const baseRev = useRef(Math.max(existing?.rev ?? 0, 1)).current
  const changedUnderneath = existing ? Math.max(existing.rev, 1) !== baseRev : false

  // Everyone who can be on this: the group now, plus anyone who has since left but is already on it.
  const people = useMemo<Member[]>(() => {
    const onIt = new Set(existing ? [...existing.payers.map(p => p.memberId), ...existing.split.entries.map(e => e.memberId), ...(existing.split.items ?? []).flatMap(i => i.memberIds)] : [])
    return s.members.filter(m => !m.left || onIt.has(m.id))
  }, [s.members, existing])
  const everyone = people.map(m => m.id)

  const [currency, setCurrency] = useState(existing?.currency ?? readLocal(`currency:${s.group.id}`, base))
  const [amountText, setAmountText] = useState(existing ? amountToInput(existing.amount, existing.currency) : prefill?.amount ? amountToInput(prefill.amount, base) : '')
  const [title, setTitle] = useState(existing?.title ?? prefill?.title ?? '')
  const [category, setCategory] = useState<CategoryId>(existing?.category ?? prefill?.category ?? 'other')
  const [categoryTouched, setCategoryTouched] = useState(Boolean(existing || prefill?.category))
  const [date, setDate] = useState(existing?.date ?? prefill?.date ?? todayLocal())
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [isPrivate, setIsPrivate] = useState(Boolean(existing?.privateTo) || Boolean(prefill?.private))
  const [placeId, setPlaceId] = useState(existing?.placeId ?? prefill?.placeId ?? '')
  const [rateText, setRateText] = useState(existing && existing.currency !== base ? String(existing.fxRate) : '')
  const [rateTouched, setRateTouched] = useState(Boolean(existing && existing.currency !== base))
  const [photos, setPhotos] = useState<File[]>([])

  // who paid
  const [multiPay, setMultiPay] = useState((existing?.payers.length ?? 1) > 1)
  const [payer, setPayer] = useState(existing?.payers[0]?.memberId ?? s.me)
  const [payerText, setPayerText] = useState<Record<string, string>>(() =>
    Object.fromEntries((existing?.payers ?? []).map(p => [p.memberId, amountToInput(p.amount, existing!.currency)])))

  // how it's split
  const [method, setMethod] = useState<SplitMethod>(existing?.split.method ?? 'equal')
  const [included, setIncluded] = useState<Set<string>>(() => new Set(
    existing && (existing.split.method === 'equal' || existing.split.method === 'adjust') ? existing.split.entries.map(e => e.memberId) : s.members.filter(m => !m.left).map(m => m.id)))
  const [values, setValues] = useState<Record<string, string>>(() => {
    if (!existing) return {}
    const out: Record<string, string> = {}
    for (const e of existing.split.entries) {
      if (existing.split.method === 'exact' || existing.split.method === 'adjust') out[e.memberId] = amountToInput(e.value, existing.currency)
      if (existing.split.method === 'percent' || existing.split.method === 'shares') out[e.memberId] = hundredthsToInput(e.value)
    }
    return out
  })
  const [items, setItems] = useState<ItemDraft[]>(() =>
    (existing?.split.items ?? []).map(i => ({ id: i.id, name: i.name, amount: amountToInput(i.amount, existing!.currency), memberIds: i.memberIds })))

  const firstInput = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!existing && window.innerWidth > 760) firstInput.current?.focus() }, [existing])

  // the chosen category can be off the end of the scrolling row
  const cats = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = cats.current
    const on = row?.querySelector<HTMLElement>('.on')
    if (row && on) row.scrollLeft = Math.max(0, on.offsetLeft - row.offsetLeft - 16)
  }, [category])

  // keep the suggested rate current until someone types their own
  const suggested = currency === base ? 1 : rateTo(rates, currency)
  useEffect(() => { if (!rateTouched && suggested && currency !== base) setRateText(String(suggested)) }, [suggested, currency, base, rateTouched])

  const amount = parseAmount(amountText, currency)
  const fxRate = currency === base ? 1 : Number(rateText)
  const rateOk = currency === base || (Number.isFinite(fxRate) && fxRate > 0)
  const money = (n: number) => fmtMoney(n, currency)

  const changeTitle = (v: string) => {
    setTitle(v)
    if (!categoryTouched) setCategory(guessCategory(v) ?? 'other')
  }

  const pickStop = (stopId: string) => {
    setPlaceId(stopId)
    const stop = trip?.stops.find(x => x.id === stopId)
    if (!stop) return
    if (!title.trim()) setTitle(stop.name)
    if (!categoryTouched) setCategory(categoryForKind(stop.kind))
    if (trip?.startDate && !existing) {
      const d = new Date(`${trip.startDate}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + stop.day - 1)
      setDate(d.toISOString().slice(0, 10))
    }
  }

  // ── working out the split as they type ──
  const parsed = useMemo((): { split?: SplitInput; problem?: string } => {
    if (method === 'equal') return { split: { method, entries: everyone.filter(m => included.has(m)).map(memberId => ({ memberId, value: 1 })) } }
    if (method === 'itemized') {
      const out: SplitItem[] = []
      for (const it of items) {
        const n = parseAmount(it.amount, currency)
        if (n === null || n <= 0) return { problem: `Enter a price for ${it.name.trim() || 'every item'}` }
        out.push({ id: it.id, name: it.name.trim(), amount: n, memberIds: it.memberIds })
      }
      return { split: { method, entries: [], items: out } }
    }
    const entries = []
    for (const memberId of everyone) {
      if (method === 'adjust' && !included.has(memberId)) continue
      const text = values[memberId]?.trim() ?? ''
      const value = !text ? 0 : method === 'adjust' ? parseSigned(text, currency) : method === 'exact' ? parseAmount(text, currency) : parseHundredths(text)
      if (value === null) return { problem: `Check the number for ${people.find(p => p.id === memberId)?.name}` }
      if ((method === 'exact' || method === 'percent' || method === 'shares') && value === 0) continue
      entries.push({ memberId, value })
    }
    return { split: { method, entries } }
  }, [method, everyone, included, items, values, currency, people])

  const { shares, splitProblem, splitDelta } = useMemo((): { shares: MoneyMap | null; splitProblem: string | null; splitDelta?: number } => {
    if (parsed.problem) return { shares: null, splitProblem: parsed.problem }
    if (!amount) return { shares: null, splitProblem: null }
    try {
      return { shares: computeShares(amount, parsed.split!, id), splitProblem: null }
    } catch (err) {
      if (!(err instanceof SplitError)) throw err
      const d = err.delta
      if (err.code === 'exact-mismatch') return { shares: null, splitProblem: d! > 0 ? `${money(d!)} left to assign` : `${money(-d!)} too much`, splitDelta: d }
      if (err.code === 'percent-mismatch') return { shares: null, splitProblem: d! > 0 ? `${hundredthsToInput(d!)}% left to assign` : `${hundredthsToInput(-d!)}% too much`, splitDelta: d }
      return { shares: null, splitProblem: err.message }
    }
  }, [parsed, amount, id, currency])

  const payers = useMemo((): Payer[] | null => {
    if (!amount) return null
    if (isPrivate) return [{ memberId: s.me, amount }]
    if (!multiPay) return [{ memberId: payer, amount }]
    const out: Payer[] = []
    for (const memberId of everyone) {
      const text = payerText[memberId]?.trim()
      if (!text) continue
      const n = parseAmount(text, currency)
      if (n === null) return null
      if (n > 0) out.push({ memberId, amount: n })
    }
    return out
  }, [amount, isPrivate, multiPay, payer, payerText, everyone, currency, s.me])
  const payProblem = amount && payers ? payersProblem(amount, payers) : null
  const payDelta = payProblem?.delta

  const problem = changedUnderneath ? 'Someone just changed this. Close it and reopen to see what’s new.'
    : !amount ? 'Enter an amount'
    : !title.trim() ? 'Say what it was for'
    : !rateOk ? 'Enter an exchange rate'
    : !isPrivate && splitProblem ? splitProblem
    : !isPrivate && multiPay && !payers ? 'Check what each person paid'
    : !isPrivate && multiPay && payProblem ? (payDelta !== undefined ? (payDelta > 0 ? `${money(payDelta)} of the payment unaccounted for` : `Payments are ${money(-payDelta)} over`) : payProblem.message)
    : null

  const save = async () => {
    if (problem || !amount || !payers) return
    const stop = trip?.stops.find(x => x.id === placeId)
    const input: ExpenseInput = {
      id, title: title.trim(), amount, currency, fxRate, category, date, notes: notes.trim(),
      payers: isPrivate ? [{ memberId: s.me, amount }] : payers,
      split: isPrivate ? { method: 'equal', entries: [{ memberId: s.me, value: 1 }] } : parsed.split!,
      private: isPrivate,
      placeId: placeId || null,
      placeName: stop?.name ?? (placeId ? existing?.placeName ?? prefill?.placeName ?? null : null),
    }
    writeLocal(`currency:${s.group.id}`, currency)
    onClose()
    if (existing) g.actions.updateExpense(input, baseRev)
    else g.actions.createExpense(input)
    if (!photos.length) return
    // photos can only attach once the expense is on the server
    try {
      await g.actions.flushNow()
      for (const file of photos) await g.actions.call('POST', `/expenses/${id}/receipts`, undefined, await shrinkImage(file))
    } catch (err) {
      toast(`The expense saved, but the photo didn’t: ${(err as Error).message}`)
    }
  }

  const toggleIncluded = (m: string) => setIncluded(prev => {
    const next = new Set(prev)
    if (next.has(m)) next.delete(m)
    else next.add(m)
    return next
  })

  const switchMethod = (next: SplitMethod) => {
    if (next === method) return
    setMethod(next)
    setValues(next === 'shares' ? Object.fromEntries(everyone.filter(m => included.has(m)).map(m => [m, '1'])) : {})
    if (next === 'itemized' && !items.length) setItems([{ id: newId(), name: '', amount: '', memberIds: everyone.filter(m => included.has(m)) }])
  }

  // quick fill: whatever's left goes to this person
  const fillRest = (memberId: string) => {
    if (!amount && method === 'exact') return
    const delta = splitDelta ?? 0
    if (method === 'exact') {
      const cur = parseAmount(values[memberId] ?? '', currency) ?? 0
      setValues(v => ({ ...v, [memberId]: amountToInput(Math.max(0, cur + delta), currency) }))
    } else if (method === 'percent') {
      const cur = parseHundredths(values[memberId] ?? '') ?? 0
      setValues(v => ({ ...v, [memberId]: hundredthsToInput(Math.max(0, cur + delta)) }))
    }
  }

  const itemsTotal = items.reduce((t, it) => t + (parseAmount(it.amount, currency) ?? 0), 0)
  const extras = amount !== null ? amount - itemsTotal : 0
  const others = s.members.filter(m => !m.left && m.id !== s.me).length
  const currencies = [...new Set([base, ...(trip ? [trip.localCurrency] : []), currency, ...CURRENCIES])]

  return (
    <Modal
      eyebrow={existing ? 'Edit expense' : 'New expense'}
      title={title.trim() || (existing ? existing.title : 'What did you spend?')}
      onClose={onClose}
      footer={(
        <>
          <span className={`m-form-status ${problem ? 'bad' : 'good'}`} role="status">{problem ?? (online ? 'Ready to save' : 'You’re offline: this saves here and syncs later')}</span>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="cta" disabled={Boolean(problem)} onClick={save}>{existing ? 'Save changes' : 'Add expense'}</button>
        </>
      )}
    >
      <div className="m-amount">
        <select aria-label="Currency" value={currency} onChange={e => { setCurrency(e.target.value); setRateTouched(false); setRateText('') }}>
          {currencies.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span aria-hidden>{currencySymbol(currency)}</span>
        <input ref={firstInput} aria-label="Amount" inputMode="decimal" placeholder="0" value={amountText} onChange={e => setAmountText(e.target.value)} autoComplete="off" />
      </div>

      {currency !== base && (
        <div className="m-rate">
          <label>
            1 {currency} =
            <input inputMode="decimal" aria-label={`Exchange rate to ${base}`} value={rateText} onChange={e => { setRateText(e.target.value.replace(',', '.')); setRateTouched(true) }} placeholder="rate" />
            {base}
          </label>
          <small>
            {amount && rateOk ? <b>≈ {fmtMoney(convert(amount, currency, fxRate, base), base)}</b> : null}
            {rateTouched ? ' Your rate, locked in for this expense.' : suggested ? ` ${rates?.stale ? 'Last known' : 'Today’s'} rate, locked in when you save. Change it to match your card.` : ' No rate available offline: type the one you got.'}
            {rates && !rateTouched && <em> {rates.source}</em>}
          </small>
        </div>
      )}

      <label className="m-field">
        <span>What was it for?</span>
        <input value={title} onChange={e => changeTitle(e.target.value)} placeholder="Dinner, taxi, tickets…" maxLength={120} autoComplete="off" />
      </label>

      <div className="m-cats" ref={cats} role="radiogroup" aria-label="Category">
        {CATEGORIES.map(c => (
          <button key={c.id} type="button" role="radio" aria-checked={category === c.id} className={category === c.id ? 'on' : ''} onClick={() => { setCategory(c.id); setCategoryTouched(true) }}>
            <span aria-hidden>{c.emoji}</span>{c.label}
          </button>
        ))}
      </div>

      <div className="m-two">
        <label className="m-field">
          <span>When</span>
          <input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} />
        </label>
        {trip && trip.stops.length > 0 && (
          <label className="m-field">
            <span>Where <em>(optional)</em></span>
            <select value={placeId} onChange={e => pickStop(e.target.value)}>
              <option value="">Not a planned stop</option>
              {[...new Set(trip.stops.map(x => x.day))].map(day => (
                <optgroup key={day} label={`Day ${day}`}>
                  {trip.stops.filter(x => x.day === day).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                </optgroup>
              ))}
              {placeId && !trip.stops.some(x => x.id === placeId) && <option value={placeId}>{existing?.placeName ?? prefill?.placeName ?? 'Elsewhere'}</option>}
            </select>
          </label>
        )}
      </div>

      {!existing && (
        <Toggle on={isPrivate} onChange={setIsPrivate} label="Just for me" hint="Only you can see it. It counts in your spending, not in anyone’s balance." />
      )}
      {existing?.privateTo && <p className="m-note">Only you can see this. It isn’t in anyone’s balance.</p>}

      {!isPrivate && (
        <>
          <fieldset className="m-group">
            <legend>Paid by</legend>
            <div className="m-chips">
              {people.map(m => (
                <button key={m.id} type="button" aria-pressed={!multiPay && payer === m.id} className={!multiPay && payer === m.id ? 'on' : ''} onClick={() => { setMultiPay(false); setPayer(m.id) }}>
                  <Avatar id={m.id} name={m.name} size={20} ghost={!m.joined} />{m.id === s.me ? 'You' : m.name}
                </button>
              ))}
              {people.length > 1 && <button type="button" aria-pressed={multiPay} className={multiPay ? 'on' : ''} onClick={() => setMultiPay(true)}>Several people</button>}
            </div>
            {multiPay && (
              <div className="m-rows">
                {people.map(m => (
                  <div className="m-row" key={m.id}>
                    <Avatar id={m.id} name={m.name} size={26} ghost={!m.joined} />
                    <span className="m-row-name">{m.id === s.me ? 'You' : m.name}</span>
                    <div className="m-input-money">
                      <i>{currencySymbol(currency)}</i>
                      <input inputMode="decimal" aria-label={`${m.name} paid`} placeholder="0" value={payerText[m.id] ?? ''} onChange={e => setPayerText(p => ({ ...p, [m.id]: e.target.value }))} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset className="m-group">
            <legend>Split</legend>
            <div className="m-methods" role="tablist" aria-label="How to split">
              {METHODS.map(x => (
                <button key={x.id} type="button" role="tab" aria-selected={method === x.id} className={method === x.id ? 'on' : ''} onClick={() => switchMethod(x.id)}>
                  <b aria-hidden>{x.glyph}</b>{x.label}
                </button>
              ))}
            </div>
            <p className="m-note">{METHODS.find(x => x.id === method)!.help}</p>
            {others === 0 && <p className="m-note">Add people under People to split with them.</p>}

            {method !== 'itemized' && (
              <div className="m-rows">
                {people.map(m => {
                  const inputMethod = method !== 'equal'
                  const hasToggle = method === 'equal' || method === 'adjust'
                  const on = !hasToggle || included.has(m.id)
                  return (
                    <div key={m.id} className={`m-row ${on ? '' : 'off'}`}>
                      {hasToggle
                        ? <input type="checkbox" className="m-check" checked={on} aria-label={`Include ${m.name}`} onChange={() => toggleIncluded(m.id)} />
                        : null}
                      <Avatar id={m.id} name={m.name} size={26} ghost={!m.joined} />
                      <span className="m-row-name">{m.id === s.me ? 'You' : m.name}</span>
                      <span className="m-row-result">{shares && on && shares[m.id] ? money(shares[m.id]) : on && shares ? money(0) : ''}</span>
                      {inputMethod && on && (
                        <div className="m-input-money">
                          {method === 'exact' && <i>{currencySymbol(currency)}</i>}
                          {method === 'adjust' && <i>±</i>}
                          <input
                            inputMode={method === 'adjust' ? 'text' : 'decimal'}
                            aria-label={`${METHODS.find(x => x.id === method)!.label} for ${m.name}`}
                            placeholder="0"
                            value={values[m.id] ?? ''}
                            onChange={e => setValues(v => ({ ...v, [m.id]: e.target.value }))}
                          />
                          {method === 'percent' && <em>%</em>}
                          {method === 'shares' && <em>{(values[m.id] ?? '') === '1' ? 'share' : 'shares'}</em>}
                        </div>
                      )}
                      {(method === 'exact' || method === 'percent') && splitDelta !== undefined && splitDelta > 0 && (
                        <button type="button" className="m-fill" onClick={() => fillRest(m.id)} title="Give this person what’s left" aria-label={`Give ${m.name} what’s left`}>+ rest</button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {method === 'itemized' && (
              <>
                <div className="m-items">
                  {items.map(it => (
                    <div className="m-item" key={it.id}>
                      <div className="m-item-top">
                        <input aria-label="Item name" placeholder="Item" value={it.name} onChange={e => setItems(list => list.map(x => (x.id === it.id ? { ...x, name: e.target.value } : x)))} />
                        <div className="m-input-money">
                          <i>{currencySymbol(currency)}</i>
                          <input inputMode="decimal" aria-label="Item price" placeholder="0" value={it.amount} onChange={e => setItems(list => list.map(x => (x.id === it.id ? { ...x, amount: e.target.value } : x)))} />
                        </div>
                        <button type="button" className="m-x small" aria-label="Remove item" onClick={() => setItems(list => list.filter(x => x.id !== it.id))}>×</button>
                      </div>
                      <div className="m-chips small">
                        {people.map(m => {
                          const on = it.memberIds.includes(m.id)
                          return (
                            <button key={m.id} type="button" aria-pressed={on} className={on ? 'on' : ''}
                              onClick={() => setItems(list => list.map(x => (x.id === it.id ? { ...x, memberIds: on ? x.memberIds.filter(y => y !== m.id) : [...x.memberIds, m.id] } : x)))}>
                              {m.id === s.me ? 'You' : m.name}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <button type="button" className="m-add-item" onClick={() => setItems(list => [...list, { id: newId(), name: '', amount: '', memberIds: everyone.filter(m => included.has(m)) }])}>+ Add an item</button>
                {amount !== null && items.length > 0 && (
                  <p className="m-note">
                    Items come to {money(itemsTotal)}.{' '}
                    {extras > 0 ? `The other ${money(extras)} (tax, tip, service) is shared in proportion.` : extras < 0 ? `That’s ${money(-extras)} more than the total, so it’s treated as a discount, shared in proportion.` : 'That matches the total exactly.'}
                  </p>
                )}
                {shares && (
                  <div className="m-item-result">
                    {Object.entries(shares).map(([mid, n]) => <span key={mid}><b>{mid === s.me ? 'You' : people.find(p => p.id === mid)?.name}</b> {money(n)}</span>)}
                  </div>
                )}
              </>
            )}
          </fieldset>
        </>
      )}

      <label className="m-field">
        <span>Notes <em>(optional)</em></span>
        <textarea rows={2} value={notes} maxLength={1000} onChange={e => setNotes(e.target.value)} placeholder="Anything worth remembering" />
      </label>

      <div className="m-field">
        <span>Receipt <em>(optional)</em></span>
        {online ? (
          <label className="m-photo-btn">
            📷 {photos.length ? `${photos.length} photo${photos.length > 1 ? 's' : ''} ready` : 'Add a photo'}
            <input type="file" accept="image/*" multiple onChange={e => {
              // read the files before clearing the input, which empties this same list
              const chosen = Array.from(e.target.files ?? [])
              e.target.value = ''
              setPhotos(p => [...p, ...chosen].slice(0, 5))
            }} />
          </label>
        ) : <small>Photos can be added once you’re back online.</small>}
      </div>

      <p className="m-form-foot">{categoryOf(category).emoji} {categoryOf(category).label} · {niceDate(date)}</p>
    </Modal>
  )
}
