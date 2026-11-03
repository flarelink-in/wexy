package ai.wexy.platform.account;

import ai.wexy.common.ErrorCode;
import ai.wexy.platform.error.PlatformException;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** W2's handle rules (the creations platform design §6): one stored form per handle, look-alikes refused, names reserved. */
class HandleTest {

    private final Handle handles = Handle.reservedFromResource();

    @Test
    void aHandleIsStoredLowercaseSoItsCasesAreOneHandle() {
        assertThat(handles.normalize("Nova_7")).isEqualTo("nova_7");
        assertThat(handles.normalize("NOVA_7")).isEqualTo("nova_7");
        assertThat(handles.normalize("abc")).isEqualTo("abc");
        assertThat(handles.normalize("a".repeat(30))).hasSize(30);
    }

    /** Refused, never mapped: a fullwidth, dotted or accented letter is how a look-alike handle is made. */
    @Test
    void anythingOutsideAsciiLettersDigitsAndUnderscoresIsRefused() {
        for (String handle : List.of("ab", "a".repeat(31), "no va", "nova!", "nova.x", "növa", "ｎｏｖａ", "novaİ", "novа",
                "nova\n", "")) {
            assertThatThrownBy(() -> handles.normalize(handle)).as(handle)
                    .isInstanceOfSatisfying(PlatformException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.BAD_REQUEST));
        }
        assertThatThrownBy(() -> handles.normalize(null)).isInstanceOf(PlatformException.class);
    }

    @Test
    void theProductsAndStaffsNamesAreReservedInAnyCase() {
        for (String handle : List.of("admin", "ADMIN", "support", "moderator", "showcase", "creations", "wexy", "Wexy_Team",
                "wexyofficial", "studio", "null")) {
            assertThatThrownBy(() -> handles.normalize(handle)).as(handle)
                    .isInstanceOfSatisfying(PlatformException.class, e -> assertThat(e.getMessage()).contains("reserved"));
        }
        assertThat(handles.normalize("my_wexy")).as("only a leading wexy is reserved").isEqualTo("my_wexy");
        assertThat(handles.normalize("admiral")).isEqualTo("admiral");
    }
}
