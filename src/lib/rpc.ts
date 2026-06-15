import { supabase } from './supabase';
import { getRawInitData, getTelegramUserId } from './telegram';

/**
 * Client-side helper for server-authoritative game actions.
 *
 * Every call sends the raw `initData` string to the edge function, which
 * validates it via HMAC-SHA256 before executing the action.  This prevents
 * users from manipulating game state via DevTools.
 *
 * Currently implemented server-side:
 *   - upgrade_tap   — deducts currency and increments tap_power
 *   - switch_epoch  — verifies epoch is unlocked, updates epoch_id
 *
 * Future (requires server-side generator definitions):
 *   - buy_generator — verify balance, deduct cost, add generator
 */

interface RpcResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function callGameAction(payload: Record<string, unknown>): Promise<RpcResult> {
  if (!supabase) return { ok: false, error: 'No Supabase connection' };

  const init_data = getRawInitData();
  if (!init_data) return { ok: false, error: 'Not running in Telegram' };

  const telegramId = getTelegramUserId();
  if (!telegramId) return { ok: false, error: 'No Telegram user ID' };

  try {
    const { data, error } = await supabase.functions.invoke('game-action', {
      body: { ...payload, init_data },
    });

    if (error) {
      return { ok: false, error: error.message || 'Edge function error' };
    }

    return data as RpcResult;
  } catch (e) {
    console.error('callGameAction error:', e);
    return { ok: false, error: String(e) };
  }
}

export async function rpcUpgradeTap(): Promise<RpcResult> {
  return callGameAction({ action: 'upgrade_tap' });
}

export async function rpcSwitchEpoch(epochId: string): Promise<RpcResult> {
  return callGameAction({ action: 'switch_epoch', epoch_id: epochId });
}

export async function rpcBuyGenerator(generatorId: string): Promise<RpcResult> {
  return callGameAction({ action: 'buy_generator', generator_id: generatorId });
}

/**
 * Validate initData on the server. Returns { valid, user_id } or error.
 * Useful for one-shot validation at app startup or before critical actions.
 */
export async function rpcValidateInitData(): Promise<{ valid: boolean; user_id?: number; error?: string }> {
  if (!supabase) return { valid: false, error: 'No Supabase connection' };

  const init_data = getRawInitData();
  if (!init_data) return { valid: false, error: 'Not running in Telegram' };

  try {
    const { data, error } = await supabase.functions.invoke('validate-init-data', {
      body: { init_data },
    });

    if (error) return { valid: false, error: error.message };
    return data as { valid: boolean; user_id?: number; error?: string };
  } catch (e) {
    console.error('rpcValidateInitData error:', e);
    return { valid: false, error: String(e) };
  }
}
