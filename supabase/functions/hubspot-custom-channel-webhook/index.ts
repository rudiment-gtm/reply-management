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
// CAUTION — two guesses, both self-correcting via the logged raw event on
// a lookup failure: (1) which field carries the portal/hub ID (tries
// several candidates — confirmed field name pending a real multi-portal
// test), and (2) the message-text/thread-ID field names, carried over
// from the single-tenant prototype build where they were already
// confirmed against one real HubSpot Custom Channels payload.
import { verifyHubSpotSignature } from "../_shared/hubspotSignature.ts";
import { getInstallByPortalId } from "../_shared/hubspot.ts";
import { getCredentials, sendReply } from "../_shared/emailbison.ts";

const THREAD_ID_PREFIX = "eb-reply-";
// Hardcoded rather than derived from req.url — see hubspotSignature.ts:
// Supabase's edge runtime misreports the request's own URL, AND HubSpot's
// v3 signature source string requires the FULL absolute URL (scheme +
// host + path) matching exactly the webhook's registered Target URL —
// confirmed against HubSpot's own official SDK usage and community
// examples, not just the path (an earlier fix attempt only handled the
// path/prefix issue and still failed the actual signature comparison).
const PUBLIC_REQUEST_URI = "https://dnucrisnkcrzalxlskuq.supabase.co/functions/v1/hubspot-custom-channel-webhook";

function firstDefined(obj: Record<string, unknown>, paths: string[]): unknown {
  for (const path of paths) {
    const value = path.split(".").reduce<unknown>((acc, key) => {
      if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
      return undefined;
    }, obj);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

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
  const type = event.subscriptionType ?? event.type;
  if (type !== "OUTGOING_CHANNEL_MESSAGE_CREATED") {
    console.log("[hubspot-custom-channel-webhook] ignoring event type:", type, event);
    return;
  }

  const portalId = firstDefined(event, ["portalId", "hubId", "hub_id", "portal_id"]) as number | undefined;
  if (!portalId) {
    console.error("[hubspot-custom-channel-webhook] no portal/hub ID found on event:", event);
    return;
  }

  const install = await getInstallByPortalId(Number(portalId));
  if (!install) {
    console.error(`[hubspot-custom-channel-webhook] no client found for portal ${portalId}`, event);
    return;
  }

  const threadIds = (event.channelIntegrationThreadIds ?? event.integrationThreadIds) as string[] | undefined;
  const threadId = threadIds?.find((id) => id.startsWith(THREAD_ID_PREFIX));
  if (!threadId) {
    console.error("[hubspot-custom-channel-webhook] no recognized integrationThreadId on event:", event);
    return;
  }

  const replyId = threadId.slice(THREAD_ID_PREFIX.length);
  const candidate = event.text ?? event.message ?? event.richText;
  const message = typeof candidate === "string" ? candidate : undefined;
  if (!message?.trim()) {
    // Log the full raw event here specifically — this is the one field
    // whose real name on OUTGOING_CHANNEL_MESSAGE_CREATED is still
    // unconfirmed (text/message/richText were all guesses; richText
    // turned out to be present but non-string, which crashed .trim()
    // before this guard was added — check the raw event below for its
    // actual shape).
    console.error("[hubspot-custom-channel-webhook] event missing a usable string message body:", JSON.stringify(event));
    return;
  }

  try {
    const creds = await getCredentials(install.client_id);
    await sendReply(creds, { replyId, message });
  } catch (e) {
    console.error(`[hubspot-custom-channel-webhook] sendReply failed for client ${install.client_id}:`, e instanceof Error ? e.message : e);
  }
}
