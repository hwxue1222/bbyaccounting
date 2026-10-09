import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

if (typeof window !== 'undefined' && window.location.hostname === 'bbyaccounting.com') {
  const next = `https://www.bbyaccounting.com${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.replace(next)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
