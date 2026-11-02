package ai.wexy.forge.allowance;

import ai.wexy.forge.identity.Caller;
import ai.wexy.forge.spend.SpendGuard;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** A caller's role, from the gateway's token alone (W1; the creations platform design §6, Q95), and the lane it is charged to. */
class RoleTest {

    @Test
    void theRoleComesFromTheTokenAndChoosesTheLane() {
        assertThat(Role.of(new Caller("u", true, false, "anonymous", "n"))).isEqualTo(Role.ANONYMOUS);
        assertThat(Role.of(new Caller("u", false, false, "google.com", "n"))).isEqualTo(Role.EARLY_ACCESS);
        assertThat(Role.of(new Caller("u", false, true, "google.com", "n"))).isEqualTo(Role.ADMIN);

        assertThat(Role.ANONYMOUS.lane()).isEqualTo(SpendGuard.LANE_ANONYMOUS);
        assertThat(Role.EARLY_ACCESS.lane()).isEqualTo(SpendGuard.LANE_EARLY_ACCESS);
        assertThat(Role.ADMIN.lane()).isEqualTo(SpendGuard.LANE_ADMIN);
        assertThat(Role.ANONYMOUS.label()).isEqualTo("Free");
        assertThat(Role.EARLY_ACCESS.label()).isEqualTo("Early access");
        assertThat(Role.ADMIN.label()).as("an admin is shown as early access").isEqualTo("Early access");
    }

    /** The safe direction: an anonymous token is anonymous even if its uid is on the allow-list. */
    @Test
    void anAnonymousTokenIsNeverAdmin() {
        assertThat(Role.of(new Caller("u", true, true, "anonymous", "n"))).isEqualTo(Role.ANONYMOUS);
    }
}
