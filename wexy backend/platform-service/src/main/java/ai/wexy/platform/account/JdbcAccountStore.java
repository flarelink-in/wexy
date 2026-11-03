package ai.wexy.platform.account;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Supplier;

/**
 * The accounts in MariaDB (W2; V1__accounts.sql). Uniqueness is the database's: {@code account.subject_hmac} makes a
 * concurrent bootstrap of one subject create one account, and {@code profile.handle_normalized} lets one account hold
 * a handle (PL-T3). A profile write is a compare-and-set on {@code row_version} that also requires the account to be
 * active and the handle unset or unchanged, so no interleaving changes a claimed handle or writes over a newer version.
 * Times are UTC, stored as {@code DATETIME(3)}.
 *
 * Writers racing for one unique value (a handle, a subject) can deadlock in InnoDB's unique-index locks; it rolls one
 * back whole as the victim (error 1213). Found by the concurrent-claim test (W2 review round): the victim's request
 * would have been 503 instead of "taken". A victim is tried again, a few times, after a short random pause: its next
 * try sees what the winner committed, so it is refused as taken (or stale) as any loser is.
 */
@Component
public class JdbcAccountStore implements AccountStore {

    /** A deadlock's victim is tried this many times in all before its error stands (503). */
    static final int DEADLOCK_ATTEMPTS = 4;

    private static final String SELECT = """
            SELECT a.id, a.status, a.policy_version,
                   p.handle_normalized, p.display_name, p.bio, p.public_enabled, p.row_version
              FROM account a
              JOIN profile p ON p.account_id = a.id
            """;

    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;

    public JdbcAccountStore(JdbcClient jdbc, PlatformTransactionManager transactions) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactions);
    }

    @Override
    public Optional<Account> findBySubject(List<String> subjectHmacs) {
        if (subjectHmacs.isEmpty()) {
            return Optional.empty();
        }
        return jdbc.sql(SELECT + " WHERE a.subject_hmac IN (:subjects)")
                .param("subjects", subjectHmacs)
                .query(JdbcAccountStore::account)
                .optional();
    }

    @Override
    public Account create(String id, String subjectHmac, int keyVersion, int policyVersion, Instant now) {
        LocalDateTime at = LocalDateTime.ofInstant(now, ZoneOffset.UTC);
        try {
            retryingDeadlocks(() -> transactions.execute(status -> {
                jdbc.sql("""
                                INSERT INTO account (id, subject_hmac, hmac_key_version, status, policy_version, created_at, updated_at)
                                VALUES (:id, :subject, :keyVersion, 'ACTIVE', :policyVersion, :at, :at)
                                """)
                        .param("id", id).param("subject", subjectHmac).param("keyVersion", keyVersion)
                        .param("policyVersion", policyVersion).param("at", at)
                        .update();
                jdbc.sql("""
                                INSERT INTO profile (account_id, public_enabled, row_version, updated_at)
                                VALUES (:id, FALSE, 0, :at)
                                """)
                        .param("id", id).param("at", at)
                        .update();
                return null;
            }));
        } catch (DuplicateKeyException raced) {
            throw new SubjectTaken();
        }
        return new Account(id, Account.Status.ACTIVE, policyVersion, new Account.Profile(null, null, null, false, 0));
    }

    @Override
    public Write writeProfile(String accountId, long expectedVersion, String handle, String displayName, String bio,
                              Instant now) {
        try {
            int rows = retryingDeadlocks(() -> jdbc.sql("""
                            UPDATE profile
                               SET handle_normalized = :handle, display_name = :displayName, bio = :bio,
                                   row_version = row_version + 1, updated_at = :at
                             WHERE account_id = :id
                               AND row_version = :expected
                               AND (handle_normalized IS NULL OR handle_normalized = :handle)
                               AND account_id IN (SELECT id FROM account WHERE id = :id AND status = 'ACTIVE')
                            """)
                    .param("handle", handle).param("displayName", displayName).param("bio", bio)
                    .param("at", LocalDateTime.ofInstant(now, ZoneOffset.UTC))
                    .param("id", accountId).param("expected", expectedVersion)
                    .update());
            return rows == 1 ? Write.WRITTEN : Write.STALE;
        } catch (DuplicateKeyException taken) {
            return Write.HANDLE_TAKEN;
        }
    }

    /** `write`, tried again while InnoDB makes it a deadlock's victim, up to {@link #DEADLOCK_ATTEMPTS} times in all. */
    private static <T> T retryingDeadlocks(Supplier<T> write) {
        for (int attempt = 1; ; attempt++) {
            try {
                return write.get();
            } catch (PessimisticLockingFailureException deadlock) {
                if (attempt >= DEADLOCK_ATTEMPTS) {
                    throw deadlock;
                }
                try {
                    Thread.sleep(ThreadLocalRandom.current().nextLong(5, 20L * attempt));
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw deadlock;
                }
            }
        }
    }

    private static Account account(ResultSet row, int index) throws SQLException {
        return new Account(
                row.getString("id"),
                Account.Status.valueOf(row.getString("status")),
                row.getInt("policy_version"),
                new Account.Profile(
                        row.getString("handle_normalized"),
                        row.getString("display_name"),
                        row.getString("bio"),
                        row.getBoolean("public_enabled"),
                        row.getLong("row_version")));
    }
}
