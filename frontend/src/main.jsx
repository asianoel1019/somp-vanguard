import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { ToastProvider } from './contexts/ToastContext.jsx'
import { ConfirmProvider } from './contexts/ConfirmContext.jsx'
import { WebSocketProvider } from './contexts/WebSocketContext.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <WebSocketProvider>
          <App />
        </WebSocketProvider>
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
)
