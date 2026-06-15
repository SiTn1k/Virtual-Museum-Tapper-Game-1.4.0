import { supabase } from './supabase';
import { GameState, EpochId, OwnedGenerator, LeaderboardEntry, ActiveBoosters, DailyTasksState, Epoch } from '../types/game';
import { getTelegramUserId, getTelegramUserInfo, getReferrerId } from './telegram';
import { getCurrentEpochByLevel, EPOCHS } from '../data/epochs';

const LOCAL_STORAGE_KEY = 'ukraine_tap_game_state';
const DEVICE_ID_KEY = 'ukraine_tap_device_id';

export const REFERRER_BONUS = 100;
export const NEW_USER_BONUS = 50;

// Ensure unlockedEpochs includes all epochs the player has reached
// and the epoch they're currently on
function fixUnlockedEpochs(saved: EpochId[], level: number, currentEpochId: EpochId): EpochId[] {
  const result = new Set<EpochId>(saved);
  // Add current epoch
  result.add(currentEpochId);
  // Add all epochs with unlockLevel <= current level
  for (const epoch of EPOCHS) {
    if (epoch.unlockLevel <= level) {
      result.add(epoch.id as EpochId);
    }
  }
  return [...result];
}

function calculateXpToLevel(level: number): number {
  const epoch = getCurrentEpochByLevel(level);
  const { min, max } = epoch.levelRange;
  const rangeSize = Math.max(1, max - min + 1);
  const progress = Math.min(1, Math.max(0, (level - min) / rangeSize));
  const targetSeconds = 300 + progress * (10800 - 300);
  const levelInEpoch = Math.max(1, level - min + 1);
  const estimatedPassive = estimatePassiveForEpoch(epoch, levelInEpoch);
  return Math.max(50, Math.floor(estimatedPassive * targetSeconds));
}

function estimatePassiveForEpoch(epoch: Epoch, levelInEpoch: number): number {
  const tierWeights = [1, 0.5, 0.25, 0.1, 0.03];
  let total = 0;
  for (let i = 0; i < epoch.generators.length && i < tierWeights.length; i++) {
    const g = epoch.generators[i];
    const owned = Math.max(1, Math.floor(levelInEpoch * tierWeights[i]));
    total += g.baseProduction * owned;
  }
  return Math.max(1, total);
}

// Ensure JSONB values are proper objects/arrays, not strings
function ensureJson<T>(value: T | string): T {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch (e) {
      console.warn('ensureJson: failed to parse JSON value', e);
    }
  }
  return value as T;
}

// Ensure IDs are positive numbers or null (never 0)
function sanitizeId(value: number | null | undefined): number | null {
  return value && value > 0 ? value : null;
}

// Generates a stable UUID for this device, stored in localStorage
function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = 'dev_' + crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

// Re-export from telegram.ts for backward compatibility with other consumers
export { getTelegramUserId, getTelegramUserInfo, getReferrerId } from './telegram';

export function saveLocalState(state: GameState): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
      ...state,
      lastSavedAt: Date.now(),
    }));
  } catch (e) {
    console.error('localStorage save failed:', e);
  }
}

