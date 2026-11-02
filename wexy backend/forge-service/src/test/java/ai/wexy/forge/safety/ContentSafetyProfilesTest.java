package ai.wexy.forge.safety;

import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.Profile;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * A deployment can never run on recorded verdicts (W1, PL-T18): the recorded safety is the local and test profiles'
 * alone, as the dev tokens are local's alone (the gateway's DevTokenVerifierProfileTest), and Azure's everywhere else,
 * where a missing endpoint or key stops startup.
 */
class ContentSafetyProfilesTest {

    @Test
    void theRecordedSafetyIsLocalAndTestsAloneAndAzureEverywhereElse() {
        assertThat(RecordedContentSafety.class.getAnnotation(Profile.class).value()).containsExactlyInAnyOrder("local", "test");
        assertThat(AzureContentSafety.class.getAnnotation(Profile.class).value()).containsExactly("!local & !test");
    }
}
