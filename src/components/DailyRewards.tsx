import { useEffect, useState } from 'react';
import { X, Flame, Gift, Zap, Star } from 'lucide-react';
import { formatNumber } from '../lib/utils';
import { hapticNotification, hapticImpact } from '../lib/telegram';
import { getTodayDateStr, getYesterdayDateStr } from '../data/tasks';

export interface DailyReward {
  day: number;
  currency: number;
  xp: number;
  special?: 'gacha_ticket' | 'super_boost';
}

export const DAILY_REWARDS: DailyReward[] = [
  { day: 1, currency: 500,  xp: 0 },
  { day: 2, currency: 1000, xp: 200 },
  { day: 3, currency: 1500, xp: 400 },
  { day: 4, currency: 2000, xp: 600 },
  { day: 5, currency: 3000, xp: 800 },
  { day: 6, currency: 4000, xp: 1000 },
  { day: 7, currency: 5000, xp: 1500, special: 'gacha_ticket' },
];

export function getDailyReward(checkInStreak: number): DailyReward {
  const dayInWeek = ((checkInStreak - 1) % 7) + 1;
  return DAILY_REWARDS.find(r => r.day === dayInWeek) || DAILY_REWARDS[0];
}

export function shouldShowCheckIn(
  lastCheckIn: string | null,
  checkInStreak: number,
  lastLoginDate: string | null,
): boolean {
  const today = getTodayDateStr();
  const yesterday = getYesterdayDateStr();

  // Show check-in if player hasn't claimed today
  if (lastCheckIn === today) return false;

  // Only show if player has logged in today or yesterday (i.e. streak logic already ran)
  if (lastLoginDate === today || lastLoginDate === yesterday) return true;

  // Also show for brand-new players on their first day
  if (!lastCheckIn && lastLoginDate === today) return true;

  return false;
}

function specialLabel(special?: 'gacha_ticket' | 'super_boost'): string | null {
  if (special === 'gacha_ticket') return 'Гача-тикет';
  if (special === 'super_boost') return 'Супер бустер';
  return null;
}

function specialIcon(special?: 'gacha_ticket' | 'super_boost'): string {
  if (special === 'gacha_ticket') return '🎁';
  if (special === 'super_boost') return '🔥';
  return '';
}

interface DailyRewardsProps {
  checkInStreak: number;
  lastCheckIn: string | null;
  onClaim: () => void;
  onSkip: () => void;
}