export async function saveRemoteState(state: GameState): Promise<void> {
  if (!supabase) return;

  const telegramId = getTelegramUserId();
  const userInfo = getTelegramUserInfo();
  const deviceId = getDeviceId();

  // Merge daily streak/tasks into active_boosters._daily so we don't need extra DB columns
  const boostersWithDaily: ActiveBoosters = {
    ...state.activeBoosters,
    _daily: {
      streak: state.dailyStreak || 0,
      best: state.bestStreak || 0,
      lastDate: state.lastLoginDate || null,
      tasks: state.dailyTasksState || null,
    },
  };

  const payload = {
    epoch_id: state.epochId,
    level: state.level,
    xp: state.xp,
    xp_to_next_level: state.xpToNextLevel,
    total_xp: state.totalXp,
    currency: state.currency,
    total_currency_earned: state.totalCurrencyEarned,
    tap_power: state.tapPower,
    passive_xp_per_second: state.passiveXpPerSecond,
    owned_generators: ensureJson(state.ownedGenerators) as OwnedGenerator[],
    unlocked_epochs: ensureJson(state.unlockedEpochs) as string[],
    artifact_parts: ensureJson(state.artifactParts || {}) as Record<string, number>,
    completed_artifacts: ensureJson(state.completedArtifacts || []) as string[],
    artifact_dupes: ensureJson(state.artifactDupes || {}) as Record<string, number>,
    referrer_id: sanitizeId(state.referrerId),
    referrals_count: state.referralsCount || 0,
    referral_earnings: state.referralEarnings || 0,
    username: userInfo?.username || null,
    first_name: userInfo?.first_name || null,
    photo_url: userInfo?.photo_url || null,
    last_saved_at: new Date().toISOString(),
    active_boosters: boostersWithDaily,
    last_check_in: state.lastCheckIn || null,
    current_streak: state.checkInStreak || 0,
  };

  try {
    if (telegramId) {
      const { error } = await supabase
        .from('game_progress')
        .upsert({ ...payload, telegram_id: telegramId }, { onConflict: 'telegram_id' });
      if (error) throw error;

      // Clean up orphaned device_id record for this session
      await supabase
        .from('game_progress')
        .delete()
        .eq('device_id', deviceId)
        .is('telegram_id', null);
    } else {
      const { data: existing } = await supabase
        .from('game_progress')
        .select('id')
        .eq('device_id', deviceId)
        .is('telegram_id', null)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from('game_progress')
          .update(payload)
          .eq('device_id', deviceId)
          .is('telegram_id', null);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('game_progress')
          .insert({ ...payload, device_id: deviceId });
        if (error) throw error;
      }
    }
  } catch (e) {
    console.error('Supabase save failed:', e);
  }
}

export async function loadGameState(): Promise<GameState | null> {
  const telegramId = getTelegramUserId();
  const referrerId = getReferrerId();
  const deviceId = getDeviceId();

  if (supabase) {
    try {
      // Try telegram_id first, then device_id
      const { data } = telegramId
        ? await supabase
            .from('game_progress')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle()
        : await supabase
            .from('game_progress')
            .select('*')
            .eq('device_id', deviceId)
            .is('telegram_id', null)
            .maybeSingle();

      if (data) {
        // Clear stale localStorage cache when loading from DB
        // This ensures we always use fresh server data in Telegram
        if (telegramId) {
          localStorage.removeItem(LOCAL_STORAGE_KEY);
        }
        return hydrateFromDb(data);
      }

      // New Telegram user — create row immediately so they appear in the DB right away
      if (telegramId) {
        const userInfo = getTelegramUserInfo();
        let bonus = 20;

        if (referrerId && referrerId !== telegramId) {
          await applyReferralBonus(telegramId, referrerId);
          bonus = 20 + NEW_USER_BONUS;
        }

        const newRow = {
          telegram_id: telegramId,
          epoch_id: 'trypillia',
          level: 1,
          xp: 0,
          xp_to_next_level: 100,
          total_xp: 0,
          currency: bonus,
          total_currency_earned: bonus,
          tap_power: 1,
          passive_xp_per_second: 0,
          owned_generators: [],
          unlocked_epochs: ['trypillia'],
          artifact_parts: {},
          completed_artifacts: [],
          artifact_dupes: {},
          referrer_id: referrerId && referrerId !== telegramId ? sanitizeId(referrerId) : null,
          referrals_count: 0,
          referral_earnings: 0,
          active_boosters: {},
          username: userInfo?.username ?? null,
          first_name: userInfo?.first_name ?? null,
          photo_url: userInfo?.photo_url ?? null,
          last_saved_at: new Date().toISOString(),
        };

        const { error } = await supabase.from('game_progress').insert(newRow);
        if (error) console.error('New user insert failed:', error);

        const hasRef = Boolean(referrerId && referrerId !== telegramId);
        return {
          epochId: 'trypillia',
          level: 1,
          xp: 0,
          xpToNextLevel: calculateXpToLevel(1),
          totalXp: 0,
          currency: bonus,
          totalCurrencyEarned: bonus,
          tapPower: 1,
          passiveXpPerSecond: 0,
          ownedGenerators: [],
          unlockedEpochs: ['trypillia'],
          artifactParts: {},
          completedArtifacts: [],
          artifactDupes: {},
          lastSavedAt: Date.now(),
          referrerId: hasRef ? sanitizeId(referrerId) : null,
          referralsCount: 0,
          referralEarnings: 0,
          activeBoosters: {},
          dailyStreak: 0,
          bestStreak: 0,
          lastLoginDate: null,
          dailyTasksState: null,
          lastCheckIn: null,
          checkInStreak: 0,
        };
      }
    } catch (e) {
      console.error('Supabase load failed:', e);
    }
  }

  // Fallback to localStorage
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as GameState;
    return sanitizeLoadedState(parsed);
  } catch (e) {
    console.error('localStorage load failed:', e);
    return null;
  }
}

