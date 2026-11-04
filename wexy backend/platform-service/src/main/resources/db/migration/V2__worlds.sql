-- W3: saved worlds (the creations platform design §5, §7). The bytes of each world live in the private B2 bucket; these
-- rows say whose they are, which revision is a world's head, what the account holds and reserves, which saves are under
-- way (idempotency), and what must still be deleted from B2. The platform's schema alone. Ids are ULIDs, hashes
-- lowercase hex, times UTC; every state column is a closed set.

-- A world: its owner, its title (renamed without a new revision), its head and its version, which every change moves on
-- by one (a save's compare-and-set, a rename's).
CREATE TABLE creation (
    id               CHAR(26)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    owner_id         CHAR(26)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    title            VARCHAR(120) NOT NULL,
    -- Null only inside the transaction that makes the world with its first revision.
    head_revision_id CHAR(26)     CHARACTER SET ascii COLLATE ascii_bin NULL,
    status           VARCHAR(10)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    row_version      BIGINT       NOT NULL DEFAULT 0,
    created_at       DATETIME(3)  NOT NULL,
    updated_at       DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    -- The history: an owner's active worlds, the newest made first.
    KEY creation_owner_made (owner_id, status, created_at, id),
    CONSTRAINT creation_owner FOREIGN KEY (owner_id) REFERENCES account (id),
    CONSTRAINT creation_status CHECK (status IN ('ACTIVE', 'DELETING', 'DELETED')),
    CONSTRAINT creation_row_version CHECK (row_version >= 0),
    CONSTRAINT creation_id_shape CHECK (id REGEXP '(?-i)^[0-9A-HJKMNP-TV-Z]{26}$')
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

-- An object in a B2 bucket, from its reservation to its confirmed deletion. Its key is generated, never a client's. Its
-- bytes are charged to its owner as reserved until its revision commits, then as used, until B2 confirms the delete.
CREATE TABLE stored_object (
    id           CHAR(26)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    owner_id     CHAR(26)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    operation_id CHAR(26)     CHARACTER SET ascii COLLATE ascii_bin NULL,
    bucket       VARCHAR(10)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    kind         VARCHAR(10)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    object_key   VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sha256       CHAR(64)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    bytes        BIGINT       NOT NULL,
    media_type   VARCHAR(80)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    -- B2's version id of the bytes, once written: a delete by it erases them, not a newer version.
    version_id   VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NULL,
    state        VARCHAR(16)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    -- Which counter holds its bytes: RESERVED until its revision commits, USED after, NONE once deleted.
    charge       VARCHAR(10)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at   DATETIME(3)  NOT NULL,
    updated_at   DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY stored_object_key (bucket, object_key),
    KEY stored_object_state (state, updated_at),
    KEY stored_object_operation (operation_id),
    CONSTRAINT stored_object_owner FOREIGN KEY (owner_id) REFERENCES account (id),
    CONSTRAINT stored_object_bucket CHECK (bucket IN ('PRIVATE', 'ASSETS')),
    CONSTRAINT stored_object_kind CHECK (kind IN ('ARTIFACT', 'POSTER')),
    CONSTRAINT stored_object_state_set CHECK (state IN ('RESERVED', 'READY', 'DELETE_PENDING', 'DELETED')),
    CONSTRAINT stored_object_charge CHECK (charge IN ('RESERVED', 'USED', 'NONE')),
    CONSTRAINT stored_object_bytes CHECK (bytes >= 0),
    CONSTRAINT stored_object_sha_shape CHECK (sha256 REGEXP '(?-i)^[0-9a-f]{64}$')
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

-- A committed revision: a row exists only once its bytes are in B2 and its head moved (I3). Its object's state says
-- whether it is still retained (READY), or queued for deletion.
CREATE TABLE revision (
    id              CHAR(26)      CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    creation_id     CHAR(26)      CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    artifact_id     CHAR(26)      CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    artifact_format VARCHAR(40)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    line            VARCHAR(32)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sha256          CHAR(64)      CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    bytes           INT           NOT NULL,
    pins_json       VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at      DATETIME(3)   NOT NULL,
    PRIMARY KEY (id),
    -- For the head's same-world check below.
    UNIQUE KEY revision_world (creation_id, id),
    UNIQUE KEY revision_artifact (artifact_id),
    CONSTRAINT revision_creation FOREIGN KEY (creation_id) REFERENCES creation (id),
    CONSTRAINT revision_object FOREIGN KEY (artifact_id) REFERENCES stored_object (id),
    CONSTRAINT revision_bytes CHECK (bytes > 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

-- A world's head is one of its own revisions, never another world's.
ALTER TABLE creation
    ADD CONSTRAINT creation_head FOREIGN KEY (id, head_revision_id) REFERENCES revision (creation_id, id);

-- What an account holds and reserves; the environment's row is the account id of 26 zeros, which no ULID is. A save
-- locks the environment's row, then the account's, always in that order.
CREATE TABLE storage_usage (
    owner_id         CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    used_bytes       BIGINT   NOT NULL DEFAULT 0,
    reserved_bytes   BIGINT   NOT NULL DEFAULT 0,
    used_objects     INT      NOT NULL DEFAULT 0,
    reserved_objects INT      NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id),
    CONSTRAINT storage_usage_counts CHECK (used_bytes >= 0 AND reserved_bytes >= 0 AND used_objects >= 0 AND reserved_objects >= 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

INSERT INTO storage_usage (owner_id) VALUES ('00000000000000000000000000');

-- An idempotent request (§7): one row per (owner, route, key), its request's hash, its state, and once it has one, the
-- answer a retry gets: a status and a bounded DTO, never the request's body. Kept a day.
CREATE TABLE operation (
    id              CHAR(26)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    owner_id        CHAR(26)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    route           VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    idempotency_key VARCHAR(64)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash    CHAR(64)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    state           VARCHAR(10)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    response_status SMALLINT     NULL,
    response_json   TEXT         NULL,
    created_at      DATETIME(3)  NOT NULL,
    updated_at      DATETIME(3)  NOT NULL,
    expires_at      DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY operation_key (owner_id, route, idempotency_key),
    KEY operation_state (state, updated_at),
    KEY operation_owner_state (owner_id, state),
    KEY operation_expiry (expires_at),
    CONSTRAINT operation_owner FOREIGN KEY (owner_id) REFERENCES account (id),
    CONSTRAINT operation_state_set CHECK (state IN ('PENDING', 'DONE', 'FAILED')),
    CONSTRAINT operation_key_shape CHECK (idempotency_key REGEXP '(?-i)^[A-Za-z0-9-]{16,64}$'),
    CONSTRAINT operation_hash_shape CHECK (request_hash REGEXP '(?-i)^[0-9a-f]{64}$')
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

-- Work that must outlive a request (I8): an object to delete from B2, a deleted world to finish. One job per target and
-- action; a worker claims it under a lease with a fencing token, and a repeated delete or a missing object is success.
CREATE TABLE cleanup_job (
    id              CHAR(26)    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    kind            VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_id       CHAR(26)    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    state           VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    attempts        INT         NOT NULL DEFAULT 0,
    next_attempt_at DATETIME(3) NOT NULL,
    lease_token     CHAR(26)    CHARACTER SET ascii COLLATE ascii_bin NULL,
    lease_until     DATETIME(3) NULL,
    created_at      DATETIME(3) NOT NULL,
    updated_at      DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY cleanup_job_target (kind, target_id),
    KEY cleanup_job_due (state, next_attempt_at),
    CONSTRAINT cleanup_job_kind CHECK (kind IN ('OBJECT_DELETE', 'WORLD_FINISH')),
    CONSTRAINT cleanup_job_state CHECK (state IN ('PENDING', 'RUNNING', 'RETRY', 'DONE')),
    CONSTRAINT cleanup_job_attempts CHECK (attempts >= 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;
