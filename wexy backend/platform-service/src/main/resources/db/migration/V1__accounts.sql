-- W2: accounts and their profiles (the creations platform design §5). The platform's schema alone: no other service
-- reads or writes it, and no foreign key leaves it. Ids are ULIDs, hashes lowercase hex, times UTC; every state column
-- is a closed set. No Firebase uid and no email is stored: an account is found by the HMAC of its subject.

CREATE TABLE account (
    id               CHAR(26)    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    subject_hmac     CHAR(64)    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    hmac_key_version SMALLINT    NOT NULL,
    status           VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    policy_version   INT         NOT NULL,
    created_at       DATETIME(3) NOT NULL,
    updated_at       DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    -- One account per subject: a concurrent bootstrap of one subject inserts once (PL-T3).
    UNIQUE KEY account_subject (subject_hmac),
    CONSTRAINT account_status CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETING', 'DELETED')),
    CONSTRAINT account_key_version CHECK (hmac_key_version > 0),
    CONSTRAINT account_id_shape CHECK (id REGEXP '(?-i)^[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT account_subject_shape CHECK (subject_hmac REGEXP '(?-i)^[0-9a-f]{64}$')
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

CREATE TABLE profile (
    account_id        CHAR(26)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    -- Null until claimed; stored lowercase, compared byte for byte, so one handle has one owner whatever its case.
    -- After a deletion (W5) the row keeps it, so a handle is never reissued.
    handle_normalized VARCHAR(30)  CHARACTER SET ascii COLLATE ascii_bin NULL,
    display_name      VARCHAR(50)  NULL,
    bio               VARCHAR(280) NULL,
    -- Private until its owner makes it public, which comes with the showcase (W4).
    public_enabled    BOOLEAN      NOT NULL DEFAULT FALSE,
    row_version       BIGINT       NOT NULL DEFAULT 0,
    updated_at        DATETIME(3)  NOT NULL,
    PRIMARY KEY (account_id),
    UNIQUE KEY profile_handle (handle_normalized),
    CONSTRAINT profile_account FOREIGN KEY (account_id) REFERENCES account (id),
    CONSTRAINT profile_handle_shape CHECK (handle_normalized IS NULL OR handle_normalized REGEXP '(?-i)^[a-z0-9_]{3,30}$'),
    CONSTRAINT profile_row_version CHECK (row_version >= 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;
