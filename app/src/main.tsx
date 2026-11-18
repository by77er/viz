import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './router'
import { CommandsProvider } from './shell/commands'
import { SettingsProvider } from './shell/settings'
import { ThemeProvider } from './shell/theme'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SettingsProvider>
          <CommandsProvider>
            <RouterProvider router={router} />
          </CommandsProvider>
        </SettingsProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
