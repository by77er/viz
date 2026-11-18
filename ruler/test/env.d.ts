declare namespace Cloudflare {
  interface Env {
    RULER: DurableObjectNamespace<import('./harness').TestRuler>
    NOTIFIER: DurableObjectNamespace<import('./harness').TestNotifier>
  }
}
