CREATE TABLE canvases (
  tenant_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  layout TEXT NOT NULL,
  visible INTEGER NOT NULL,
  active_chart_id TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, org_id, user_id, session_id),
  CHECK (layout IN ('grid-2x2', 'grid-3x2', 'flex')),
  CHECK (visible IN (0, 1)),
  CHECK (revision >= 0)
);

CREATE TABLE queries (
  tenant_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  language TEXT NOT NULL,
  datasource_uid TEXT NOT NULL,
  expression TEXT NOT NULL,
  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL,
  step_seconds INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, org_id, user_id, session_id, query_id, version),
  FOREIGN KEY (tenant_id, org_id, user_id, session_id)
    REFERENCES canvases (tenant_id, org_id, user_id, session_id) ON DELETE CASCADE,
  CHECK (language = 'promql'),
  CHECK (version >= 1),
  CHECK (step_seconds > 0),
  CHECK (range_to > range_from)
);

CREATE TABLE charts (
  tenant_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  chart_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  query_id TEXT NOT NULL,
  query_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  visualization TEXT NOT NULL,
  viz_config_json TEXT NOT NULL,
  publish_operation_id TEXT NOT NULL,
  publish_request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, org_id, user_id, session_id, chart_id),
  UNIQUE (tenant_id, org_id, user_id, session_id, publish_operation_id),
  FOREIGN KEY (tenant_id, org_id, user_id, session_id)
    REFERENCES canvases (tenant_id, org_id, user_id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, org_id, user_id, session_id, query_id, query_version)
    REFERENCES queries (tenant_id, org_id, user_id, session_id, query_id, version),
  CHECK (revision >= 1),
  CHECK (query_version >= 1),
  CHECK (visualization = 'timeseries'),
  CHECK (json_valid(viz_config_json)),
  CHECK (json_type(viz_config_json) = 'object')
);

CREATE TABLE canvas_items (
  tenant_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  chart_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, org_id, user_id, session_id, chart_id),
  UNIQUE (tenant_id, org_id, user_id, session_id, position),
  FOREIGN KEY (tenant_id, org_id, user_id, session_id)
    REFERENCES canvases (tenant_id, org_id, user_id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, org_id, user_id, session_id, chart_id)
    REFERENCES charts (tenant_id, org_id, user_id, session_id, chart_id) ON DELETE CASCADE,
  CHECK (position >= 0)
);

CREATE INDEX queries_session ON queries (tenant_id, org_id, user_id, session_id, query_id, version);
CREATE INDEX charts_session ON charts (tenant_id, org_id, user_id, session_id, created_at, chart_id);
