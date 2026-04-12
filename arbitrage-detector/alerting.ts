// Webhook alerting for circuit breaker triggers, execution errors, reconciliation divergence.
// Fire-and-forget — errors are logged but never re-thrown to the caller.

export type AlertSeverity = 'info' | 'warn' | 'critical'

export async function sendAlert(
  webhookUrl: string | undefined,
  event: string,
  severity: AlertSeverity,
  detail: Record<string, unknown>,
): Promise<void> {
  if (!webhookUrl) return
  const payload = { event, severity, detail, timestamp: new Date().toISOString() }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) console.error(`[alerting] webhook returned ${res.status}`)
  } catch (err: any) {
    console.error(`[alerting] webhook failed: ${err.message}`)
  }
}

// Convenience: build an alert function bound to a webhook URL.
export function makeAlerter(webhookUrl: string | undefined) {
  return (event: string, severity: AlertSeverity, detail: Record<string, unknown>) =>
    sendAlert(webhookUrl, event, severity, detail)
}
