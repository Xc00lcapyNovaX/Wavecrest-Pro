-- Baseline: the reports table as it exists in production today.
CREATE TABLE IF NOT EXISTS reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id        text NOT NULL,
  channel_name      text NOT NULL,
  channel_handle    text,
  channel_thumbnail text,
  subscriber_count  bigint,
  video_count       int,
  analysis          jsonb NOT NULL,
  created_at        timestamptz DEFAULT now()
);
