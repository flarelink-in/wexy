package ai.wexy.platform.account;

/**
 * An account as its owner sees it (W2; the creations platform design §5): its public id, never the Firebase uid or
 * its HMAC; its status; the terms' version it was made under; and its profile.
 */
public record Account(String id, Status status, int policyVersion, Profile profile) {

    /** The closed set of the {@code account.status} column. W2 makes ACTIVE accounts; W5 the rest. */
    public enum Status { ACTIVE, SUSPENDED, DELETING, DELETED }

    /**
     * A profile: private until its owner makes it public (W4); a handle claimed once and never reissued.
     *
     * @param rowVersion every write's expected version: a write based on another one is a 409
     */
    public record Profile(String handle, String displayName, String bio, boolean publicEnabled, long rowVersion) {
    }
}
