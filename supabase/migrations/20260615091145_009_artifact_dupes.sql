-- Add artifact_dupes column for tracking duplicate artifact bonuses
ALTER TABLE game_progress
  ADD COLUMN IF NOT EXISTS artifact_dupes jsonb NOT NULL DEFAULT '{}';
