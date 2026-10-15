import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@zachhub/tokens/tokens.css'
import { AuthProvider } from './auth/session'
import { loadFonts } from './lib/fonts'
import { router } from './router'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
)

requestAnimationFrame(loadFonts)
