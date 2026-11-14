import { getCbcClient } from "../../lib/api.ts";
import { getConfig } from "../../lib/config.ts";
import { readStore } from "../../lib/store.ts";
import type { Settings } from "../../lib/types.ts";
import { saveWebhookUrlAction, sendTestWebhookAction } from "../actions.ts";
import { ConfigBanner, Notice, first } from "../components.tsx";
import { SubmitButton } from "../SubmitButton.tsx";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SettingsPage({ searchParams }: Props) {
  const params = await searchParams;
  const config = getConfig();
  const api = getCbcClient();
  const { lastPingAt } = await readStore();

  let settings: Settings | null = null;
  let error: string | null = null;
  if (api) {
    try {
      settings = await api.getSettings();
    } catch {
      error = "Couldn't read your settings from the API (GET /settings). Check CBC_API_KEY and CBC_BASE_URL.";
    }
  }

  return (
    <>
      <h1>Webhooks</h1>
      <ConfigBanner />
      <Notice msg={first(params.msg)} err={first(params.err)} />
      {!config.hasWebhookSecret ? (
        <div className="alert alert-warn">
          <strong>Set CBC_WEBHOOK_SECRET</strong> (your <code>whsec_...</code> secret). Until then the webhook endpoint
          answers 503 and nothing is processed.
        </div>
      ) : null}
      {error ? <div className="alert alert-bad">{error}</div> : null}

      <section className="card">
        <p>
          This app receives webhooks at <code>/api/cbc/webhooks</code>. The API can only reach a public{" "}
          <code>https://</code> URL: run a tunnel (see the README) and register{" "}
          <code>https://YOUR-TUNNEL/api/cbc/webhooks</code> below.
        </p>
        <p className="small muted">
          Last ping received: {lastPingAt ? new Date(lastPingAt).toISOString() : "never"}.
        </p>
        {api && settings ? (
          <>
            <form action={saveWebhookUrlAction} className="stack">
              <label>
                Webhook URL <span className="hint">PUT /settings (empty turns webhooks off)</span>
                <input name="webhookUrl" type="url" defaultValue={settings.webhookUrl ?? ""} placeholder="https://example.trycloudflare.com/api/cbc/webhooks" />
              </label>
              <div className="actions">
                <SubmitButton>Save webhook URL</SubmitButton>
              </div>
            </form>
            <form action={sendTestWebhookAction} className="actions" style={{ marginTop: 12 }}>
              <SubmitButton className="secondary">Send test ping</SubmitButton>
              <span className="small muted">POST /settings/webhook-test</span>
            </form>
          </>
        ) : null}
      </section>
    </>
  );
}
