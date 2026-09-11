// Verifies HubSpot's v3 webhook request signature (HMAC-SHA256 over
// method+URI+body+timestamp, keyed by the app's client secret — shared
// across all client installs, since it's the app's own secret, not a
// per-client one). See:
// https://developers.hubspot.com/docs/api/webhooks/validating-requests
import { requireEnv } from "./db.ts";

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

export async function verifyHubSpotSignature(req: Request, rawBody: string): Promise<boolean> {
  const clientSecret = requireEnv("HUBSPOT_APP_CLIENT_SECRET");

  const signature = req.headers.get("X-HubSpot-Signature-v3");
  const timestampHeader = req.headers.get("X-HubSpot-Request-Timestamp");
  if (!signature || !timestampHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > MAX_SIGNATURE_AGE_MS) {
    return false;
  }

  const url = new URL(req.url);
  const requestUri = decodeURIComponent(url.pathname) + url.search;
  const message = `${req.method}${requestUri}${rawBody}${timestampHeader}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(clientSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  const ok = timingSafeEqual(expected, signature);
  if (!ok) {
    // Diagnostic-only — nothing here is secret (the raw req.url, the
    // reconstructed requestUri, and HubSpot's own signature are all
    // either public or attacker-visible already; the client secret itself
    // is never logged).
    console.error("[hubspotSignature] mismatch diagnostics:", JSON.stringify({
      rawReqUrl: req.url,
      urlPathname: url.pathname,
      urlSearch: url.search,
      reconstructedRequestUri: requestUri,
      method: req.method,
      bodyLength: rawBody.length,
      timestampHeader,
      receivedSignature: signature,
      computedSignature: expected,
    }));
  }
  return ok;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
