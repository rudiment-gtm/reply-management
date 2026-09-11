# Reply Management

Lets clients reply to cold outbound (EmailBison) directly from HubSpot's native Conversations inbox — the reply is typed in HubSpot, but actually sent through the client's own EmailBison workspace, so threading and sending domain stay intact. Multitenant: each client gets their own HubSpot install and their own EmailBison credentials.

Built as the productized follow-on to a single-tenant prototype validated in `M5-Services` (Encore's internal repo) — the mechanism (HubSpot Custom Channels ↔ EmailBison reply API) is proven; this repo makes it sellable to more than one client.

## Architecture

- **One shared HubSpot app + one shared custom channel** for every client. This is deliberate, not a shortcut: HubSpot's "private" app distribution just means the app isn't listed on the Marketplace — any portal can still install it via a normal OAuth link. So the app (Client ID/Secret) and the registered channel (Channel ID) are Rudiment-level constants, reused across every client. What's per-client is the *channel account* created during onboarding.
- **`clients`** — one row per client (name, slug). The slug is embedded in that client's EmailBison webhook URL, since EmailBison has no way to pass a custom identifier through its own webhook payload.
- **`hubspot_installs`** — one row per client: their portal ID, OAuth access/refresh tokens, and (once onboarding finishes) their channel account ID and inbox ID.
- **`emailbison_credentials`** — one row per client: their own EmailBison API key and base URL (each client may run their own EmailBison instance, not just a different key on Rudiment's).

### The two live webhooks

- **`hubspot-custom-channel-webhook`** — HubSpot calls this when a rep sends a reply from their Inbox. Resolves the client from the portal ID in the event, looks up that client's EmailBison credentials, and relays the send via `POST /replies/{id}/reply`.
- **`emailbison-reply-webhook`** — each client's own EmailBison account calls this (registered per-client, with `?client=<slug>` in the URL) when a real reply arrives. Pushes it into that client's HubSpot channel account as a message.

Both directions tag/read the HubSpot thread via `integrationThreadId = eb-reply-{emailBisonReplyId}` — minted when the inbound message is created, echoed back by HubSpot when a rep replies to it.

### Known gaps (carried over from the prototype, not yet hardened)

- Several field names (which field in an EmailBison webhook payload holds the reply ID; which fields on a full reply object hold the lead's email/name/message text; which field on a HubSpot outgoing-message event holds the portal ID) are best-guess, tried defensively against multiple candidates. Each handler returns the raw payload/object on a lookup failure specifically so a live test is self-diagnosing — check Supabase function logs after the first real event from any new client.
- No signature verification on the EmailBison side (their webhook docs don't document one) — the `?client=` slug is a weak identifier, not an auth boundary.

## Required secrets (Supabase → Edge Functions → Secrets)

| Secret | Value |
|---|---|
| `HUBSPOT_APP_CLIENT_ID` | Same app as the prototype (App ID 52264375) — from HubSpot's Auth tab |
| `HUBSPOT_APP_CLIENT_SECRET` | Same app — from HubSpot's Auth tab |
| `HUBSPOT_CHANNEL_ID` | `3519390` — the already-registered channel, reused for every client |
| `HUBSPOT_OAUTH_REDIRECT_URI` | This project's own `hubspot-oauth-callback` URL — **must also be added to the app's `redirectUrls` in HubSpot** (Development → Inbox Reply App → app-hsmeta.json → `hs project upload`), since it's a different Supabase project than the prototype |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are provided automatically by Supabase — no need to set them.

Per-client credentials (EmailBison API key/base URL, HubSpot OAuth tokens) are **not** secrets — they're rows in `emailbison_credentials` / `hubspot_installs`, created by the onboarding flow below.

## Onboarding a new client

Three calls to `onboard-client`, in order:

1. `GET /onboard-client?action=create&name=<Name>&slug=<slug>&emailbisonApiKey=<key>&emailbisonBaseUrl=<url>`
   Creates the client + stores their EmailBison credentials. Returns an `installUrl` — send this to whoever administers the client's HubSpot portal (or open it yourself if you have access) to authorize the app.

2. `GET /onboard-client?action=list-inboxes&client=<clientId>`
   Once the OAuth install (step 1's link) completes, lists that portal's Conversations inboxes.

3. `GET /onboard-client?action=connect&client=<clientId>&inboxId=<id>&deliveryIdentifier=<email>`
   Creates the channel account. Response includes the exact webhook URL to register in that client's EmailBison account (Settings → Webhooks → `reply_received` event) — that's the last step, done in EmailBison itself, not here.

## Deploying

This repo is structured for CLI-based deploys (multiple files with shared imports — the dashboard's single-file paste editor, which the prototype used, doesn't handle that well):

```
npm i -g supabase
supabase login --token <your sbp_... access token>
supabase link --project-ref dnucrisnkcrzalxlskuq
supabase db push
supabase functions deploy
```
