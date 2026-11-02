package ai.wexy.forge.allowance;

import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.spend.SpendGuard;

/**
 * Who a caller is to the allowances and the spend lanes (W1; the creations platform design §6, §11,
 * Q95), from the internal token the gateway signed and never from a request field: an anonymous
 * Firebase user, an admin (a uid on the gateway's allow-list), or anyone else signed in, who has
 * early access. A role chooses its allowance and its lane; what the allowance says is visible to
 * its own caller only (I13).
 */
public enum Role {

    ANONYMOUS(SpendGuard.LANE_ANONYMOUS, "Free"),
    EARLY_ACCESS(SpendGuard.LANE_EARLY_ACCESS, "Early access"),
    /** Admins answer as early access, with their own number: the label says what the studio offers, not who is privileged. */
    ADMIN(SpendGuard.LANE_ADMIN, "Early access");

    private final String lane;
    private final String label;

    Role(String lane, String label) {
        this.lane = lane;
        this.label = label;
    }

    /**
     * The caller's role. An anonymous token is anonymous whatever else it says: the safe direction,
     * since an anonymous uid on the allow-list would be a configuration slip, never a privilege.
     */
    public static Role of(Caller caller) {
        if (caller.anonymous()) {
            return ANONYMOUS;
        }
        return caller.admin() ? ADMIN : EARLY_ACCESS;
    }

    /** The spend lane every call of this role is charged to. */
    public String lane() {
        return lane;
    }

    /** What the studio's chip calls this allowance. */
    public String label() {
        return label;
    }
}
