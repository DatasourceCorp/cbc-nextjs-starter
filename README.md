# Christian Background Checks: Next.js starter

A small, working church app that adds volunteer background checks with the
**Christian Background Checks (CBC) Partner API**, by Datasource. Copy the parts you need into your
church management software, or use it to see the whole flow end to end in the sandbox.

- Next.js 16 (App Router), React 19, TypeScript. No UI framework, no database driver, no native modules.
- Three runtime dependencies: `next`, `react`, `react-dom`. Tests use Node's built-in test runner.
- MIT licensed.

## What it does

| Page | What happens |
|---|---|
| **Church** (`/`) | Pick one of your existing churches (`GET /clients`) or create one (`POST /clients` with your own `externalClientId`). |
| **Order a check** (`/checks/new`) | A form for the volunteer's name, email, level (from `GET /products`, shown with `feesNote`), job location and state of employment. Sends `POST /clients/{clientRef}/checks` with an `externalIdentifier` it generates and reuses on every retry. |
| **Checks** (`/checks`) | Every check with its status and stage, from local storage. **Refresh from API** pulls changes with `GET /clients/{clientRef}/checks?updated_since=...`, following `nextCursor`. In the sandbox, a **Simulate** button per check calls `POST /test/checks/{checkRef}/simulate`. |
| **Webhooks** (`/settings`) | Registers your webhook URL (`PUT /settings`) and sends a test `ping` (`POST /settings/webhook-test`). |
| `POST /api/cbc/webhooks` | Receives webhooks: verifies `X-Partner-Signature` over the raw body, drops repeated `eventId`s, keeps the latest `timestamp` per check, handles `check.updated`, `check.expiring` and `ping`. |

The applicant never enters an SSN or date of birth in your app: CBC emails them a secure form to
give their details and consent.

## Quick start (under 5 minutes)

