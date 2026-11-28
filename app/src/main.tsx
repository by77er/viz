import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { installScrollKeeper } from './lib/scrollKeeper'
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

// Before the app draws: a reload is put back where the page was scrolled to, in the frame its layout is drawn.
installScrollKeeper()

// The first number format a document makes costs about 50 ms at 4x CPU (the browser loads its number data), and the first is
// otherwise made by the first chart drawn: profiled as most of a monitor's chart paint and of a dashboard's first chart (the third
// design review, M-B1 and D-B2). Made here when the page is first idle instead, before any answer can arrive. It draws nothing.
const warmNumbers = () => void new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(1.5)
if ('requestIdleCallback' in window) requestIdleCallback(warmNumbers, { timeout: 1000 })
else setTimeout(warmNumbers, 0)

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
