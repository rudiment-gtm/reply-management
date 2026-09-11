// Receives HubSpot Custom Channels webhook events for the shared "Reply
// Management" channel (one HubSpot app/channel serving every client).
// Handles OUTGOING_CHANNEL_MESSAGE_CREATED — a rep replying inside
// HubSpot's native Conversations inbox — by resolving which client this
// event belongs to (via the portal ID HubSpot includes in the payload) and
// relaying the message out through that client's own EmailBison workspace.
//
// Threading: messages pushed INTO HubSpot use the INTEGRATION_THREAD_ID
// model with integrationThreadId formatted as `eb-reply-{emailBisonReplyId}`
// (minted by emailbison-reply-webhook). HubSpot echoes that ID back here.
//
// Payload shape confirmed against a real event (a real reply sent from
// HubSpot's Inbox) — no more field-name guessing:
//   type                           -- top-level, "OUTGOING_CHANNEL_MESSAGE_CREATED"
//   portalId                       -- top-level, string (e.g. "243842089")
//   channelIntegrationThreadIds    -- top-level array (-> eb-reply-{id} thread tag)
//   message.text                   -- NESTED under `message` (this was the actual
//                                      bug: event.message is the whole message
//                                      object, not the text string — the text is
//                                      one level deeper)
import { verifyHubSpotSignature } from "../_shared/hubspotSignature.ts";
import { getInstallByPortalId } from "../_shared/hubspot.ts";
import { getCredentials, sendReply } from "../_shared/emailbison.ts";

const THREAD_ID_PREFIX = "eb-reply-";
// Hardcoded rather than derived from req.url: Supabase's edge runtime
// misreports the request's own URL, AND HubSpot's v3 signature source
// string requires the FULL absolute URL (scheme + host + path) matching
// exactly the webhook's registered Target URL — confirmed against
// HubSpot's own official SDK usage and community examples.
const PUBLIC_REQUEST_URI = "https://dnucrisnkcrzalxlskuq.supabase.co/functions/v1/hubspot-custom-channel-webhook";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawBody = await req.text();

  let verified: boolean;
  try {
    verified = await verifyHubSpotSignature(req, rawBody, PUBLIC_REQUEST_URI);
  } catch (e) {
    console.error("[hubspot-custom-channel-webhook] signature check error:", e instanceof Error ? e.message : e);
    return new Response("Signature verification not configured", { status: 500 });
  }
  if (!verified) {
    console.error("[hubspot-custom-channel-webhook] signature verification failed — check HUBSPOT_APP_CLIENT_SECRET matches the app's current Auth-tab value");
    return new Response("Invalid signature", { status: 401 });
  }

  let events: unknown;
  try {
    events = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const list = Array.isArray(events) ? events : [events];

  for (const event of list) {
    await handleEvent(event as Record<string, unknown>);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

async function handleEvent(event: Record<string, unknown>) {
  if (event.type !== "OUTGOING_CHANNEL_MESSAGE_CREATED") {
    console.log("[hubspot-custom-channel-webhook] ignoring event type:", event.type);
    return;
  }

  const portalId = event.portalId as string | number | undefined;
  if (!portalId) {
    console.error("[hubspot-custom-channel-webhook] no portalId on event:", JSON.stringify(event));
    return;
  }

  const install = await getInstallByPortalId(Number(portalId));
  if (!install) {
    console.error(`[hubspot-custom-channel-webhook] no client found for portal ${portalId}`);
    return;
  }

  const threadIds = event.channelIntegrationThreadIds as string[] | undefined;
  const threadId = threadIds?.find((id) => id.startsWith(THREAD_ID_PREFIX));
  if (!threadId) {
    console.error("[hubspot-custom-channel-webhook] no recognized integrationThreadId on event:", JSON.stringify(event));
    return;
  }

  const replyId = threadId.slice(THREAD_ID_PREFIX.length);
  const message = (event.message as Record<string, unknown> | undefined)?.text as string | undefined;
  if (!message?.trim()) {
    console.error("[hubspot-custom-channel-webhook] event missing message.text:", JSON.stringify(event));
    return;
  }

  try {
    const creds = await getCredentials(install.client_id);
    await sendReply(creds, { replyId, message });
  } catch (e) {
    console.error(`[hubspot-custom-channel-webhook] sendReply failed for client ${install.client_id}:`, e instanceof Error ? e.message : e);
  }
}
