package ai.wexy.platform.account;

import ai.wexy.common.ErrorCode;
import ai.wexy.platform.error.PlatformException;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** W2's subject key (the creations platform design §5): the uid never stored, the key checked, its absence never quiet. */
class SubjectKeyTest {

    private static final String KEY = AccountRoutesTest.KEY;
    private static final String OTHER = "6f746865726f746865726f746865726f746865726f746865726f746865726f74";

    @Test
    void aSubjectIsTheHmacOfTheUidUnderItsVersion() {
        SubjectKey.Subject subject = new SubjectKey(KEY, 1, true).current("uid-1");
        assertThat(subject.hmac()).matches("[0-9a-f]{64}").doesNotContain("uid-1");
        assertThat(subject.version()).isEqualTo(1);
        assertThat(new SubjectKey(KEY, 1, true).current("uid-1")).isEqualTo(subject);
        assertThat(new SubjectKey(KEY, 1, true).lookups("uid-1")).containsExactly(subject.hmac());
        // Another key, another hash: forge's uid key and this one cannot be joined.
        assertThat(new SubjectKey(OTHER, 1, true).current("uid-1").hmac()).isNotEqualTo(subject.hmac());
        assertThat(new SubjectKey(KEY, 1, true).current("uid-2").hmac()).isNotEqualTo(subject.hmac());
    }

    @Test
    void aKeyThatIsNot32BytesOfHexStopsStartup() {
        assertThatThrownBy(() -> new SubjectKey("not hex", 1, false)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new SubjectKey("abcd", 1, false)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new SubjectKey(KEY + "00", 1, false)).isInstanceOf(IllegalStateException.class);
    }

    /** Prod refuses to start without a key; elsewhere every account call is 503, never an account keyed by nothing. */
    @Test
    void noKeyStopsProdAndMakesAccountsUnavailableElsewhere() {
        assertThatThrownBy(() -> new SubjectKey("", 1, true)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new SubjectKey(null, 1, true)).isInstanceOf(IllegalStateException.class);
        SubjectKey none = new SubjectKey("  ", 1, false);
        assertThatThrownBy(() -> none.current("uid-1"))
                .isInstanceOfSatisfying(PlatformException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.UNAVAILABLE));
        assertThatThrownBy(() -> none.lookups("uid-1")).isInstanceOf(PlatformException.class);
    }
}
