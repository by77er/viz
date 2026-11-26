import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './router'
import { CommandsProvider } from './shell/commands'
import { SessionProvider } from './shell/session'
import { ThemeProvider } from './shell/theme'
// The design system first (tokens, components, fonts), then the app's own layout.
import '../../design-system/dist/viz.css'
import './app.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {/* Signing out drops everything that was fetched with the key. */}
        <SessionProvider onChange={() => queryClient.clear()}>
          <CommandsProvider>
            <RouterProvider router={router} />
          </CommandsProvider>
        </SessionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
