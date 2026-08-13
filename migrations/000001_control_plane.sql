-- +goose Up
CREATE TABLE services (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    org_id text NOT NULL,
    folder_uid text NOT NULL,
    name text NOT NULL,
    labels jsonb NOT NULL DEFAULT '{}'::jsonb,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, org_id, folder_uid, name)
);

CREATE TABLE knowledge_bases (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    org_id text NOT NULL,
    folder_uid text NOT NULL,
    name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, org_id, folder_uid, name)
);

CREATE TABLE knowledge_documents (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    org_id text NOT NULL,
    knowledge_base_id text NOT NULL REFERENCES knowledge_bases(id),
    name text NOT NULL,
    media_type text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'indexing', 'ready', 'failed', 'disabled')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_sessions (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    org_id text NOT NULL,
    owner_user_id text NOT NULL,
    folder_uid text,
    title text NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'archived', 'busy')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE playbook_refs (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    org_id text NOT NULL,
    folder_uid text,
    name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE playbook_run_refs (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    org_id text NOT NULL,
    playbook_id text NOT NULL REFERENCES playbook_refs(id),
    status text NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled')),
    last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_collections (
    knowledge_base_id text PRIMARY KEY REFERENCES knowledge_bases(id),
    provider text NOT NULL,
    provider_id text NOT NULL,
    sync_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_id)
);

CREATE TABLE provider_documents (
    document_id text PRIMARY KEY REFERENCES knowledge_documents(id),
    provider text NOT NULL,
    provider_id text NOT NULL,
    sync_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_id)
);

CREATE TABLE provider_agent_sessions (
    session_id text PRIMARY KEY REFERENCES agent_sessions(id),
    provider text NOT NULL,
    provider_id text NOT NULL,
    sync_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_id)
);

CREATE TABLE provider_playbooks (
    playbook_id text PRIMARY KEY REFERENCES playbook_refs(id),
    provider text NOT NULL,
    provider_id text NOT NULL,
    sync_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_id)
);

CREATE TABLE provider_playbook_runs (
    run_id text PRIMARY KEY REFERENCES playbook_run_refs(id),
    provider text NOT NULL,
    provider_id text NOT NULL,
    sync_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_id)
);

CREATE TABLE approval_refs (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    org_id text NOT NULL,
    actor_user_id text NOT NULL,
    subject_type text NOT NULL CHECK (subject_type IN ('agent_turn', 'playbook_run')),
    subject_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    trace_id text NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE operation_idempotency (
    tenant_id text NOT NULL,
    org_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash bytea NOT NULL,
    resource_id text,
    status text NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
    trace_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, org_id, actor_user_id, operation, idempotency_key)
);

CREATE INDEX services_scope_idx ON services (tenant_id, org_id, folder_uid, updated_at DESC, id);
CREATE INDEX knowledge_bases_scope_idx ON knowledge_bases (tenant_id, org_id, folder_uid, updated_at DESC, id);
CREATE INDEX knowledge_documents_parent_idx ON knowledge_documents (tenant_id, org_id, knowledge_base_id, updated_at DESC, id);
CREATE INDEX agent_sessions_owner_idx ON agent_sessions (tenant_id, org_id, owner_user_id, updated_at DESC, id);
CREATE INDEX playbook_refs_scope_idx ON playbook_refs (tenant_id, org_id, folder_uid, updated_at DESC, id);
CREATE INDEX playbook_run_refs_parent_idx ON playbook_run_refs (tenant_id, org_id, playbook_id, updated_at DESC, id);
CREATE INDEX approval_refs_subject_idx ON approval_refs (tenant_id, org_id, subject_type, subject_id, updated_at DESC);
CREATE INDEX operation_idempotency_expiry_idx ON operation_idempotency (expires_at);

-- +goose Down
DROP TABLE IF EXISTS operation_idempotency;
DROP TABLE IF EXISTS approval_refs;
DROP TABLE IF EXISTS provider_playbook_runs;
DROP TABLE IF EXISTS provider_playbooks;
DROP TABLE IF EXISTS provider_agent_sessions;
DROP TABLE IF EXISTS provider_documents;
DROP TABLE IF EXISTS provider_collections;
DROP TABLE IF EXISTS playbook_run_refs;
DROP TABLE IF EXISTS playbook_refs;
DROP TABLE IF EXISTS agent_sessions;
DROP TABLE IF EXISTS knowledge_documents;
DROP TABLE IF EXISTS knowledge_bases;
DROP TABLE IF EXISTS services;
