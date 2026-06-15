import { TelegramWebApp, TelegramUser } from '../types/game';

/**
 * Parses the `initData` query string that Telegram provides.
 *
 * SECURITY NOTE:
 * `initDataUnsafe` (used previously) is populated by the Telegram client and
 * can be spoofed by a malicious client or via DevTools — any user_id can be
 * injected.  The `initData` **string**, however, is signed by Telegram with
 * HMAC-SHA256 using the bot token.  It MUST be validated server-side before
 * trusting the extracted user identity.
 *
 * Flow:
 *   1. Client reads `window.Telegram.WebApp.initData` (a URL-encoded string).
 *   2. Client parses it locally for UI purposes (name, photo, etc.).
 *   3. Client sends the **raw initData string** to the server with every
 *      sensitive request (purchase, state save, etc.).
 *   4. Server validates the hash using HMAC-SHA256(bot_token, initData) and
 *      only then trusts the `user.id` and other fields.
 *
 * Until the server-side validation is implemented (see
 * `supabase/functions/validate-init-data/`), the user identity extracted here
 * is treated as **provisional** — sufficient for UX but not for authorising
 * irreversible game actions.
 */
function parseInitData(initData: string): {
  user: TelegramUser | null;
  startParam: string | null;
  authDate: number | null;
  queryId: string | null;
  hash: string | null;
} {
  if (!initData) {
    return { user: null, startParam: null, authDate: null, queryId: null, hash: null };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const queryId = params.get('query_id');
  const authDateStr = params.get('auth_date');
  const authDate = authDateStr ? parseInt(authDateStr, 10) : null;
  const startParam = params.get('start_param');

  let user: TelegramUser | null = null;
  const userStr = params.get('user');
  if (userStr) {
    try {
      user = JSON.parse(userStr) as TelegramUser;
    } catch {
      console.warn('telegram: failed to parse user JSON from initData');
    }
  }

  return { user, startParam, authDate, queryId, hash };
}

// Cache the parsed result so we don't re-parse on every call
let cachedInitData: string | null = null;
let cachedParsed: ReturnType<typeof parseInitData> | null = null;

function getParsedInitData() {
  const tg = getTelegramWebApp();
  const raw = tg?.initData ?? '';
  if (raw !== cachedInitData || !cachedParsed) {
    cachedInitData = raw;
    cachedParsed = parseInitData(raw);
  }
  return cachedParsed;
}

export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
    return window.Telegram.WebApp;
  }
  return null;
}

export function initTelegramMiniApp(): TelegramWebApp | null {
  const tg = getTelegramWebApp();
  if (tg) {
    tg.ready();
    tg.expand();
    tg.enableClosingConfirmation?.();

    if (tg.themeParams) {
      document.documentElement.style.setProperty('--tg-bg', tg.themeParams.bg_color || '#1a1a2e');
      document.documentElement.style.setProperty('--tg-text', tg.themeParams.text_color || '#ffffff');
      document.documentElement.style.setProperty('--tg-hint', tg.themeParams.hint_color || '#888888');
      document.documentElement.style.setProperty('--tg-button', tg.themeParams.button_color || '#5078ff');
      document.documentElement.style.setProperty('--tg-button-text', tg.themeParams.button_text_color || '#ffffff');
    }
  }
  return tg;
}

/**
 * Returns the raw `initData` string for server-side validation.
 * Send this to your backend/edge function so it can verify the HMAC-SHA256
 * signature before trusting any user identity.
 */
export function getRawInitData(): string {
  const tg = getTelegramWebApp();
  return tg?.initData ?? '';
}

/** Provisional user ID — only trustworthy after server-side initData validation. */
export function getTelegramUserId(): number | null {
  return getParsedInitData().user?.id ?? null;
}

/** Provisional user info — suitable for UI display only. */
export function getTelegramUserInfo(): {
  id: number;
  username?: string;
  first_name?: string;
  photo_url?: string;
} | null {
  const user = getParsedInitData().user;
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    first_name: user.first_name,
    photo_url: user.photo_url,
  };
}

/** Provisional referrer ID from start_param. Must be validated server-side. */
export function getReferrerId(): number | null {
  const startParam = getParsedInitData().startParam;
  if (startParam?.startsWith('ref_')) {
    const refId = parseInt(startParam.replace('ref_', ''), 10);
    return isNaN(refId) ? null : refId;
  }
  return null;
}

export function hapticImpact(style: 'light' | 'medium' | 'heavy' = 'medium'): void {
  const tg = getTelegramWebApp();
  tg?.HapticFeedback?.impactOccurred?.(style);
}

export function hapticNotification(type: 'success' | 'error' | 'warning' = 'success'): void {
  const tg = getTelegramWebApp();
  tg?.HapticFeedback?.notificationOccurred?.(type);
}

export function showAlert(message: string): void {
  const tg = getTelegramWebApp();
  if (tg) {
    tg.showAlert(message);
  } else {
    alert(message);
  }
}
