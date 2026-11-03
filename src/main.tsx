import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'
import './deck.css'
import './panels.css'
import './dashboard.css'
import './money.css'
import './trip.css'
import './social.css'
import './mobile.css'
import './theme.css'
import './memphis.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
