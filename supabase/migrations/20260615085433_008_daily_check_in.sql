-- Add daily check-in fields to game_progress
ALTER TABLE game_progress
  ADD COLUMN IF NOT EXISTS last_check_in date,
  ADD COLUMN IF NOT EXISTS current_streak integer NOT NULL DEFAULT 0;

-- Backfill existing users: set current_streak from active_boosters._daily.streak
UPDATE game_progress
SET
  current_streak = COALESCE((active_boosters->'_daily'->>'streak')::integer, 0),
  last_check_in = COALESCE((active_boosters->'_daily'->>'lastDate')::date, NULL)
WHERE last_check_in IS NULL;
