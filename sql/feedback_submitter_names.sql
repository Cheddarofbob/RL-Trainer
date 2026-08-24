-- =========================================================
-- RL TRAINER
-- PRIVATE FEEDBACK SUBMITTER NAMES
-- =========================================================
-- Run in the Supabase SQL Editor as a project administrator.
--
-- This exposes only an in-game display name, only to an Admin/Owner, and
-- only for players who have actually submitted feedback. It does not expose
-- email addresses or other profile fields.

create or replace function public.get_feedback_submitter_names(target_user_ids uuid[])
returns table (
  user_id uuid,
  display_name text
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.is_admin_or_owner() then
    raise exception 'Admin access required.';
  end if;

  return query
  select p.user_id, p.display_name
  from public.profiles p
  where p.user_id = any(coalesce(target_user_ids, array[]::uuid[]))
    and exists (
      select 1
      from public.feedback f
      where f.user_id = p.user_id
    );
end;
$$;

revoke all on function public.get_feedback_submitter_names(uuid[]) from public, anon;
grant execute on function public.get_feedback_submitter_names(uuid[]) to authenticated;
