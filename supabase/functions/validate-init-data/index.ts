import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createHmac } from "node:crypto";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

/**
 * Validates Telegram WebApp initData using HMAC-SHA256.
 *
 * Algorithm (per Telegram docs):
 *   1. Sort all key-value pairs from initData alphabetically by key.
 *   2. Join them with \n as "key=value" lines → `data_check_string`.
 *   3. Compute HMAC-SHA256(key=SHA256(bot_token), msg=data_check_string).
 *   4. Compare the hex digest to the `hash` parameter.
 *
 * If they match, the data is authentic and was signed by Telegram.
 * The `auth_date` is also checked — reject if older than 24 hours.
 */
function validateInitData(initData: string): {
  valid: boolean;
  userId: number | null;
  error?: string;
} {
  if (!BOT_TOKEN) {
    return { valid: false, userId: null, error: "TELEGRAM_BOT_TOKEN not configured" };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) {
    return { valid: false, userId: null, error: "Missing hash in initData" };
  }

  // Check auth_date freshness — reject if older than 24h
  const authDateStr = params.get("auth_date");
  if (!authDateStr) {
    return { valid: false, userId: null, error: "Missing auth_date" };
  }
  const authDate = parseInt(authDateStr, 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (isNaN(authDate) || ageSeconds > 86400 || ageSeconds < 0) {
    return { valid: false, userId: null, error: "initData too old or invalid auth_date" };
  }

  // Build data_check_string: sort keys alphabetically, exclude "hash"
  const keys = [...params.keys()].filter(k => k !== "hash").sort();
  const dataCheckString = keys.map(k => `${k}=${params.get(k)}`).join("\n");

  // HMAC-SHA256 with key = SHA256(bot_token)
  const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) {
    return { valid: false, userId: null, error: "HMAC mismatch — initData is forged or corrupted" };
  }

  // Extract user.id
  const userStr = params.get("user");
  let userId: number | null = null;
  if (userStr) {
    try {
      const user = JSON.parse(userStr);
      userId = user.id ?? null;
    } catch {
      return { valid: false, userId: null, error: "Invalid user JSON in initData" };
    }
  }

  return { valid: true, userId };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const body = await req.json();
    const { init_data } = body as { init_data?: string };

    if (!init_data) {
      return json({ error: "Missing init_data" }, 400);
    }

    const result = validateInitData(init_data);
    if (!result.valid) {
      return json({ valid: false, error: result.error }, 401);
    }

    return json({ valid: true, user_id: result.userId });
  } catch (err) {
    console.error("validate-init-data error:", err);
    return json({ valid: false, error: String(err) }, 500);
  }
});
