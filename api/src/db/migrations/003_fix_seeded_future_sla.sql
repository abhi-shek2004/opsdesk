-- Data fix for the demo seed: it marked work with *future* due dates as SLA-breached
-- and wrote SLA_BREACHED history events dated in the future. Real breaches are stamped
-- with now() by the worker when the deadline passes, so a breach timestamp in the future
-- can only be this seed artifact. (Notifications for those events cascade-delete.)
DELETE FROM activity_events WHERE type = 'SLA_BREACHED' AND created_at > now();
UPDATE work_items SET sla_breached_at = NULL WHERE sla_breached_at > now();
