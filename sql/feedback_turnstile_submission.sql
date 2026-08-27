-- =========================================================
-- RL TRAINER
-- TURNSTILE-PROTECTED FEEDBACK SUBMISSION
-- =========================================================
-- Run ONLY after the submit-feedback Edge Function is deployed and its
-- TURNSTILE_SECRET_KEY secret is configured. The function inserts with the
-- service role after server-side Turnstile validation.
--
-- This intentionally leaves normal users able to read their own feedback
-- through existing RLS. It only removes browser-side direct INSERT access.

revoke insert on table public.feedback from anon, authenticated;

-- Keep the vetted server-side submission path working. The service-role key
-- remains confined to the Edge Function and is never available in browser code.
grant insert on table public.feedback to service_role;
