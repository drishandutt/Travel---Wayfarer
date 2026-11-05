import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Account, Debt, GroupState, Member } from '../../money/types'
import type { GroupHandle } from '../../money/hooks'
import { fmtMoney } from '../../money/currency'
import { hueOf, initialOf, nameOf } from '../../money/util'
import type { ExpensePrefill } from './ExpenseForm'

// Shared by every screen inside a group.
export interface GroupCtx {
  s: GroupState
  g: GroupHandle
  fmt: (minor: number) => string
  name: (id: string | null | undefined) => string
  me: Member
  online: boolean
  addExpense: (prefill?: ExpensePrefill) => void
  openExpense: (id: string) => void
  editExpense: (id: string) => void
  settle: (debt?: Debt) => void
  toast: (text: string) => void
  goTo: (tab: Tab) => void
}

export type Tab = 'overview' | 'expenses' | 'balances' | 'spending' | 'activity' | 'people'

export const Ctx = createContext<GroupCtx | null>(null)
export const useCtx = () => useContext(Ctx)!

export interface AccountCtxValue { account: Account; signedIn: (a: Account) => void; signOut: () => Promise<void> }
export const AccountCtx = createContext<AccountCtxValue | null>(null)
export const useAccountCtx = () => useContext(AccountCtx)!

export const buildCtxHelpers = (s: GroupState) => ({
  fmt: (minor: number) => fmtMoney(minor, s.group.currency),
  name: (id: string | null | undefined) => nameOf(s.members, id, s.me),
})

// Escape closes only the topmost thing open, and doesn't reach the dashboard underneath.
const escapeStack: { current: () => void }[] = []
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !escapeStack.length) return
    e.stopImmediatePropagation()
    escapeStack[escapeStack.length - 1].current()
  }, true)
}

export function useEscape(fn: () => void) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    escapeStack.push(ref)
    return () => { escapeStack.splice(escapeStack.indexOf(ref), 1) }
  }, [])
}

export function Modal({ title, eyebrow, onClose, children, footer, wide }: { title: string; eyebrow?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(onClose)
  // on the body, so a dialog opened from an animated panel (the deck) isn't trapped under the top bar
  return createPortal(
    <div className="m-modal-wrap" role="dialog" aria-modal="true" aria-label={title}>
      <div className="m-scrim" />
      <div className={`m-modal ${wide ? 'wide' : ''}`}>
        <header className="m-modal-head">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
          </div>
          <button className="m-x" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <div className="m-modal-body">{children}</div>
        {footer && <footer className="m-modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

export function Avatar({ id, name, size = 34, ghost }: { id: string; name: string; size?: number; ghost?: boolean }) {
  return (
    <span className={`m-avatar ${ghost ? 'waiting' : ''}`} aria-hidden style={{ width: size, height: size, fontSize: size * 0.42, ['--h' as string]: hueOf(id) }}>
      {initialOf(name)}
    </span>
  )
}

export const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <label className="m-field">
    <span>{label}</span>
    {children}
    {hint && <small>{hint}</small>}
  </label>
)

export const Empty = ({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) => (
  <div className="m-empty">
    <span aria-hidden>{icon}</span>
    <b>{title}</b>
    {children && <p>{children}</p>}
  </div>
)

export function Toggle({ on, onChange, label, hint, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`m-toggle ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <i />
      <span><b>{label}</b>{hint && <small>{hint}</small>}</span>
    </button>
  )
}

// A debt drawn the way the map draws a hop: a line from one person to the other.
export function DebtRoute({ debt, actions }: { debt: Debt; actions?: ReactNode }) {
  const { s, fmt, name } = useCtx()
  const from = s.members.find(m => m.id === debt.from)
  const to = s.members.find(m => m.id === debt.to)
  const mine = debt.from === s.me ? 'out' : debt.to === s.me ? 'in' : ''
  return (
    <div className={`m-debt ${mine}`}>
      <div className="m-debt-route">
        <Avatar id={debt.from} name={from?.name ?? '?'} ghost={!from?.joined} />
        <div className="m-debt-arc">
          <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden>
            <path d="M2 21 C 30 2, 70 2, 98 21" vectorEffect="non-scaling-stroke" />
          </svg>
          <i className="m-debt-head" />
          <b>{fmt(debt.amount)}</b>
        </div>
        <Avatar id={debt.to} name={to?.name ?? '?'} ghost={!to?.joined} />
      </div>
      <p className="m-debt-words">
        {debt.from === s.me ? <>You pay <b>{name(debt.to)}</b></> : debt.to === s.me ? <><b>{name(debt.from)}</b> pays you</> : <><b>{name(debt.from)}</b> pays <b>{name(debt.to)}</b></>}
      </p>
      {actions && <div className="m-debt-actions">{actions}</div>}
    </div>
  )
}
