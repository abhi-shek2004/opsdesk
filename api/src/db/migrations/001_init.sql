-- OpsDesk initial schema.
-- Design notes:
--  * work_items.version is an optimistic-concurrency token for user-editable state.
--  * activity_events is append-only; it is written in the same transaction as the
--    change it describes, so history can never drift from the data.
--  * jobs is a transactional outbox / queue consumed with FOR UPDATE SKIP LOCKED.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  is_admin      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  key         text NOT NULL UNIQUE CHECK (key ~ '^[A-Z]{2,6}$'),
  next_number integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE team_role AS ENUM ('VIEWER', 'MEMBER', 'LEAD');

CREATE TABLE team_members (
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       team_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members(user_id);

-- Enum order matters: P1 < P2 < ... so ORDER BY priority puts the most urgent first.
CREATE TYPE item_priority AS ENUM ('P1', 'P2', 'P3', 'P4');
CREATE TYPE item_status AS ENUM (
  'OPEN', 'IN_PROGRESS', 'BLOCKED', 'PENDING_APPROVAL', 'RESOLVED', 'CLOSED', 'CANCELLED'
);
CREATE TYPE item_type AS ENUM (
  'INCIDENT', 'CUSTOMER_ISSUE', 'PAYMENT', 'ENGINEERING', 'COMPLIANCE', 'TASK'
);

CREATE TABLE work_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id           uuid NOT NULL REFERENCES teams(id),
  number            integer NOT NULL,
  key               text NOT NULL UNIQUE,
  type              item_type NOT NULL,
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description       text NOT NULL DEFAULT '',
  status            item_status NOT NULL DEFAULT 'OPEN',
  priority          item_priority NOT NULL DEFAULT 'P3',
  owner_id          uuid REFERENCES users(id),
  created_by        uuid NOT NULL REFERENCES users(id),
  requires_approval boolean NOT NULL DEFAULT false,
  approved_at       timestamptz,
  approved_by       uuid REFERENCES users(id),
  resolution        text,
  due_at            timestamptz,
  sla_breached_at   timestamptz,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  search            tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', key || ' ' || title), 'A') ||
    setweight(to_tsvector('english', description), 'B')
  ) STORED,
  UNIQUE (team_id, number),
  -- Workflow invariant enforced by the database as a last line of defence:
  -- work that is actively being progressed must have an owner.
  CONSTRAINT owned_when_active CHECK (
    status NOT IN ('IN_PROGRESS', 'BLOCKED', 'PENDING_APPROVAL') OR owner_id IS NOT NULL
  )
);

CREATE INDEX work_items_team_updated_idx ON work_items(team_id, updated_at DESC, id DESC);
CREATE INDEX work_items_team_status_prio_idx ON work_items(team_id, status, priority, created_at);
CREATE INDEX work_items_owner_status_idx ON work_items(owner_id, status) WHERE owner_id IS NOT NULL;
CREATE INDEX work_items_due_idx ON work_items(due_at)
  WHERE due_at IS NOT NULL AND status NOT IN ('RESOLVED', 'CLOSED', 'CANCELLED');
CREATE INDEX work_items_search_idx ON work_items USING GIN(search);

-- Append-only history (comments are events too, giving one unified timeline).
CREATE TABLE activity_events (
  id           bigserial PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  actor_id     uuid REFERENCES users(id), -- NULL = system
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_events_item_idx ON activity_events(work_item_id, id DESC);

CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  note         text,
  decided_by   uuid REFERENCES users(id),
  decision     text CHECK (decision IN ('APPROVED', 'REJECTED', 'WITHDRAWN')),
  reason       text,
  decided_at   timestamptz
);
-- At most one undecided approval request per item.
CREATE UNIQUE INDEX approvals_one_pending_idx ON approvals(work_item_id) WHERE decided_at IS NULL;

CREATE TABLE watchers (
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_item_id, user_id)
);
CREATE INDEX watchers_user_idx ON watchers(user_id);

CREATE TABLE notifications (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  event_id     bigint NOT NULL REFERENCES activity_events(id) ON DELETE CASCADE,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Makes notification delivery idempotent: a job that runs twice cannot double-notify.
  UNIQUE (user_id, event_id)
);
CREATE INDEX notifications_user_idx ON notifications(user_id, id DESC);
CREATE INDEX notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE idempotency_keys (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key             text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys(created_at);

CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE', 'DEAD')),
  attempts     integer NOT NULL DEFAULT 0,
  run_at       timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX jobs_pending_idx ON jobs(run_at, id) WHERE status = 'PENDING';
