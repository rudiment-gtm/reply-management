// Multitenant EmailBison REST helpers. Unlike the single-tenant M5-Services
// version this was ported from, every call takes the client's own
// {baseUrl, apiKey} explicitly — there is no single global
// EMAILBISON_API_KEY secret here, since each client runs their own
// EmailBison workspace (possibly even their own subdomain), not Rudiment's
// internal send.getrudiment.com account.
import { adminClient } from "./db.ts";

export interface EmailBisonCredentials {
  baseUrl: string;
  apiKey: string;
}

export async function getCredentials(clientId: string): Promise<EmailBisonCredentials> {
  const admin = adminClient();
  const { data, error } = await admin
    .from("emailbison_credentials")
    .select("base_url, api_key")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !data) throw new Error(`No EmailBison credentials found for client ${clientId}: ${error?.message ?? "no row"}`);
  return { baseUrl: data.base_url, apiKey: data.api_key };
}

async function bisonFetch(creds: EmailBisonCredentials, path: string, init: RequestInit = {}) {
  const res = await fetch(`${creds.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = (data as { message?: string })?.message ?? `EmailBison API ${path} failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

export async function getReply(creds: EmailBisonCredentials, replyId: number | string): Promise<unknown> {
  return await bisonFetch(creds, `/replies/${replyId}`);
}

export interface SendReplyInput {
  replyId: number | string;
  message: string;
  senderEmailId?: number;
}

export async function sendReply(creds: EmailBisonCredentials, input: SendReplyInput): Promise<unknown> {
  const body: Record<string, unknown> = {
    message: input.message,
    reply_all: true,
    content_type: "text",
    inject_previous_email_body: true,
  };
  if (input.senderEmailId !== undefined) body.sender_email_id = input.senderEmailId;

  return await bisonFetch(creds, `/replies/${input.replyId}/reply`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