export function DailyRewards({ checkInStreak, lastCheckIn, onClaim, onSkip }: DailyRewardsProps) {
  const [visible, setVisible] = useState(false);
  const [claimed, setClaimed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, []);

  const today = getTodayDateStr();
  const yesterday = getYesterdayDateStr();

  // Calculate the *next* reward the player will get upon claiming
  let nextStreak: number;
  if (!lastCheckIn) {
    nextStreak = 1;
  } else if (lastCheckIn === yesterday) {
    nextStreak = checkInStreak + 1;
  } else if (lastCheckIn !== today) {
    // Missed a day — streak resets
    nextStreak = 1;
  } else {
    nextStreak = checkInStreak;
  }

  const nextDayInWeek = ((nextStreak - 1) % 7) + 1;
  const nextReward = DAILY_REWARDS.find(r => r.day === nextDayInWeek) || DAILY_REWARDS[0];
  const alreadyClaimed = lastCheckIn === today;

  const handleClaim = () => {
    hapticNotification('success');
    setClaimed(true);
    setTimeout(() => {
      setVisible(false);
      setTimeout(onClaim, 250);
    }, 600);
  };

  const handleClose = () => {
    hapticImpact('light');
    setVisible(false);
    setTimeout(onSkip, 250);
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm transition-opacity duration-250 ${visible ? 'opacity-100' : 'opacity-0'}`}
      onClick={handleClose}
    >
      <div
        className={`relative w-full max-w-sm bg-gray-900 rounded-3xl overflow-hidden shadow-2xl border border-amber-500/40 transition-all duration-250 ${visible ? 'scale-100 opacity-100' : 'scale-90 opacity-0'}`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-gradient-to-b from-amber-500/20 to-transparent pt-8 pb-4 px-6 text-center">
          <div className="text-5xl mb-2">
            {claimed ? '✨' : nextReward.special === 'gacha_ticket' ? '🎁' : '📅'}
          </div>
          <h2 className="text-xl font-black text-white">
            {claimed ? 'Нагороду отримано!' : 'Щоденна нагорода'}
          </h2>
          {checkInStreak > 0 && !claimed && (
            <p className="text-sm text-amber-300 mt-1 font-medium">
              Серія: {checkInStreak} {streakWord(checkInStreak)} поспіль
            </p>
          )}
        </div>

        {/* 7-day reward track */}
        <div className="px-4 py-3">
          <div className="flex items-stretch gap-1.5">
            {DAILY_REWARDS.map((reward, i) => {
              const dayNum = i + 1;
              const isPastDay = dayNum < nextDayInWeek;
              const isCurrentDay = dayNum === nextDayInWeek;
              const isClaimed = alreadyClaimed ? dayNum <= nextDayInWeek : isPastDay;
              const isActive = isCurrentDay && !alreadyClaimed;

              return (
                <div
                  key={reward.day}
                  className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-xl transition-all ${
                    isActive
                      ? 'bg-amber-500/20 border-2 border-amber-400 scale-105 shadow-[0_0_10px_rgba(251,191,36,0.4)]'
                      : isClaimed
                      ? 'bg-green-900/20 border border-green-500/30'
                      : 'bg-gray-800 border border-gray-700/50'
                  }`}
                >
                  <div className={`text-xs font-bold ${isActive ? 'text-amber-400' : isClaimed ? 'text-green-400' : 'text-gray-500'}`}>
                    {reward.day}
                  </div>
                  {reward.special ? (
                    <div className="text-lg">{specialIcon(reward.special)}</div>
                  ) : (
                    <div className={`text-xs font-semibold ${isActive ? 'text-yellow-300' : isClaimed ? 'text-green-300' : 'text-gray-500'}`}>
                      {formatNumber(reward.currency)}
                    </div>
                  )}
                  {isClaimed && !isActive && (
                    <div className="text-[10px] text-green-400">✓</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Today's reward detail */}
        {!alreadyClaimed && (
          <div className="px-6 pb-3">
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
              <p className="text-xs text-gray-400 text-center mb-2 uppercase tracking-wider">
                День {nextDayInWeek} — Ваша нагорода
              </p>
              <div className="flex gap-3">
                {nextReward.currency > 0 && (
                  <div className="flex-1 bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-2.5 text-center">
                    <div className="text-xl font-black text-yellow-400">+{formatNumber(nextReward.currency)}</div>
                    <div className="text-xs text-gray-400 mt-0.5">Монет</div>
                  </div>
                )}
                {nextReward.xp > 0 && (
                  <div className="flex-1 bg-blue-500/10 border border-blue-500/20 rounded-xl p-2.5 text-center">
                    <div className="text-xl font-black text-blue-400">+{formatNumber(nextReward.xp)}</div>
                    <div className="text-xs text-gray-400 mt-0.5">XP</div>
                  </div>
                )}
              </div>
              {nextReward.special && (
                <div className="mt-3 bg-purple-500/10 border border-purple-500/20 rounded-xl p-2.5 text-center">
                  <div className="text-lg font-black text-purple-300">
                    + {specialLabel(nextReward.special)}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Buttons */}
        <div className="px-6 pb-6">
          {alreadyClaimed ? (
            <button
              onClick={handleClose}
              className="w-full py-3.5 bg-gray-700 text-gray-200 font-bold text-base rounded-2xl hover:bg-gray-600 active:scale-95 transition-all"
            >
              Закрити
            </button>
          ) : (
            <button
              onClick={handleClaim}
              className="w-full py-4 bg-gradient-to-r from-amber-500 to-yellow-400 text-black font-bold text-lg rounded-2xl hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-amber-500/30"
            >
              Отримати нагороду!
            </button>
          )}
        </div>

        {/* Streak info */}
        <div className="px-6 pb-4 text-center">
          <p className="text-xs text-gray-500">
            <Flame className="w-3 h-3 inline text-amber-500 mr-1" />
            Пропущений день скидає серію. День 7 — гарантований гача-тикет!
          </p>
        </div>

        <button
          onClick={handleClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function streakWord(n: number): string {
  if (n === 1) return 'день';
  if (n >= 2 && n <= 4) return 'дні';
  return 'днів';
}