function hydrateFromDb(data: Record<string, unknown>): GameState {
  // Parse the saved timestamp safely — guard against null/invalid values
  const rawDate = data.last_saved_at as string | null;
  const parsedTime = rawDate ? new Date(rawDate).getTime() : NaN;
  // Preserve the original lastSavedAt so useGame.ts can compute offline gains correctly
  const lastSavedAt = Number.isFinite(parsedTime) ? parsedTime : Date.now();
  const level = (data.level as number) || 1;

  // Extract daily streak/tasks from active_boosters._daily
  const rawBoosters = (data.active_boosters as ActiveBoosters) || {};
  const daily = rawBoosters._daily;
  // Strip _daily from the runtime boosters object (it's a storage concern only)
  const { _daily: _ignored, ...activeBoosters } = rawBoosters;
  void _ignored;

  return {
    epochId: (data.epoch_id as EpochId) || 'trypillia',
    level,
    // Raw values — offline gains are applied by useGame.ts after loading
    xp: (data.xp as number) || 0,
    xpToNextLevel: (data.xp_to_next_level as number) || calculateXpToLevel(level),
    totalXp: (data.total_xp as number) || 0,
    currency: (data.currency as number) || 0,
    totalCurrencyEarned: (data.total_currency_earned as number) || 0,
    tapPower: (data.tap_power as number) || 1,
    passiveXpPerSecond: (data.passive_xp_per_second as number) || 0,
    ownedGenerators: (data.owned_generators as OwnedGenerator[]) || [],
    unlockedEpochs: fixUnlockedEpochs(
      ((data.unlocked_epochs as string[]) || ['trypillia']) as EpochId[],
      level,
      (data.epoch_id as EpochId) || 'trypillia',
    ),
    artifactParts: (data.artifact_parts as Record<string, number>) || {},
    completedArtifacts: (data.completed_artifacts as string[]) || [],
    artifactDupes: (data.artifact_dupes as Record<string, number>) || {},
    lastSavedAt,
    referrerId: sanitizeId(data.referrer_id as number),
    referralsCount: (data.referrals_count as number) || 0,
    referralEarnings: (data.referral_earnings as number) || 0,
    activeBoosters,
    dailyStreak: daily?.streak || 0,
    bestStreak: daily?.best || 0,
    lastLoginDate: daily?.lastDate || null,
    dailyTasksState: (daily?.tasks as DailyTasksState) || null,
    lastCheckIn: (data.last_check_in as string) || null,
    checkInStreak: (data.current_streak as number) || 0,
  };
}

