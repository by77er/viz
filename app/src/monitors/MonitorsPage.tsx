import { useCallback, useEffect, useMemo, useState } from 'react'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { RequireKey } from '../shell/AppShell'
import { MonitorsListPage } from './MonitorsListPage'
import { MonitorPage } from './MonitorPage'
import { parseMonitorsSearch } from './model'

const route = getRouteApi('/monitors')

/**
 * `/monitors`: the list, or the monitor the address names with `id`. One document path for
 * both (the gateway serves only the exact paths of serve.json). A chunk of its own: the shell
 * has 24 kB of its 200 left (README, "Dashboards", Known risks), and opening a monitor from the
 * list is in the same chunk, so it costs no load.
 */
export function MonitorsPage() {
  const raw = route.useSearch()
  const search = useMemo(() => parseMonitorsSearch(raw as Record<string, unknown>), [raw])
  // The monitor pressed in the list is shown in the press's own task (M-B1), from the list's row, while the router changes the
  // address; the page is the same element once the address names it (one key), so nothing is asked or drawn twice.
  // The router's change of address runs in a task after the frame that shows the page: in the press's task it held that frame back
  // as long as before (measured here: 111 and 123 ms with it there).
  const navigate = useNavigate()
  const [opening, setOpening] = useState<string | null>(null)
  useEffect(() => setOpening(null), [raw])
  const open = useCallback(
    (id: string) => {
      setOpening(id)
      requestAnimationFrame(() => setTimeout(() => void navigate({ to: '/monitors', search: { id } }), 0))
    },
    [navigate],
  )
  const id = search.id ?? opening
  useEffect(() => {
    if (!id) document.title = 'Monitors · viz'
  }, [id])
  return <RequireKey>{id ? <MonitorPage key={id} id={id} search={search.id ? search : { id }} /> : <MonitorsListPage search={search} onOpen={open} />}</RequireKey>
}
