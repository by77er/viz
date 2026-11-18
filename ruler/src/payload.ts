/** Notification bodies: Alertmanager's webhook JSON (version "4") and a Slack incoming-webhook message. */
import type { WebhookPayload } from '../contracts-proposal/rules'
import { rfc3339, type Labels } from './util'

export interface PayloadAlert {
  fingerprint: string
  labels: Labels
  annotations: Labels
  status: 'firing' | 'resolved'
  startsAt: number
  endsAt: number | null
}

export interface PayloadGroup {
  groupKey: string
  receiver: string
  groupLabels: Labels
  externalUrl: string
}

const ZERO_TIME = '0001-01-01T00:00:00Z'

function common(maps: Labels[]): Labels {
  const first = maps[0]
  if (!first) return {}
  const out: Labels = {}
  for (const [k, v] of Object.entries(first)) if (maps.every((m) => m[k] === v)) out[k] = v
  return out
}

/** Firing alerts first, then resolved; each part ordered by fingerprint so the body is deterministic. */
function ordered(alerts: PayloadAlert[]): PayloadAlert[] {
  return [...alerts].sort((a, b) => (a.status === b.status ? (a.fingerprint < b.fingerprint ? -1 : 1) : a.status === 'firing' ? -1 : 1))
}

export function webhookPayload(g: PayloadGroup, alerts: PayloadAlert[], maxAlerts = 0): WebhookPayload {
  const all = ordered(alerts)
  const shown = maxAlerts > 0 ? all.slice(0, maxAlerts) : all
  return {
    version: '4',
    groupKey: g.groupKey,
    truncatedAlerts: all.length - shown.length,
    status: all.some((a) => a.status === 'firing') ? 'firing' : 'resolved',
    receiver: g.receiver,
    groupLabels: g.groupLabels,
    commonLabels: common(shown.map((a) => a.labels)),
    commonAnnotations: common(shown.map((a) => a.annotations)),
    externalURL: g.externalUrl,
    alerts: shown.map((a) => ({
      status: a.status,
      labels: a.labels,
      annotations: a.annotations,
      startsAt: rfc3339(a.startsAt),
      endsAt: a.endsAt === null ? ZERO_TIME : rfc3339(a.endsAt),
      generatorURL: '',
      fingerprint: a.fingerprint,
    })),
  }
}

export interface SlackMessage {
  channel?: string
  username: string
  text: string
  attachments: { color: string; title: string; title_link?: string; text: string; fallback: string; footer: string; ts: number }[]
}

/** A message any Slack-compatible incoming webhook accepts, shaped like Alertmanager's default Slack template. */
export function slackPayload(g: PayloadGroup, alerts: PayloadAlert[], channel: string | null, atMs: number): SlackMessage {
  const all = ordered(alerts)
  const firing = all.filter((a) => a.status === 'firing')
  const status = firing.length > 0 ? 'firing' : 'resolved'
  const labels = common(all.map((a) => a.labels))
  const name = labels.alertname ?? g.groupLabels.alertname ?? 'alerts'
  const rest = Object.entries(g.groupLabels).filter(([k]) => k !== 'alertname').map(([k, v]) => `${k}=${v}`).join(' ')
  const title = `[${status.toUpperCase()}${status === 'firing' ? `:${firing.length}` : ''}] ${name}${rest ? ` (${rest})` : ''}`
  const line = (a: PayloadAlert) => {
    const what = a.annotations.summary ?? a.annotations.description ?? Object.entries(a.labels).filter(([k]) => !(k in labels)).map(([k, v]) => `${k}=${v}`).join(' ')
    return `${a.status === 'firing' ? '•' : '✓'} ${what || name}`
  }
  const lines = all.slice(0, 20).map(line)
  if (all.length > 20) lines.push(`… and ${all.length - 20} more`)
  const msg: SlackMessage = {
    username: 'viz',
    text: title,
    attachments: [
      {
        color: status === 'firing' ? 'danger' : 'good',
        title,
        text: lines.join('\n'),
        fallback: title,
        footer: g.receiver,
        ts: Math.floor(atMs / 1000),
      },
    ],
  }
  if (g.externalUrl) (msg.attachments[0] as { title_link?: string }).title_link = g.externalUrl
  if (channel) msg.channel = channel
  return msg
}
