import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TURNSTILE_SECRET_KEY = Deno.env.get("TURNSTILE_SECRET_KEY")!;
const SITE_URL = Deno.env.get("RL_TRAINER_SITE_URL")!;

const feedbackTypes = new Set([
  "ui_ux",
  "bug",
  "feature_request",
  "training_coaching",
  "account",
  "performance",
  "other",
]);

interface FeedbackPayload {
  turnstile_token?: unknown;
  feedback_type?: unknown;
  message?: unknown;
  rating?: unknown;
  page_context?: unknown;
  rank_context?: unknown;
  platform_context?: unknown;
}

function allowedOrigins() {
  const siteOrigin = new URL(SITE_URL).origin;
  return new Set([siteOrigin]);
}

function responseHeaders(origin: string | null) {
  const allowOrigin = origin && allowedOrigins().has(origin) ? origin : new URL(SITE_URL).origin;
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(body: Record<string, unknown>, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin) });
}

function optionalText(value: unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : null;
}

async function getAuthenticatedUserId(req: Request) {
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return null;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  return error || !data.user ? null : data.user.id;
}

async function verifyTurnstile(token: string, remoteIp: string | null) {
  const form = new FormData();
  form.append("secret", TURNSTILE_SECRET_KEY);
  form.append("response", token);
  if (remoteIp) form.append("remoteip", remoteIp);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const result = await response.json() as { success?: boolean };
  // Cloudflare enforces the widget's hostname allowlist before issuing a
  // valid token. Do not duplicate that check here: equivalent public origins
  // (such as a configured www redirect) can otherwise be rejected locally.
  return Boolean(response.ok && result.success);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin) });
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);
    if (!origin || !allowedOrigins().has(origin)) return jsonResponse({ error: "Origin not allowed" }, 403, origin);
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TURNSTILE_SECRET_KEY || !SITE_URL) {
      console.error("Feedback submission worker is missing required configuration.");
      return jsonResponse({ error: "Feedback submission is temporarily unavailable" }, 503, origin);
    }

    const payload = await req.json() as FeedbackPayload;
    const token = optionalText(payload.turnstile_token, 4096);
    const feedbackType = optionalText(payload.feedback_type, 64);
    const message = optionalText(payload.message, 3000);
    const rating = payload.rating === null || payload.rating === undefined || payload.rating === ""
      ? null
      : Number(payload.rating);

    if (!token) return jsonResponse({ error: "Complete the spam check before sending." }, 400, origin);
    if (!message || message.length < 3) return jsonResponse({ error: "Tell us a little more before sending." }, 400, origin);
    if (!feedbackType || !feedbackTypes.has(feedbackType)) return jsonResponse({ error: "Invalid feedback type." }, 400, origin);
    if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return jsonResponse({ error: "Invalid rating." }, 400, origin);
    }

    const remoteIp = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    if (!await verifyTurnstile(token, remoteIp)) {
      return jsonResponse({ error: "Spam check failed or expired. Please try again." }, 400, origin);
    }

    const userId = await getAuthenticatedUserId(req);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await supabase.from("feedback").insert({
      user_id: userId,
      feedback_type: feedbackType,
      message,
      rating,
      page_context: optionalText(payload.page_context, 120),
      rank_context: optionalText(payload.rank_context, 80),
      platform_context: optionalText(payload.platform_context, 80),
      grouping_status: "pending",
    });

    if (error) {
      console.error("Could not save feedback:", error.message);
      return jsonResponse({ error: "Could not save feedback. Please try again." }, 500, origin);
    }

    return jsonResponse({ success: true }, 201, origin);
  } catch (error) {
    console.error("Feedback submission worker error:", error);
    return jsonResponse({ error: "Unexpected server error" }, 500, origin);
  }
});
