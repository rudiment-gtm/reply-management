// Multitenant HubSpot OAuth + Custom Channels helpers. Each client has
// their own row in hubspot_installs (their own portal, own access/refresh
// tokens, own channel account) — but all clients share ONE HubSpot app and
// ONE registered custom channel (HUBSPOT_APP_CLIENT_ID/SECRET,
// HUBSPOT_CHANNEL_ID env secrets), the same way a single WhatsApp channel
// type in HubSpot serves many installed portals.
import { adminClient, requireEnv } from "./db.ts";

const TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";

export interface HubSpotInstall {
  client_id: string;
  portal_id: number;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  channel_account_id: string | null;
  inbox_id: string | null;
}

export async function getInstallByPortalId(portalId: number): Promise<HubSpotInstall | null> {
  const admin = adminClient();
  const { data, error } = await admin
    .from("hubspot_installs")
    .select("*")
    .eq("portal_id", portalId)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up hubspot_installs by portal_id: ${error.message}`);
  return data;
}

export async function getInstallByClientId(clientId: string): Promise<HubSpotInstall | null> {
  const admin = adminClient();
  const { data, error } = await admin
    .from("hubspot_installs")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up hubspot_installs by client_id: ${error.message}`);
  return data;
}

// Exchanges an OAuth authorization code for tokens and upserts the
// resulting row, keyed by client_id (passed through the OAuth `state`
// param from the install link — see buildInstallUrl). Called once per
// client, from hubspot-oauth-callback.
export async function completeOAuthInstall(clientId: string, code: string): Promise<{ portalId: number }> {
  const redirectUri = requireEnv("HUBSPOT_OAUTH_REDIRECT_URI");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: requireEnv("HUBSPOT_APP_CLIENT_ID"),
    client_secret: requireEnv("HUBSPOT_APP_CLIENT_SECRET"),
    redirect_uri: redirectUri,
    code,
  });
  const tokens = await requestToken(body);
  const portalId = await fetchPortalId(tokens.access_token);

  const admin = adminClient();
  const { error } = await admin.from("hubspot_installs").upsert({
    client_id: clientId,
    portal_id: portalId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  }, { onConflict: "client_id" });
  if (error) throw new Error(`Failed to store HubSpot OAuth tokens: ${error.message}`);

  return { portalId };
}

// Returns a valid (non-expired) access token for the given client,
// refreshing it first if needed.
export async function getValidAccessToken(clientId: string): Promise<string> {
  const install = await getInstallByClientId(clientId);
  if (!install) throw new Error(`No HubSpot install found for client ${clientId}. Has onboarding completed the OAuth step?`);

  const expiresAt = new Date(install.expires_at).getTime();
  if (install.access_token && Date.now() < expiresAt - 2 * 60 * 1000) return install.access_token;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: requireEnv("HUBSPOT_APP_CLIENT_ID"),
    client_secret: requireEnv("HUBSPOT_APP_CLIENT_SECRET"),
    refresh_token: install.refresh_token,
  });
  const tokens = await requestToken(body);

  const admin = adminClient();
  const { error } = await admin.from("hubspot_installs").update({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  }).eq("client_id", clientId);
  if (error) throw new Error(`Failed to store refreshed HubSpot OAuth tokens: ${error.message}`);

  return tokens.access_token;
}

export function buildInstallUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("HUBSPOT_APP_CLIENT_ID"),
    redirect_uri: requireEnv("HUBSPOT_OAUTH_REDIRECT_URI"),
    scope: [
      "crm.objects.contacts.read",
      "crm.objects.contacts.write",
      "conversations.read",
      "conversations.custom_channels.read",
      "conversations.custom_channels.write",
    ].join(" "),
    state: clientId,
  });
  return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
}

export async function createChannelAccount(clientId: string, inboxId: string, deliveryIdentifier: string): Promise<string> {
  const accessToken = await getValidAccessToken(clientId);
  const channelId = requireEnv("HUBSPOT_CHANNEL_ID");

  const res = await fetch(`https://api.hubapi.com/conversations/v3/custom-channels/${channelId}/channel-accounts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      authorized: true,
      name: "Cold Outbound",
      deliveryIdentifier: { type: "HS_EMAIL_ADDRESS", value: deliveryIdentifier },
      inboxId,
    }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Channel account creation failed (${res.status}): ${text}`);

  const admin = adminClient();
  const { error } = await admin.from("hubspot_installs").update({
    channel_account_id: data.id,
    inbox_id: inboxId,
  }).eq("client_id", clientId);
  if (error) throw new Error(`Failed to store channel_account_id: ${error.message}`);

  return data.id;
}

export async function listInboxes(clientId: string): Promise<unknown> {
  const accessToken = await getValidAccessToken(clientId);
  const res = await fetch("https://api.hubapi.com/conversations/v3/conversations/inboxes", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Listing inboxes failed (${res.status}): ${text}`);
  return data;
}

export async function pushInboundMessage(input: {
  clientId: string;
  leadEmail: string;
  leadName?: string;
  text: string;
  integrationThreadId: string;
}): Promise<unknown> {
  const install = await getInstallByClientId(input.clientId);
  if (!install?.channel_account_id) {
    throw new Error(`Client ${input.clientId} has no channel_account_id yet — onboarding isn't finished.`);
  }
  const accessToken = await getValidAccessToken(input.clientId);
  const channelId = requireEnv("HUBSPOT_CHANNEL_ID");

  // The recipient identifier is this install's own channel-account
  // identity (the deliveryIdentifier set at onboarding time) — it
  // represents "our side" of every conversation on this channel account,
  // regardless of which real EmailBison sending domain a given reply
  // actually arrived on.
  const recipientRes = await fetch(`https://api.hubapi.com/conversations/v3/custom-channels/${channelId}/channel-accounts/${install.channel_account_id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const recipientText = await recipientRes.text();
  const recipientData = recipientText ? JSON.parse(recipientText) : null;
  if (!recipientRes.ok) throw new Error(`Failed to look up channel account ${install.channel_account_id}: ${recipientText}`);
  const recipientIdentifier = recipientData.deliveryIdentifier?.value;

  const res = await fetch(`https://api.hubapi.com/conversations/v3/custom-channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      channelAccountId: install.channel_account_id,
      senders: [{ deliveryIdentifier: { type: "HS_EMAIL_ADDRESS", value: input.leadEmail }, name: input.leadName ?? input.leadEmail }],
      recipients: [{ deliveryIdentifier: { type: "HS_EMAIL_ADDRESS", value: recipientIdentifier } }],
      text: input.text,
      messageDirection: "INCOMING",
      integrationThreadId: input.integrationThreadId,
    }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Message creation failed (${res.status}): ${text}`);
  return data;
}

async function requestToken(body: URLSearchParams): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`HubSpot OAuth token request failed (${res.status}): ${text}`);
  return data;
}

async function fetchPortalId(accessToken: string): Promise<number> {
  const res = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${accessToken}`);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`HubSpot token-info request failed (${res.status}): ${text}`);
  return data.hub_id;
}
