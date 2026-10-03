-- Dashboard counters only look at active work. Closed work grows forever, active
-- work stays roughly constant, so a partial index keeps the dashboard's cost tied
-- to "how much is in flight" rather than "how much history exists".
CREATE INDEX work_items_active_dashboard_idx
  ON work_items(team_id, priority, owner_id, due_at)
  WHERE status IN ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'PENDING_APPROVAL');
