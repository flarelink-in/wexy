package ai.wexy.platform.account;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * Where accounts live (W2): MariaDB's {@code account} and {@code profile} tables ({@link JdbcAccountStore}), or a
 * test's map that keeps the same rules. Every method blocks: callers run it on the database scheduler. The database
 * decides every race: one account per subject, one owner per handle, one write per profile version.
 */
public interface AccountStore {

    /** What a profile write came to. */
    enum Write {
        WRITTEN,
        /** The profile is not at the expected version any more, or its account is not active. */
        STALE,
        /** Another account holds the handle. */
        HANDLE_TAKEN
    }

    /** The subject already has an account: a concurrent bootstrap made it first. */
    final class SubjectTaken extends RuntimeException {
        public SubjectTaken() {
            super("This subject has an account already.", null, false, false);
        }
    }

    /** The account any of these subject HMACs belongs to, if one does. */
    Optional<Account> findBySubject(List<String> subjectHmacs);

    /**
     * A new active account with an empty, private profile at version 0, both in one transaction.
     *
     * @throws SubjectTaken when the subject has an account already: nothing is written
     */
    Account create(String id, String subjectHmac, int keyVersion, int policyVersion, Instant now);

    /**
     * Writes the whole profile text if, and only if, the profile is still at {@code expectedVersion}, its account is
     * active, and its handle is unset or already {@code handle}; the version then moves on by one.
     */
    Write writeProfile(String accountId, long expectedVersion, String handle, String displayName, String bio, Instant now);
}