// Sanitizes a localStorage-loaded state without applying offline gains.
// Offline gains are applied by useGame.ts to avoid double-counting.
function sanitizeLoadedState(parsed: GameState): GameState {
  // If _daily was stored in activeBoosters (from an old localStorage save), extract it
  const rawBoosters = parsed.activeBoosters || {};
  const daily = rawBoosters._daily;
  const { _daily: _ignored, ...cleanBoosters } = rawBoosters;
  void _ignored;

  return {
    ...parsed,
    // Ensure required fields exist (guards against old/corrupt saves)
    artifactParts: parsed.artifactParts || {},
    completedArtifacts: parsed.completedArtifacts || [],
    artifactDupes: parsed.artifactDupes || {},
    referrerId: sanitizeId(parsed.referrerId),
    referralsCount: parsed.referralsCount || 0,
    referralEarnings: parsed.referralEarnings || 0,
    activeBoosters: cleanBoosters,
    // Guard against corrupt timestamps
    lastSavedAt: Number.isFinite(parsed.lastSavedAt) ? parsed.lastSavedAt : Date.now(),
    // Daily streak/tasks — from parsed fields OR from legacy _daily in boosters
    dailyStreak: parsed.dailyStreak || daily?.streak || 0,
    bestStreak: parsed.bestStreak || daily?.best || 0,
    lastLoginDate: parsed.lastLoginDate || daily?.lastDate || null,
    dailyTasksState: parsed.dailyTasksState || (daily?.tasks as DailyTasksState | undefined) || null,
    lastCheckIn: parsed.lastCheckIn || null,
    checkInStreak: parsed.checkInStreak || 0,
  };
}

async function applyReferralBonus(_newUserId: number, referrerId: number): Promise<void> {
  if (!supabase) return;
  try {
    const { data: ref } = await supabase
      .from('game_progress')
      .select('currency, total_currency_earned, referrals_count, referral_earnings')
      .eq('telegram_id', referrerId)
      .maybeSingle();

    if (ref) {
      await supabase
        .from('game_progress')
        .update({
          referrals_count: (ref.referrals_count || 0) + 1,
          referral_earnings: (ref.referral_earnings || 0) + REFERRER_BONUS,
          currency: (ref.currency || 0) + REFERRER_BONUS,
          total_currency_earned: (ref.total_currency_earned || 0) + REFERRER_BONUS,
        })
        .eq('telegram_id', referrerId);
    }

  } catch (e) {
    console.error('Referral bonus failed:', e);
  }
}


export async function fetchActiveBoosters(telegramId: number): Promise<ActiveBoosters> {
  if (!supabase) return {};
  try {
    const { data } = await supabase
      .from('game_progress')
      .select('active_boosters')
      .eq('telegram_id', telegramId)
      .maybeSingle();
    return (data?.active_boosters as ActiveBoosters) || {};
  } catch {
    return {};
  }
}

export async function clearLegendaryBooster(telegramId: number): Promise<void> {
  if (!supabase) return;
  try {
    const { data } = await supabase
      .from('game_progress')
      .select('active_boosters')
      .eq('telegram_id', telegramId)
      .maybeSingle();
    if (!data) return;
    const boosters = (data.active_boosters as ActiveBoosters) || {};
    delete boosters.legendary_next_gacha;
    await supabase
      .from('game_progress')
      .update({ active_boosters: boosters })
      .eq('telegram_id', telegramId);
  } catch (e) {
    console.error('clearLegendaryBooster failed:', e);
  }
}

export async function getLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('game_progress')
      .select('telegram_id, first_name, username, level, total_xp, referrals_count')
      .order('total_xp', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    return data.map((row, index) => ({
      telegram_id: row.telegram_id,
      first_name: row.first_name,
      username: row.username,
      level: row.level,
      total_xp: row.total_xp,
      referrals_count: row.referrals_count || 0,
      rank: index + 1,
    }));
  } catch (e) {
    console.error('Leaderboard fetch failed:', e);
    return [];
  }
}

export async function getUserRank(telegramId: number): Promise<number | null> {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from('game_progress')
      .select('total_xp')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (!data) return null;

    const { count } = await supabase
      .from('game_progress')
      .select('*', { count: 'exact', head: true })
      .gt('total_xp', data.total_xp);

    return (count || 0) + 1;
  } catch (e) {
    console.error('Rank fetch failed:', e);
    return null;
  }
}

export async function clearGameState(): Promise<void> {
  const telegramId = getTelegramUserId();
  const deviceId = getDeviceId();
  localStorage.removeItem(LOCAL_STORAGE_KEY);

  if (!supabase) return;
  try {
    if (telegramId) {
      await supabase.from('game_progress').delete().eq('telegram_id', telegramId);
    } else {
      await supabase.from('game_progress').delete().eq('device_id', deviceId).is('telegram_id', null);
    }
  } catch (e) {
    console.error('Clear failed:', e);
  }
}
