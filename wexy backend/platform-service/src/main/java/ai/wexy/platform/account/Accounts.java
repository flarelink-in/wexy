package ai.wexy.platform.account;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.Ulid;
import ai.wexy.platform.error.PlatformException;
import ai.wexy.platform.identity.PlatformCaller;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Clock;
import java.time.Instant;
import java.util.List;

/**
 * What the account routes do (W2; the creations platform design §6, §10), as blocking calls the handler runs on the
 * database scheduler. The caller is always the gateway's verified one: no id, handle or field in a request picks whose
 * account is read or written (I1).
 *
 * <ul>
 *   <li>{@link #bootstrap}: the caller's account, made on first call: one per subject, whoever wins a race.</li>
 *   <li>{@link #read}: the caller's account, or 404 before the bootstrap; never made here.</li>
 *   <li>{@link #patchProfile}: an active account's profile at the version the caller read; a handle claimed once.</li>
 * </ul>
 */
public final class Accounts {

    private static final Logger log = LoggerFactory.getLogger(Accounts.class);

    /** What a bootstrap came to: the account, and whether this call made it (201) or found it (200). */
    public record Bootstrap(Account account, boolean created) {
    }

    private final AccountStore store;
    private final SubjectKey subjects;
    private final Handle handles;
    private final int policyVersion;
    private final Clock clock;

    public Accounts(AccountStore store, SubjectKey subjects, Handle handles, int policyVersion, Clock clock) {
        this.store = store;
        this.subjects = subjects;
        this.handles = handles;
        this.policyVersion = policyVersion;
        this.clock = clock;
    }

    public Bootstrap bootstrap(PlatformCaller caller) {
        List<String> lookups = subjects.lookups(caller.uid());
        var found = store.findBySubject(lookups);
        if (found.isPresent()) {
            return new Bootstrap(found.get(), false);
        }
        SubjectKey.Subject subject = subjects.current(caller.uid());
        Instant now = clock.instant();
        try {
            Account account = store.create(Ulid.next(now), subject.hmac(), subject.version(), policyVersion, now);
            log.info("account.created account={}", account.id());
            return new Bootstrap(account, true);
        } catch (AccountStore.SubjectTaken raced) {
            // Another call for this subject made it first: that one is the account.
            return new Bootstrap(store.findBySubject(lookups).orElseThrow(() ->
                    new PlatformException(ErrorCode.UNAVAILABLE, "Accounts are unavailable right now. Try again shortly.")), false);
        }
    }

    public Account read(PlatformCaller caller) {
        return store.findBySubject(subjects.lookups(caller.uid())).orElseThrow(() ->
                new PlatformException(ErrorCode.NOT_FOUND, "This account has not been set up yet."));
    }

    public Account patchProfile(PlatformCaller caller, ProfilePatch patch) {
        Account account = read(caller);
        // The W2 review: a change prepared for another account (another tab signed in meanwhile) is refused as a stale
        // read is: the studio reads again and sees whose account this is. The caller's own account is the only one
        // ever written; this id only says which one the creator meant.
        if (!account.id().equals(patch.accountId())) {
            throw new PlatformException(ErrorCode.CONFLICT, "This change was made for another account. Read it again.");
        }
        if (account.status() != Account.Status.ACTIVE) {
            log.info("account.refused account={} status={} route=profile", account.id(), account.status());
            throw new PlatformException(ErrorCode.FORBIDDEN, "This account can't make changes right now.");
        }
        Account.Profile current = account.profile();
        // Before the handle's rule: a second tab's claim after the first's is a stale read (409: read again and see the
        // handle), not a change of a claimed handle (400). The store's compare-and-set below decides any race after.
        if (patch.expectedVersion() != current.rowVersion()) {
            throw stale();
        }
        String handle = current.handle();
        if (patch.handle() != null) {
            String wanted = handles.normalize(patch.handle());
            if (handle != null && !handle.equals(wanted)) {
                throw new PlatformException(ErrorCode.BAD_REQUEST, "A handle can't be changed once claimed.");
            }
            handle = wanted;
        }
        String displayName = patch.displayName().or(current.displayName());
        String bio = patch.bio().or(current.bio());
        switch (store.writeProfile(account.id(), patch.expectedVersion(), handle, displayName, bio, clock.instant())) {
            case WRITTEN -> {
                return new Account(account.id(), account.status(), account.policyVersion(),
                        new Account.Profile(handle, displayName, bio, current.publicEnabled(), patch.expectedVersion() + 1));
            }
            case HANDLE_TAKEN -> throw new PlatformException(ErrorCode.CONFLICT, "That handle is taken. Try another.");
            default -> throw stale();
        }
    }

    private static PlatformException stale() {
        return new PlatformException(ErrorCode.CONFLICT, "This profile changed since it was read. Read it again.");
    }
}
