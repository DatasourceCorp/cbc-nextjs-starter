import Link from "next/link";
import { getCbcClient } from "../../../lib/api.ts";
import { CbcApiError } from "../../../lib/cbc-client.ts";
import { newExternalIdentifier } from "../../../lib/orders.ts";
import { readStore } from "../../../lib/store.ts";
import type { Product } from "../../../lib/types.ts";
import { ConfigBanner } from "../../components.tsx";
import { OrderForm } from "./OrderForm.tsx";

export const dynamic = "force-dynamic";

export default async function NewCheckPage() {
  const api = getCbcClient();
  const { church } = await readStore();

  let products: Product[] = [];
  let error: string | null = null;
  if (api && church) {
    try {
      products = await api.listProducts(); // GET /products
    } catch (err) {
      error =
        err instanceof CbcApiError && err.status === 401
          ? "The API key was rejected (invalid_api_key). Check CBC_API_KEY and CBC_BASE_URL."
          : "Couldn't load the levels from the API. Reload to try again.";
    }
  }

  return (
    <>
      <h1>Order a background check</h1>
      <ConfigBanner />
      {api && !church ? (
        <div className="alert alert-warn">
          <Link href="/">Connect a church</Link> first.
        </div>
      ) : null}
      {error ? <div className="alert alert-bad">{error}</div> : null}
      {api && church && !error ? (
        <section className="card">
          <p className="muted small">
            For <strong>{church.name ?? church.clientId}</strong>. We never see the applicant&apos;s SSN or date of
            birth: Christian Background Checks emails them a secure form.
          </p>
          {/* A new order id per page load; the form reuses it on every retry. */}
          <OrderForm products={products} externalIdentifier={newExternalIdentifier()} />
        </section>
      ) : null}
    </>
  );
}
