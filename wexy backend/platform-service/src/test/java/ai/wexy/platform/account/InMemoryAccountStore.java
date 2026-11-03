package ai.wexy.platform.account;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The account store's rules in a map (W2), for the route tests: one account per subject, one owner per handle, a
 * profile write only at its version, for an active account, without changing a claimed handle. JdbcAccountStoreTest
 * holds MariaDB to the same rules.
 */
final class InMemoryAccountStore implements AccountStore {

    private final Map<String, String> idBySubject = new HashMap<>();
    private final Map<String, Account> accounts = new HashMap<>();

    @Override
    public synchronized Optional<Account> findBySubject(List<String> subjectHmacs) {
        return subjectHmacs.stream().map(idBySubject::get).filter(id -> id != null).findFirst().map(accounts::get);
    }

    @Override
    public synchronized Account create(String id, String subjectHmac, int keyVersion, int policyVersion, Instant now) {
        if (idBySubject.containsKey(subjectHmac)) {
            throw new SubjectTaken();
        }
        Account account = new Account(id, Account.Status.ACTIVE, policyVersion, new Account.Profile(null, null, null, false, 0));
        idBySubject.put(subjectHmac, id);
        accounts.put(id, account);
        return account;
    }

    @Override
    public synchronized Write writeProfile(String accountId, long expectedVersion, String handle, String displayName,
                                           String bio, Instant now) {
        Account account = accounts.get(accountId);
        if (account == null || account.status() != Account.Status.ACTIVE || account.profile().rowVersion() != expectedVersion
                || (account.profile().handle() != null && !account.profile().handle().equals(handle))) {
            return Write.STALE;
        }
        boolean taken = handle != null && accounts.values().stream()
                .anyMatch(other -> !other.id().equals(accountId) && handle.equals(other.profile().handle()));
        if (taken) {
            return Write.HANDLE_TAKEN;
        }
        Account.Profile p = account.profile();
        accounts.put(accountId, new Account(accountId, account.status(), account.policyVersion(),
                new Account.Profile(handle, displayName, bio, p.publicEnabled(), p.rowVersion() + 1)));
        return Write.WRITTEN;
    }

    synchronized int size() {
        return accounts.size();
    }

    synchronized Account get(String id) {
        return accounts.get(id);
    }

    /** A test's suspension (W5 makes the real ones). */
    synchronized void setStatus(String id, Account.Status status) {
        Account a = accounts.get(id);
        accounts.put(id, new Account(id, status, a.policyVersion(), a.profile()));
    }
}
