import { useEffect, useMemo, useRef, useState } from 'react'
import { newId } from '../../state/persistence'
import { CURRENCIES, amountToInput, currencySymbol, fmtMoney, parseAmount } from '../../money/currency'
import { convert, debtsOf, netBalances } from '../../money/engine'
import { rateTo, todayLocal, useRates } from '../../money/hooks'
import { upiLink } from '../../money/util'
import type { Debt, PayMethod } from '../../money/types'
import { Avatar, Field, Modal, useCtx } from './parts'

const PAY_METHODS: { id: PayMethod; label: string }[] = [
  { id: 'cash', label: 'Cash' }, { id: 'upi', label: 'UPI' }, { id: 'card', label: 'Card' }, { id: 'bank', label: 'Bank' }, { id: 'other', label: 'Other' },
]

// Records a payment made outside the app. Wayfarer keeps the books; it doesn't move money.
export function SettleForm({ debt, onClose }: { debt?: Debt; onClose: () => void }) {
  const { s, g, toast, online } = useCtx()
  const base = s.group.currency
  const debts = useMemo(() => debtsOf(s), [s])
  const start = debt ?? debts.find(d => d.from === s.me || d.to === s.me) ?? debts[0]
  // someone who left can owe again if an old expense gets corrected
  const net = useMemo(() => netBalances(s.expenses, s.settlements), [s])
  const active = s.members.filter(m => !m.left || net[m.id])
  const id = useRef(newId()).current

  const [from, setFrom] = useState(start?.from ?? s.me)
  const [to, setTo] = useState(start?.to ?? active.find(m => m.id !== s.me)?.id ?? '')
  const [currency, setCurrency] = useState(base)
  const [amountText, setAmountText] = useState(start ? amountToInput(start.amount, base) : '')
  const [date, setDate] = useState(todayLocal())
  const [note, setNote] = useState('')
  const [method, setMethod] = useState<PayMethod>('cash')
  const [rateText, setRateText] = useState('')
  const rates = useRates(base)
  const suggested = currency === base ? 1 : rateTo(rates, currency)
  useEffect(() => { if (currency !== base) setRateText(suggested ? String(suggested) : '') }, [currency, base, suggested])

  const amount = parseAmount(amountText, currency)
  const fxRate = currency === base ? 1 : Number(rateText)
  const problem = !to || !from ? 'Pick who paid whom'
    : from === to ? 'Pick two different people'
    : !amount ? 'Enter an amount'
    : !(fxRate > 0) ? 'Enter an exchange rate'
    : null

  // what's outstanding between this pair, to tell someone if they're over or under
  const owedHere = debts.find(d => d.from === from && d.to === to)?.amount ?? 0
  const baseAmount = amount && fxRate > 0 ? convert(amount, currency, fxRate, base) : 0
  const payee = s.members.find(m => m.id === to)
  const upi = from === s.me && amount ? upiLink(payee?.payHandle ?? null, payee?.name ?? '', amount, currency, `${s.group.name} settle up`) : null

  const save = () => {
    if (problem || !amount) return
    onClose()
    g.actions.createSettlement({ id, from, to, amount, currency, fxRate, date, note: note.trim(), method })
    toast(online ? 'Payment recorded' : 'Payment saved here. It’ll sync when you’re back online.')
  }

  return (
    <Modal
      eyebrow="Settle up"
      title="Record a payment"
      onClose={onClose}
      footer={(
        <>
          <span className={`m-form-status ${problem ? 'bad' : 'good'}`} role="status">{problem ?? (owedHere && baseAmount === owedHere ? 'That clears it' : 'Ready to record')}</span>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="cta" disabled={Boolean(problem)} onClick={save}>Record payment</button>
        </>
      )}
    >
      <div className="m-settle-who">
        <label className="m-field">
          <span>Who paid</span>
          <select value={from} onChange={e => setFrom(e.target.value)}>
            {active.map(m => <option key={m.id} value={m.id}>{m.id === s.me ? 'You' : m.name}</option>)}
          </select>
        </label>
        <i aria-hidden>→</i>
        <label className="m-field">
          <span>Who got it</span>
          <select value={to} onChange={e => setTo(e.target.value)}>
            {active.map(m => <option key={m.id} value={m.id}>{m.id === s.me ? 'You' : m.name}</option>)}
          </select>
        </label>
      </div>

      <div className="m-amount">
        <select aria-label="Currency" value={currency} onChange={e => setCurrency(e.target.value)}>
          {[...new Set([base, ...(s.group.trip ? [s.group.trip.localCurrency] : []), ...CURRENCIES])].map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span aria-hidden>{currencySymbol(currency)}</span>
        <input aria-label="Amount" inputMode="decimal" placeholder="0" value={amountText} onChange={e => setAmountText(e.target.value)} autoComplete="off" />
      </div>

      {currency !== base && (
        <div className="m-rate">
          <label>1 {currency} =<input inputMode="decimal" aria-label={`Exchange rate to ${base}`} value={rateText} onChange={e => setRateText(e.target.value.replace(',', '.'))} />{base}</label>
          {baseAmount > 0 && <small><b>≈ {fmtMoney(baseAmount, base)}</b></small>}
        </div>
      )}

      {owedHere > 0 && (
        <p className="m-note">
          {from === s.me ? 'You owe' : `${s.members.find(m => m.id === from)?.name} owes`} {to === s.me ? 'you' : payee?.name} {fmtMoney(owedHere, base)}.
          {baseAmount > 0 && baseAmount < owedHere && ` This leaves ${fmtMoney(owedHere - baseAmount, base)} still to pay.`}
          {baseAmount > owedHere && ` This is ${fmtMoney(baseAmount - owedHere, base)} more than that.`}
        </p>
      )}

      {payee && (
        <div className="m-pay-note">
          <Avatar id={payee.id} name={payee.name} size={28} ghost={!payee.joined} />
          {from === s.me && payee.payHandle
            ? <span>{payee.name}’s payment ID: <b className="m-mono">{payee.payHandle}</b></span>
            : <span>Pay however you like, then record it here.</span>}
          {upi && <a className="m-upi" href={upi} onClick={() => setMethod('upi')}>Open UPI app</a>}
        </div>
      )}

      <fieldset className="m-group">
        <legend>Paid with</legend>
        <div className="m-chips">
          {PAY_METHODS.map(x => <button key={x.id} type="button" aria-pressed={method === x.id} className={method === x.id ? 'on' : ''} onClick={() => setMethod(x.id)}>{x.label}</button>)}
        </div>
      </fieldset>

      <div className="m-two">
        <Field label="When"><input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} /></Field>
        <Field label="Note (optional)"><input value={note} maxLength={300} onChange={e => setNote(e.target.value)} placeholder="Paid back at the airport" /></Field>
      </div>
    </Modal>
  )
}
