import Link from "next/link";
import { getCbcClient } from "../lib/api.ts";
import { CbcApiError } from "../lib/cbc-client.ts";
import { getConfig } from "../lib/config.ts";
import { readStore } from "../lib/store.ts";
import type { Client } from "../lib/types.ts";
import { connectChurchAction, disconnectChurchAction } from "./actions.ts";
import { ConfigBanner, Notice, first } from "./components.tsx";
import { CreateChurchForm } from "./CreateChurchForm.tsx";
import { SubmitButton } from "./SubmitButton.tsx";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function HomePage({ searchParams }: Props) {
  const params = await searchParams;
  const config = getConfig();
  const { church } = await readStore();

  return (
    <>
      <h1>Your church</h1>
      <ConfigBanner />
      <Notice msg={first(params.msg)} err={first(params.err)} />
      {church ? <ConnectedChurch church={church} /> : config.hasApiKey ? <ChooseChurch /> : null}
      <section className="card small muted">
        This starter connects one church (a <em>client</em>) to the Christian Background Checks Partner API, orders
        checks for its volunteers and tracks them by webhook. Docs:{" "}
        <a href="https://partners.cbgc.io/docs">partners.cbgc.io/docs</a>. Human help:{" "}
        <a href="mailto:support@datasourcecorp.com">support@datasourcecorp.com</a>.
      </section>
    </>
  );
}

function ConnectedChurch({ church }: { church: NonNullable<Awaited<ReturnType<typeof readStore>>["church"]> }) {
  return (
    <section className="card">
      <h2>{church.name ?? "Connected church"}</h2>
      <p className="small muted">
        clientId <code>{church.clientId}</code>
        {church.externalClientId ? (
          <>
            {" "}
            · externalClientId <code>{church.externalClientId}</code>
          </>
        ) : null}
      </p>
      {church.portalUrl ? (
        <p>
          Staff review reports and release held orders in the{" "}
          <a href={church.portalUrl} target="_blank" rel="noopener noreferrer">
            church&apos;s Datasource portal
          </a>
          .
        </p>
      ) : null}
      <div className="actions">
        <Link className="button" href="/checks/new">
          Order a check
        </Link>
        <Link className="button secondary" href="/checks">
          View checks
        </Link>
        <form action={disconnectChurchAction}>
          <SubmitButton className="secondary">Disconnect (this app only)</SubmitButton>
        </form>
      </div>
    </section>
  );
}

async function ChooseChurch() {
  const api = getCbcClient();
  let clients: Client[] = [];
  let error: string | null = null;
  try {
    clients = (await api?.listClients()) ?? [];
  } catch (err) {
    error =
      err instanceof CbcApiError && err.status === 401
        ? "The API key was rejected (invalid_api_key). Check CBC_API_KEY and CBC_BASE_URL."
        : "Couldn't load your churches from the API.";
  }

  return (
    <div className="grid">
      <section className="card">
        <h2>Pick an existing church</h2>
        {error ? <div className="alert alert-bad">{error}</div> : null}
        {clients.length ? (
          <form action={connectChurchAction} className="stack">
            <label>
              Church <span className="hint">from GET /clients</span>
              <select name="clientId" required>
                {clients.map((c) => (
                  <option key={c.clientId} value={c.clientId}>
                    {c.name ?? c.clientId}
                    {c.externalClientId ? ` (${c.externalClientId})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="actions">
              <SubmitButton>Use this church</SubmitButton>
            </div>
          </form>
        ) : !error ? (
          <p className="muted">No churches under your account yet. Create one.</p>
        ) : null}
      </section>
      <section className="card">
        <h2>Create a church</h2>
        <p className="small muted">
          <code>POST /clients</code>. In production most churches connect through the hosted connect page instead (
          <code>POST /connect/sessions</code>); see the README.
        </p>
        <CreateChurchForm />
      </section>
    </div>
  );
}
