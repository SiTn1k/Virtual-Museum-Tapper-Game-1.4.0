import { useState, useEffect, useCallback, useRef } from 'react';
import { GameState, EpochId, OwnedGenerator, TapEvent, LeaderboardEntry, Epoch } from '../types/game';
import {
  EPOCHS,
  ARTIFACTS,
  getEpochById,
  getCurrentEpochByLevel,
  getGeneratorCost,
  getGeneratorProduction,
} from '../data/epochs';
import {
  getTodayDateStr,
  getYesterdayDateStr,
  makeFreshDailyTasks,
  getStreakReward,
  getTaskById,
  type StreakReward,
} from '../data/tasks';
import {
  saveLocalState,
  saveRemoteState,
  loadGameState,
  getTelegramUserId,
  getLeaderboard,
  getUserRank,
  fetchActiveBoosters,
} from '../lib/storage';
import type { ActiveBoosters } from '../types/game';

const LOCAL_SAVE_INTERVAL = 2000;
const REMOTE_SAVE_INTERVAL = 15000;
const MAX_LEVEL = 999;
const TAB_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * XP curve: tuned so each level takes 5min–3hr of passive income.
 *
 * Instead of a global exponential (which made level 58 cost 1.1 trillion),
 * each epoch defines its own expected passive XP/s range, and we compute
 * xpToNextLevel as: expectedPassivePerSec * targetSecondsForLevel.
 *
 * targetSeconds ramps from 300s (5 min) at epoch start to 10800s (3 hr) at epoch end.
 * The base passive estimate scales with the epoch's generator production.
 */
function calculateXpToLevel(level: number): number {
  const epoch = getCurrentEpochByLevel(level);
  const { min, max } = epoch.levelRange;
  const rangeSize = Math.max(1, max - min + 1);
  const progress = Math.min(1, Math.max(0, (level - min) / rangeSize)); // 0 at epoch start, ~1 at end

  // Target time: 5 min at epoch start → 3 hr at epoch end
  const targetSeconds = 300 + progress * (10800 - 300);

  // Estimate passive XP/s for this level within the epoch
  // Use the epoch's base production scaling × level factor
  // The sum of all generators at roughly (level - min + 1) levels gives a good estimate
  const levelInEpoch = Math.max(1, level - min + 1);
  const estimatedPassive = estimatePassiveForEpoch(epoch, levelInEpoch);

  return Math.max(50, Math.floor(estimatedPassive * targetSeconds));
}

function estimatePassiveForEpoch(epoch: Epoch, levelInEpoch: number): number {
  // Rough estimate: sum of production if player owns ~2 generators per tier
  // scaled by their level within the epoch
  const tierWeights = [1, 0.5, 0.25, 0.1, 0.03]; // cheaper generators are bought more
  let total = 0;
  for (let i = 0; i < epoch.generators.length && i < tierWeights.length; i++) {
    const g = epoch.generators[i];
    const owned = Math.max(1, Math.floor(levelInEpoch * tierWeights[i]));
    total += g.baseProduction * owned;
  }
  return Math.max(1, total);
}

export interface ArtifactMultipliers {
  xp: number;
  currency: number;
  passive: number;
}

export interface BoosterMultipliers {
  xp: number;
  currency: number;
}

export function getBoosterMultipliers(boosters: ActiveBoosters): BoosterMultipliers {
  const now = Date.now();
  let xp = 1;
  let currency = 1;

  if (boosters.xp_boost_end && boosters.xp_boost_end > now) {
    xp = Math.max(xp, boosters.xp_boost_mult ?? 2);
  }
  if (boosters.currency_boost_end && boosters.currency_boost_end > now) {
    currency = Math.max(currency, boosters.currency_boost_mult ?? 2);
  }
  if (boosters.super_boost_end && boosters.super_boost_end > now) {
    const m = boosters.super_boost_mult ?? 3;
    xp = Math.max(xp, m);
    currency = Math.max(currency, m);
  }

  return { xp, currency };
}