You need Node.js 22.18 or newer and a sandbox key (`pk_test_...`, self-serve at
<https://join.cbgc.io/sandbox/>). Nothing is billed in the sandbox.

```bash
npm install
cp .env.example .env.local      # then paste CBC_API_KEY and CBC_WEBHOOK_SECRET
npm run dev                      # http://localhost:3000
```

1. **Church**: pick or create a church.
2. **Order a check**: fill in a volunteer (any name and an email you can read).
3. **Checks**: press **Simulate** to move it to `CREATED: applicant ready`, `CLEAR`, `REVIEW` or `ERROR`.
   Press **Refresh from API** to pull the latest state, or set up webhooks (below) to see it arrive live.

Without `CBC_API_KEY`, every page shows a "Set CBC_API_KEY" message and nothing is sent.

| Setting | Default | Meaning |
|---|---|---|
| `CBC_BASE_URL` | `https://dev.partners.cbgc.io` | Sandbox. Production is `https://partners.cbgc.io`. |
| `CBC_API_KEY` | (none) | `pk_test_...` for the sandbox, `pk_live_...` for production. Server-side only. |
| `CBC_WEBHOOK_SECRET` | (none) | Your `whsec_...` signing secret. The webhook endpoint answers 503 until it's set. |
| `CBC_STORE_PATH` | `.data/cbc-store.json` | The local JSON store. |

### Offline, with the fake API

`test/fake-api.ts` is a tiny in-memory imitation of the API used by the tests. You can run the app
against it with no key at all:

```bash
npm run fake-api                 # http://127.0.0.1:4010, key pk_test_fake, secret whsec_fake
CBC_BASE_URL=http://127.0.0.1:4010 CBC_API_KEY=pk_test_fake CBC_WEBHOOK_SECRET=whsec_fake npm run dev
```

On the **Webhooks** page, save `http://127.0.0.1:3000/api/cbc/webhooks` (the fake accepts `http://`;
the real API requires `https://`). The fake is not the real API: always finish in the sandbox.

## Project layout

```
app/
  page.tsx                 Church: pick (GET /clients) or create (POST /clients)
  CreateChurchForm.tsx     Client component for the create form
  checks/page.tsx          Checks list, Refresh from API, Simulate (sandbox)
  checks/new/page.tsx      Loads levels (GET /products), makes a new externalIdentifier
  checks/new/OrderForm.tsx The order form (keeps the same externalIdentifier on retry)
  settings/page.tsx        Webhook URL (PUT /settings) and test ping
  actions.ts               Every Server Action (all mutations go through here)
  api/cbc/webhooks/route.ts The webhook endpoint
lib/
  cbc-client.ts            Dependency-free API client; maps every order outcome
  orders.ts                Order validation and outcome messages
  sync.ts                  Refresh from API (updated_since + nextCursor)
  webhook.ts               Webhook request handling: raw body, signature, 401/400/2xx
  signature.ts             X-Partner-Signature verification (HMAC-SHA256, constant time)
  checks-state.ts          Pure state logic: dedupe by eventId, latest timestamp wins
  store.ts                 Local JSON file store: REPLACE WITH YOUR DATABASE
  config.ts                Reads CBC_BASE_URL, CBC_API_KEY, CBC_WEBHOOK_SECRET
test/
  signature.test.ts        Valid passes; tampered body, wrong secret, missing header fail
  webhook-handler.test.ts  Dedupe, out-of-order delivery, expiring, ping, unknown events
  cbc-client.test.ts       Request shape and every order outcome, against a fake HTTP server
  e2e.test.ts              Order -> simulate -> signed webhook -> store, over real HTTP
  fake-api.ts              The fake API
```

## How each API concept maps to code

| API concept | Where | Notes |
|---|---|---|
| `X-Api-Key` header | `lib/cbc-client.ts` `send()` | Only server code imports the client. The key is never in a `NEXT_PUBLIC_` variable. |
| Church = client, `{clientRef}` | `app/actions.ts` `createChurchAction`, `connectChurchAction` | Stored as `church.clientId`; `externalClientId` is your id. `409 external_client_id_in_use` connects the existing church. |
| Levels and prices | `GET /products` in `app/checks/new/page.tsx` | Prices are shown with `feesNote`. `GET /clients/{clientRef}/products` gives one church's own levels and prices. |
| `externalIdentifier` | `lib/orders.ts` `newExternalIdentifier()`, hidden field in `OrderForm.tsx` | Made once per form. Resubmitting after any error sends the same id, so a retry can't order twice. |
| Ordering outcomes | `lib/cbc-client.ts` `interpretOrderResponse()` | `201` created; `409 duplicate_check` shows the existing check from `order`; `502` whose body is the check (`PENDING`, no `code`) is shown as "resolves within about an hour"; `400` field errors go next to their fields; `422 level_not_available`; `502 upstream_unavailable` and `500` are retried with the same id. `forceReorder` is never sent. |
| `jobLocation`, `stateOfEmployment` | `OrderForm.tsx`, `validateOrderInput()` | Required in the form: ask the church where the person serves. Never guess them from the church's address. |
| `status` and `stage` | `app/checks/page.tsx` | `applicant_ready` is shown as **Action needed** with a link to the church's `portalUrl`. Unknown values are shown as they come. |
| Reconciliation | `lib/sync.ts` | `updated_since` = start time of the last refresh; follows `nextCursor`; upserts by `id`, keeping the newer `updatedAt`. |
| Webhook signature | `lib/signature.ts` | Lowercase hex HMAC-SHA256 of the raw body, keyed with the whole `whsec_` secret, compared with `timingSafeEqual`. |
| At-least-once, unordered delivery | `lib/checks-state.ts` `applyWebhookEvent()` | Drops a seen `eventId`; per check `id` keeps the latest `timestamp`; refuses events over a day old. |
| Sandbox simulate | `app/actions.ts` `simulateAction` | Shown and allowed only when `CBC_BASE_URL` isn't production. |
| Errors | `CbcApiError` | Branches on HTTP status, then `code`; never on `title` or `detail`. |

## Receiving webhooks locally

The API only delivers to a public `https://` URL. Start a tunnel to your dev server:

```bash
# Cloudflare (no account needed for a quick tunnel)
cloudflared tunnel --url http://localhost:3000
# or ngrok
ngrok http 3000
```

Copy the `https://...` address it prints, then register it. Either use the app's **Webhooks** page,
or call the API yourself:

```bash
# PUT /settings replaces both URL values: include your connectReturnUrls if you have any.
curl -X PUT https://dev.partners.cbgc.io/settings \
  -H "X-Api-Key: $CBC_API_KEY" -H "Content-Type: application/json" \
  -d '{"webhookUrl":"https://YOUR-TUNNEL.trycloudflare.com/api/cbc/webhooks","connectReturnUrls":[]}'

# Send a signed ping
curl -X POST https://dev.partners.cbgc.io/settings/webhook-test -H "X-Api-Key: $CBC_API_KEY"
```

The terminal running `npm run dev` logs `[cbc] webhook ping ... -> ping`, and the Webhooks page
shows the time of the last ping. Then press **Simulate** on a check and watch `check.updated` arrive.
A `401` in the log means `CBC_WEBHOOK_SECRET` doesn't match your account's secret.
`GET /settings/webhook-deliveries` lists every delivery attempt of the last 30 days.

## Security

- The API key and webhook secret are read on the server only (`lib/config.ts`). No secret is sent to
  the browser.
- Forms post to Server Actions. Next.js rejects a Server Action whose `Origin` doesn't match the
  host, which protects them from cross-site request forgery. Keep every mutation in a Server Action
  (or check `Origin` yourself in a route handler).
- The webhook endpoint is the one unauthenticated POST: it is protected by its signature instead.
- Logs carry ids and statuses only, never applicant names or emails.
- The local store holds applicant names and emails. Treat your real database the same way.

## Going live checklist

- [ ] Your integration works end to end in the sandbox (the guide's [test plan](https://partners.cbgc.io/docs/guide.md#11-testing-in-the-sandbox)).
- [ ] Live key (`pk_live_...`) and webhook secret from Datasource, stored in a secret manager.
- [ ] `CBC_BASE_URL=https://partners.cbgc.io`.
- [ ] A real database replaces `lib/store.ts`, with a unique index on the webhook `eventId` and checks keyed by `id`.
- [ ] Your webhook URL is public `https://`, answers within 15 seconds, and is registered on production with `PUT /settings`; then `POST /settings/webhook-test`.
- [ ] A nightly reconciliation (`lib/sync.ts`) runs for every connected church.
- [ ] Churches connect through the hosted connect page (`POST /connect/sessions`) or `POST /clients`, and you confirm connections with `client.connected` or `GET /connect/sessions/{sessionId}`.
- [ ] Remove or hide the Simulate button (it is already hidden when `CBC_BASE_URL` is production).

## Using an AI coding assistant

Give your assistant the whole API in one file: <https://partners.cbgc.io/llms-full.txt>.

For Claude Code, add the CBC MCP server:

```bash
claude mcp add --transport http christian-background-checks https://partners.cbgc.io/mcp
```

The production server has the documentation tools only. `https://dev.partners.cbgc.io/mcp` adds
sandbox tools; send your `pk_test_` key in the `X-Api-Key` header.

Check what an assistant writes for you:

- **Signature check**: verifies `X-Partner-Signature` over the raw bytes before parsing, with the
  whole `whsec_` secret and a constant-time compare, and answers `401` when it fails.
- **Idempotency**: every order sends an `externalIdentifier` and every retry reuses it; webhooks are
  deduplicated by `eventId`; `forceReorder` is never sent after a `502`.
- **No keys client-side**: no API key in browser code, `NEXT_PUBLIC_` variables, URLs or logs.
- It branches on HTTP status and `code`, ignores unknown fields, events and enum values, and never
  fills in `jobLocation` or `stateOfEmployment` from the church's address.

## Resources

- Docs: <https://partners.cbgc.io/docs>
- OpenAPI: <https://partners.cbgc.io/openapi/v1.json>
- Error catalog: <https://partners.cbgc.io/docs/errors.md>
- Postman: <https://documenter.getpostman.com/view/60196321/2sBYHaQHM3>
- Sandbox keys: <https://join.cbgc.io/sandbox/>

## Support

Real people help: <support@datasourcecorp.com>.

## License

MIT, copyright Datasource Corp. See [LICENSE](LICENSE).
