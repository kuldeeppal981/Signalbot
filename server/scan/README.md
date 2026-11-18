# Server scanner (Supabase Edge Function `scan`)
Files: index.ts (Deno entry), core.mjs (logic), engine.mjs (copy of app engine.js without zeroHero), test_scan.mjs (node test: `node test_scan.mjs`).
Secrets: UPSTOX_ANALYTICS_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (optional: INGEST_KEY, SCAN_SYMS, MAX_RISK_RS, TIER_B).
Schedule: pg_cron job `signalbot-scan`, `*/5 4-9 * * 1-5` (UTC), POST to /functions/v1/scan.
Tables: signals (source='server'), scan_log.