export function getArtifactMultipliers(completedArtifacts: string[], artifactDupes?: Record<string, number>): ArtifactMultipliers {
  let xp = 1;
  let currency = 1;
  let passive = 1;
  for (const id of completedArtifacts) {
    const art = ARTIFACTS.find(a => a.id === id);
    if (!art) continue;
    // Each duplicate adds +10% of the base bonus (stacks additively, then multiplied)
    const dupeCount = artifactDupes?.[id] || 0;
    const effectiveValue = art.bonus.value + (art.bonus.value - 1) * 0.1 * dupeCount;
    if (art.bonus.type === 'xp_multiplier') xp *= effectiveValue;
    if (art.bonus.type === 'currency_multiplier') currency *= effectiveValue;
    if (art.bonus.type === 'passive_boost') passive *= effectiveValue;
  }
  return { xp, currency, passive };
}

const INITIAL_STATE: GameState = {
  epochId: 'trypillia',
  level: 1,
  xp: 0,
  xpToNextLevel: calculateXpToLevel(1),
  totalXp: 0,
  currency: 20,
  totalCurrencyEarned: 20,
  ownedGenerators: [],
  tapPower: 1,
  passiveXpPerSecond: 0,
  unlockedEpochs: ['trypillia'],
  artifactParts: {},
  completedArtifacts: [],
  artifactDupes: {},
  lastSavedAt: Date.now(),
  referrerId: null,
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

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error';

export function useGame() {
  const [isLoading, setIsLoading] = useState(true);
  const [state, setState] = useState<GameState>(INITIAL_STATE);
  const [tapEvents, setTapEvents] = useState<TapEvent[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [userRank, setUserRank] = useState<number | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [offlineGains, setOfflineGains] = useState<{ xp: number; currency: number } | null>(null);
  const [duplicateTab, setDuplicateTab] = useState(false);
  const [streakModal, setStreakModal] = useState<{ streak: number; reward: StreakReward } | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('synced');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showDailyRewards, setShowDailyRewards] = useState(false);
  const tickRef = useRef<number | null>(null);
  const localSaveRef = useRef<number | null>(null);
  const remoteSaveRef = useRef<number | null>(null);
  const isInitialized = useRef(false);
  const dirtyRef = useRef(false);
  const isOnlineRef = useRef(true);

  // ── Online/offline detection ────────────────────────────────────────
  useEffect(() => {
    const goOffline = () => {
      isOnlineRef.current = false;
      setSyncStatus('offline');
      setConnectionError('Проблеми зі з\'єднанням. Прогрес збережеться локально');
    };
    const goOnline = () => {
      isOnlineRef.current = true;
      setSyncStatus('synced');
      setConnectionError(null);
    };

    // Initial state
    isOnlineRef.current = navigator.onLine;
    if (!navigator.onLine) goOffline();

    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);

    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  // Multiple tab detection
  useEffect(() => {
    const STORAGE_KEY = 'game_active_tab';

    // Claim active tab on mount
    localStorage.setItem(STORAGE_KEY, TAB_ID);

    const checkTab = () => {
      const activeTab = localStorage.getItem(STORAGE_KEY);
      if (activeTab && activeTab !== TAB_ID) {
        setDuplicateTab(true);
      } else {
        // Other tab closed/released — reclaim and clear warning
        localStorage.setItem(STORAGE_KEY, TAB_ID);
        setDuplicateTab(false);
      }
    };

    const interval = setInterval(checkTab, 1000);

    // Listen for storage events from other tabs
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      if (e.newValue && e.newValue !== TAB_ID) {
        setDuplicateTab(true);
      } else {
        setDuplicateTab(false);
      }
    };
    window.addEventListener('storage', handleStorage);

    return () => {
      clearInterval(interval);
      window.removeEventListener('storage', handleStorage);
      if (localStorage.getItem(STORAGE_KEY) === TAB_ID) {
        localStorage.removeItem(STORAGE_KEY);
      }
    };
  }, []);

  // Use the player's selected epoch (state.epochId) if available
  // Fall back to level-based epoch only for new players
  const epoch = getEpochById(state.epochId);

  const calculatePassiveXp = useCallback((owned: OwnedGenerator[], unlockedEpochs: EpochId[]): number => {
    // Sum production from all owned generators across all unlocked epochs
    return owned.reduce((total, og) => {
      // Search for generator in all unlocked epochs
      for (const epochId of unlockedEpochs) {
        const epochData = getEpochById(epochId);
        const generator = epochData.generators.find(g => g.id === og.generatorId);
        if (generator) {
          return total + getGeneratorProduction(generator, og.level);
        }
      }
      return total;
    }, 0);
  }, []);

  useEffect(() => {
    if (isInitialized.current) return;
    isInitialized.current = true;

    (async () => {
      let saved: GameState | null = null;
      try {
        saved = await loadGameState();
      } catch (e) {
        console.error('Failed to load game state:', e);
        setSyncStatus('error');
        setConnectionError('Не вдалося завантажити прогрес. Гратимете з локальної копії.');
        // Try localStorage fallback
        try {
          const raw = localStorage.getItem('ukraine_tap_game_state');
          if (raw) saved = JSON.parse(raw) as GameState;
        } catch {
          // No fallback available — start fresh
        }
      }
      if (saved) {
        const passiveXp = calculatePassiveXp(saved.ownedGenerators, saved.unlockedEpochs);

        // Compute offline gains (storage.ts returns raw values, we apply them here once)
        const offlineMs = Math.max(0, Date.now() - saved.lastSavedAt);
        const offlineSec = Math.min(offlineMs / 1000, 8 * 3600);
        let offlineXp = passiveXp * offlineSec;
        let offlineCurrency = (saved.level * 50) * (offlineSec / 60);

        // ── Daily streak check ────────────────────────────────────────
        const today = getTodayDateStr();
        const yesterday = getYesterdayDateStr();
        let newStreak = saved.dailyStreak || 0;
        let newBestStreak = saved.bestStreak || 0;
        let newLastLoginDate = saved.lastLoginDate;
        let isNewDay = false;

        if (saved.lastLoginDate !== today) {
          isNewDay = true;
          if (!saved.lastLoginDate) {
            // Brand new player
            newStreak = 1;
          } else if (saved.lastLoginDate === yesterday) {
            newStreak = (saved.dailyStreak || 0) + 1;
          } else {
            // Missed at least one day → reset streak
            newStreak = 1;
          }
          newBestStreak = Math.max(newStreak, saved.bestStreak || 0);
          newLastLoginDate = today;

          // Add streak reward to offline gains so it's shown in the same batch
          const reward = getStreakReward(newStreak);
          offlineXp += reward.xp;
          offlineCurrency += reward.currency;
          setStreakModal({ streak: newStreak, reward });
        }

        // ── Daily tasks: refresh if new day ──────────────────────────
        let dailyTasksState = saved.dailyTasksState;
        if (!dailyTasksState || dailyTasksState.date !== today) {
          dailyTasksState = makeFreshDailyTasks(today);
        }

        if (offlineMs > 60_000 && (offlineXp > 100 || offlineCurrency > 10) && !isNewDay) {
          setOfflineGains({ xp: offlineXp, currency: offlineCurrency });
        }

        // ── Daily check-in: show reward modal if player hasn't claimed today ──
        const checkInToday = getTodayDateStr();
        if (saved.lastCheckIn !== checkInToday) {
          setShowDailyRewards(true);
        }

        setState({
          ...saved,
          xp: saved.xp + offlineXp,
          totalXp: saved.totalXp + offlineXp,
          currency: saved.currency + offlineCurrency,
          totalCurrencyEarned: saved.totalCurrencyEarned + offlineCurrency,
          passiveXpPerSecond: passiveXp,
          lastSavedAt: Date.now(),
          dailyStreak: newStreak,
          bestStreak: newBestStreak,
          lastLoginDate: newLastLoginDate,
          dailyTasksState,
        });
      }
      setIsLoading(false);
    })();
  }, [calculatePassiveXp]);

  // Use a stable ref for save so we don't recreate the interval on every state update
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Dual-layer save: local (fast) + remote (throttled) ──────────────
  // Mark state as dirty whenever it changes — the intervals check this flag
  // to avoid redundant writes when nothing changed.
  useEffect(() => {
    if (isLoading) return;
    dirtyRef.current = true;
  }, [state, isLoading]);

  useEffect(() => {
    if (isLoading) return;

    // Local save: every 2s (cheap, synchronous)
    localSaveRef.current = window.setInterval(() => {
      if (dirtyRef.current) {
        saveLocalState(stateRef.current);
        dirtyRef.current = false;
      }
    }, LOCAL_SAVE_INTERVAL);

    // Remote save: every 15s (expensive, throttled to avoid race conditions)
    remoteSaveRef.current = window.setInterval(async () => {
      if (!isOnlineRef.current) return;
      try {
        setSyncStatus('syncing');
        await saveRemoteState(stateRef.current);
        setSyncStatus('synced');
        // Clear connection error on first successful save after a failure
        setConnectionError(prev => prev ? null : prev);
      } catch (e) {
        console.error('Remote save failed:', e);
        setSyncStatus('error');
        setConnectionError('Проблеми зі з\'єднанням. Прогрес збережеться локально');
      }
    }, REMOTE_SAVE_INTERVAL);

    // Flush both on unmount / tab close
    const flush = () => {
      saveLocalState(stateRef.current);
      saveRemoteState(stateRef.current);
    };

    window.addEventListener('beforeunload', flush);

    return () => {
      if (localSaveRef.current) clearInterval(localSaveRef.current);
      if (remoteSaveRef.current) clearInterval(remoteSaveRef.current);
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [isLoading]);

  useEffect(() => {
    if (isLoading) return;

    tickRef.current = window.setInterval(() => {
      setState(prev => {
        const basePassiveXp = calculatePassiveXp(prev.ownedGenerators, prev.unlockedEpochs);
        const { passive: passMult, currency: artCurrMult } = getArtifactMultipliers(prev.completedArtifacts || [], prev.artifactDupes || {});
        const { xp: boostXpMult, currency: boostCurrMult } = getBoosterMultipliers(prev.activeBoosters || {});
        const effectivePassiveXp = basePassiveXp * passMult * boostXpMult;

        const xpGainThisTick = effectivePassiveXp / 10;
        let xp = prev.xp + xpGainThisTick;
        const newTotalXp = prev.totalXp + xpGainThisTick;

        const currMult = artCurrMult * boostCurrMult;
        let newLevel = prev.level;
        let xpToNext = prev.xpToNextLevel;
        let newCurrency = prev.currency;
        let newTotalCurrency = prev.totalCurrencyEarned;
        // Reuse same array reference if no epoch unlocks happen — avoids cascading re-renders
        let newUnlocked: string[] | null = null;

        while (xp >= xpToNext && newLevel < MAX_LEVEL) {
          xp -= xpToNext;
          newLevel++;
          xpToNext = calculateXpToLevel(newLevel);
          const levelReward = Math.round(newLevel * 50 * currMult);
          newCurrency += levelReward;
          newTotalCurrency += levelReward;

          EPOCHS.forEach(e => {
            if (e.unlockLevel === newLevel && !prev.unlockedEpochs.includes(e.id)) {
              if (!newUnlocked) newUnlocked = [...prev.unlockedEpochs];
              if (!newUnlocked.includes(e.id)) newUnlocked.push(e.id);
            }
          });
        }

        const unlockedEpochs = newUnlocked ?? prev.unlockedEpochs;
        const newEpochUnlocked = newUnlocked !== null;
        const epochId = newEpochUnlocked
          ? getCurrentEpochByLevel(newLevel).id
          : prev.epochId;

        return {
          ...prev,
          xp,
          totalXp: newTotalXp,
          level: newLevel,
          xpToNextLevel: xpToNext,
          epochId,
          passiveXpPerSecond: effectivePassiveXp,
          currency: newCurrency,
          totalCurrencyEarned: newTotalCurrency,
          unlockedEpochs,
        };
      });
    }, 100);

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [isLoading, calculatePassiveXp]);

  const tap = useCallback((x: number, y: number) => {
    const eventId = Math.random().toString(36).substr(2, 9);

    setState(prev => {
      const { xp: artXpMult } = getArtifactMultipliers(prev.completedArtifacts || [], prev.artifactDupes || {});
      const { xp: boostXpMult } = getBoosterMultipliers(prev.activeBoosters || {});
      const baseTap = Math.max(1, Math.round(prev.tapPower * artXpMult * boostXpMult));
      const passiveFloor = Math.round(prev.passiveXpPerSecond * 0.015);
      const value = Math.max(baseTap, passiveFloor);

      setTapEvents(te => [
        ...te.slice(-9),
        { id: eventId, x, y, value, createdAt: Date.now() },
      ]);
      setTimeout(() => {
        setTapEvents(te => te.filter(e => e.id !== eventId));
      }, 1000);

      // Track daily task counters for tap and earn_xp types
      const tasks = prev.dailyTasksState;
      const updatedTasks = tasks
        ? {
            ...tasks,
            counters: {
              ...tasks.counters,
              tap: tasks.counters.tap + 1,
              earn_xp: tasks.counters.earn_xp + value,
            },
          }
        : tasks;

      return {
        ...prev,
        xp: prev.xp + value,
        totalXp: prev.totalXp + value,
        dailyTasksState: updatedTasks,
      };
    });
  }, []);

  const buyGenerator = useCallback((generatorId: string) => {
    const generator = epoch.generators.find(g => g.id === generatorId);
    if (!generator) return false;

    const currentOwned = state.ownedGenerators.find(og => og.generatorId === generatorId);
    const currentLevel = currentOwned?.level || 0;
    const cost = getGeneratorCost(generator, currentLevel);

    if (state.currency < cost) return false;

    setState(prev => {
      const existing = prev.ownedGenerators.find(og => og.generatorId === generatorId);
      const newOwned = existing
        ? prev.ownedGenerators.map(og =>
            og.generatorId === generatorId ? { ...og, level: og.level + 1 } : og
          )
        : [...prev.ownedGenerators, { generatorId, level: 1 }];

      const { passive: passMult } = getArtifactMultipliers(prev.completedArtifacts || [], prev.artifactDupes || {});
      const newPassiveXp = calculatePassiveXp(newOwned, prev.unlockedEpochs) * passMult;

      const tasks = prev.dailyTasksState;
      const updatedTasks = tasks
        ? { ...tasks, counters: { ...tasks.counters, buy_generator: tasks.counters.buy_generator + 1 } }
        : tasks;

      return {
        ...prev,
        currency: prev.currency - cost,
        ownedGenerators: newOwned,
        passiveXpPerSecond: newPassiveXp,
        dailyTasksState: updatedTasks,
      };
    });

    return true;
  }, [epoch.generators, state.currency, state.ownedGenerators, calculatePassiveXp]);

  const upgradeTapPower = useCallback(() => {
    const rawCost = 25 * Math.pow(1.8, state.tapPower - 1);
    // Guard against floating-point overflow at very high tap power levels
    const cost = Number.isFinite(rawCost) ? Math.floor(rawCost) : Number.MAX_SAFE_INTEGER;
    if (state.currency < cost) return false;

    setState(prev => {
      const tasks = prev.dailyTasksState;
      const updatedTasks = tasks
        ? { ...tasks, counters: { ...tasks.counters, upgrade_tap: tasks.counters.upgrade_tap + 1 } }
        : tasks;
      return {
        ...prev,
        currency: prev.currency - cost,
        tapPower: prev.tapPower + 1,
        dailyTasksState: updatedTasks,
      };
    });

    return true;
  }, [state.currency, state.tapPower]);

  const addArtifactPart = useCallback((artifactId: string, isFull: boolean) => {
    setState(prev => {
      const newParts = { ...prev.artifactParts };
      const newCompleted = [...(prev.completedArtifacts || [])];
      const newDupes = { ...prev.artifactDupes };

      if (isFull) {
        if (newCompleted.includes(artifactId)) {
          // Duplicate of a completed artifact → buff it (+10% to base bonus per dupe)
          newDupes[artifactId] = (newDupes[artifactId] || 0) + 1;
        } else {
          newCompleted.push(artifactId);
        }
      } else if (newCompleted.includes(artifactId)) {
        // Part for an already-completed artifact → counts as a dupe
        newDupes[artifactId] = (newDupes[artifactId] || 0) + 1;
      } else {
        // Only add parts if artifact not already completed
        newParts[artifactId] = (newParts[artifactId] || 0) + 1;

        // Auto-complete when all parts collected
        const artifact = ARTIFACTS.find(a => a.id === artifactId);
        if (artifact && newParts[artifactId] >= artifact.parts) {
          newCompleted.push(artifactId);
        }
      }

      return { ...prev, artifactParts: newParts, completedArtifacts: newCompleted, artifactDupes: newDupes };
    });
  }, []);

  const deductGachaCost = useCallback((cost: number): boolean => {
    if (state.currency < cost) return false;
    setState(prev => ({ ...prev, currency: Math.max(0, prev.currency - cost) }));
    return true;
  }, [state.currency]);

  const recordGachaOpen = useCallback(() => {
    setState(prev => {
      const tasks = prev.dailyTasksState;
      if (!tasks) return prev;
      return {
        ...prev,
        dailyTasksState: {
          ...tasks,
          counters: { ...tasks.counters, open_gacha: tasks.counters.open_gacha + 1 },
        },
      };
    });
  }, []);

  const claimDailyTask = useCallback((taskId: string) => {
    const task = getTaskById(taskId);
    if (!task) return;

    setState(prev => {
      const tasks = prev.dailyTasksState;
      if (!tasks || tasks.claimed.includes(taskId)) return prev;
      if (tasks.counters[task.type] < task.target) return prev;

      const reward = task.reward;
      return {
        ...prev,
        currency: prev.currency + (reward.currency || 0),
        totalCurrencyEarned: prev.totalCurrencyEarned + (reward.currency || 0),
        xp: prev.xp + (reward.xp || 0),
        totalXp: prev.totalXp + (reward.xp || 0),
        dailyTasksState: {
          ...tasks,
          claimed: [...tasks.claimed, taskId],
        },
      };
    });
  }, []);

  const dismissStreakModal = useCallback(() => setStreakModal(null), []);
  const dismissConnectionError = useCallback(() => setConnectionError(null), []);

  const claimDailyReward = useCallback(() => {
    const today = getTodayDateStr();
    const yesterday = getYesterdayDateStr();

    setState(prev => {
      if (prev.lastCheckIn === today) return prev; // already claimed today

      let newStreak: number;
      if (!prev.lastCheckIn) {
        newStreak = 1;
      } else if (prev.lastCheckIn === yesterday) {
        newStreak = prev.checkInStreak + 1;
      } else {
        newStreak = 1; // missed a day — reset
      }

      // Import dynamically to avoid circular — but since it's a pure data module, import at top
      const dayInWeek = ((newStreak - 1) % 7) + 1;
      // Inline reward lookup to avoid importing component code here
      const REWARDS = [
        { day: 1, currency: 500,  xp: 0 },
        { day: 2, currency: 1000, xp: 200 },
        { day: 3, currency: 1500, xp: 400 },
        { day: 4, currency: 2000, xp: 600 },
        { day: 5, currency: 3000, xp: 800 },
        { day: 6, currency: 4000, xp: 1000 },
        { day: 7, currency: 5000, xp: 1500 },
      ];
      const reward = REWARDS.find(r => r.day === dayInWeek) || REWARDS[0];

      // For day 7 special: grant a gacha ticket by adding 100 currency equivalent
      const bonusCurrency = reward.currency + (dayInWeek === 7 ? 100 : 0);

      return {
        ...prev,
        lastCheckIn: today,
        checkInStreak: newStreak,
        currency: prev.currency + bonusCurrency,
        totalCurrencyEarned: prev.totalCurrencyEarned + bonusCurrency,
        xp: prev.xp + reward.xp,
        totalXp: prev.totalXp + reward.xp,
      };
    });

    setShowDailyRewards(false);
  }, []);

  const switchEpoch = useCallback((epochId: EpochId) => {
    if (!state.unlockedEpochs.includes(epochId)) return;
    setState(prev => ({ ...prev, epochId }));
    // Force immediate remote save for important state change
    saveRemoteState({ ...state, epochId }).catch(e => {
      console.error('switchEpoch remote save failed:', e);
      setSyncStatus('error');
      setConnectionError('Проблеми зі з\'єднанням. Прогрес збережеться локально');
    });
  }, [state.unlockedEpochs, state]);

  const loadLeaderboard = useCallback(async () => {
    setLeaderboardLoading(true);
    try {
      const data = await getLeaderboard(50);
      setLeaderboard(data);

      const telegramId = getTelegramUserId();
      if (telegramId) {
        const rank = await getUserRank(telegramId);
        setUserRank(rank);
      }
    } catch (e) {
      console.error('Failed to load leaderboard:', e);
      setConnectionError('Не вдалося завантажити таблицю лідерів');
    }
    setLeaderboardLoading(false);
  }, []);

  const dismissOfflineGains = useCallback(() => setOfflineGains(null), []);

  // Called after a successful Telegram Stars purchase to pull fresh boosters from DB
  const refreshBoosters = useCallback(async () => {
    const telegramIdLocal = getTelegramUserId();
    if (!telegramIdLocal) return;
    try {
      const fresh = await fetchActiveBoosters(telegramIdLocal);
      setState(prev => ({ ...prev, activeBoosters: fresh }));
    } catch (e) {
      console.error('Failed to refresh boosters:', e);
      setConnectionError('Не вдалося оновити бустери');
    }
  }, []);

  const rawTapCost = 25 * Math.pow(1.8, state.tapPower - 1);
  const tapPowerCost = Number.isFinite(rawTapCost) ? Math.floor(rawTapCost) : Number.MAX_SAFE_INTEGER;
  const telegramId = getTelegramUserId();
  const artifactMultipliers = getArtifactMultipliers(state.completedArtifacts || [], state.artifactDupes || {});
  const boosterMultipliers = getBoosterMultipliers(state.activeBoosters || {});

  return {
    state,
    epoch,
    tapEvents,
    tap,
    buyGenerator,
    upgradeTapPower,
    switchEpoch,
    tapPowerCost,
    addArtifactPart,
    deductGachaCost,
    recordGachaOpen,
    claimDailyTask,
    isLoading,
    telegramId,
    leaderboard,
    userRank,
    leaderboardLoading,
    loadLeaderboard,
    artifactMultipliers,
    boosterMultipliers,
    refreshBoosters,
    offlineGains,
    dismissOfflineGains,
    duplicateTab,
    streakModal,
    dismissStreakModal,
    syncStatus,
    connectionError,
    dismissConnectionError,
    showDailyRewards,
    claimDailyReward,
    skipDailyRewards: useCallback(() => setShowDailyRewards(false), []),
  };
}
