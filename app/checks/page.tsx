import Link from "next/link";
import type { StoredCheck } from "../../lib/checks-state.ts";
import { getConfig } from "../../lib/config.ts";
import { readStore } from "../../lib/store.ts";
import { refreshChecksAction, simulateAction } from "../actions.ts";
import { ConfigBanner, Notice, first } from "../components.tsx";
import { SubmitButton } from "../SubmitButton.tsx";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "UTC" }) + " UTC" : "");

export default async function ChecksPage({ searchParams }: Props) {
  const params = await searchParams;
  const config = getConfig();
  const store = await readStore();
  const church = store.church;
  const highlight = first(params.check);
  const checks = Object.values(store.checks)
    .filter((c) => !church || c.clientId === church.clientId)
    .sort((a, b) => (b.lastChangeAt ?? "").localeCompare(a.lastChangeAt ?? ""));

  return (
    <>
      <h1>Checks</h1>
      <ConfigBanner />
      <Notice msg={first(params.msg)} err={first(params.err)} />

      <section className="card">
        <div className="actions">
          <form action={refreshChecksAction}>
            <SubmitButton>Refresh from API</SubmitButton>
          </form>
          <Link className="button secondary" href="/checks/new">
            Order a check
          </Link>
          <span className="small muted">
            {store.lastSync ? `Last refresh ${fmt(store.lastSync)}.` : "Not refreshed yet."} Webhooks keep this list
            current; the refresh catches anything missed.
          </span>
        </div>
      </section>

      <section className="card table-wrap">
        {checks.length === 0 ? (
          <p className="muted">No checks yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Applicant</th>
                <th>Level</th>
                <th>Status</th>
                <th>Details</th>
                <th>Updated</th>
                {config.isSandbox ? <th>Sandbox</th> : null}
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id} className={c.id === highlight ? "highlight" : undefined}>
                  <td>
                    {c.applicant ? `${c.applicant.firstName} ${c.applicant.lastName}` : <span className="muted">Ordered elsewhere</span>}
                    <div className="small muted">
                      <code>{c.externalIdentifier ?? c.id}</code>
                    </div>
                  </td>
                  <td>{c.level ?? ""}</td>
                  <td>
                    <span className={`badge ${c.status}`}>{c.status}</span>
                    <div className="small muted">{c.stage}</div>
                  </td>
                  <td className="small">
                    <CheckDetails check={c} portalUrl={church?.portalUrl ?? null} />
                  </td>
                  <td className="small">{fmt(c.lastChangeAt)}</td>
                  {config.isSandbox ? (
                    <td>
                      <form action={simulateAction} className="inline">
                        <input type="hidden" name="checkId" value={c.id} />
                        <select name="target" defaultValue="CLEAR" aria-label="Simulate status">
                          <option value="awaiting_applicant">CREATED: awaiting applicant</option>
                          <option value="applicant_ready">CREATED: applicant ready</option>
                          <option value="in_progress">CREATED: in progress</option>
                          <option value="CLEAR">CLEAR</option>
                          <option value="REVIEW">REVIEW</option>
                          <option value="ERROR">ERROR</option>
                          <option value="CANCELLED">CANCELLED</option>
                        </select>
                        <SubmitButton className="secondary">Simulate</SubmitButton>
                      </form>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function CheckDetails({ check, portalUrl }: { check: StoredCheck; portalUrl: string | null }) {
  const portal = (text: string) =>
    portalUrl ? (
      <a href={portalUrl} target="_blank" rel="noopener noreferrer">
        {text}
      </a>
    ) : (
      text
    );
  return (
    <>
      {check.stage === "applicant_ready" ? (
        <div className="action-needed">Action needed: review and release this check in the {portal("Datasource portal")}.</div>
      ) : null}
      {check.stage === "awaiting_applicant" ? <div>Waiting for the applicant to fill in the form.</div> : null}
      {check.stage === "in_progress" ? <div>Searches running.</div> : null}
      {check.status === "PENDING" ? <div>Submitting; resolves on its own within about an hour.</div> : null}
      {check.status === "ERROR" ? <div>{check.errorMessage ?? "Could not be completed."} You can order again.</div> : null}
      {check.reportUrl ? (
        <div>
          <a href={check.reportUrl} target="_blank" rel="noopener noreferrer">
            Report
          </a>{" "}
          (church sign-in)
        </div>
      ) : null}
      {check.expirationDate ? <div>Valid until {fmt(check.expirationDate)}</div> : null}
      {check.expiring ? <div className="action-needed">Expires in {check.expiring.daysLeft} days: re-screen soon.</div> : null}
    </>
  );
}
