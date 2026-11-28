import { useEffect, useMemo } from 'react'
import { getRouteApi } from '@tanstack/react-router'
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
  useEffect(() => {
    if (!search.id) document.title = 'Monitors · viz'
  }, [search.id])
  return <RequireKey>{search.id ? <MonitorPage key={search.id} id={search.id} search={search} /> : <MonitorsListPage search={search} />}</RequireKey>
}
