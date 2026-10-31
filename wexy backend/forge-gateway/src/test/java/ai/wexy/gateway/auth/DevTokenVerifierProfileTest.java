package ai.wexy.gateway.auth;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.reactive.server.WebTestClient;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * G2, M4 (forge-loop design §12): outside the local profile the dev verifier does not exist, and a
 * dev token is just another string Firebase refuses. The mutation that removes the profile condition
 * must fail this test.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class DevTokenVerifierProfileTest {

    @Autowired
    private ApplicationContext context;

    @Autowired
    private WebTestClient client;

    @Test
    void theDevVerifierDoesNotExistOutsideTheLocalProfile() {
        assertThat(context.getBeanNamesForType(DevTokenVerifier.class)).isEmpty();
        assertThat(context.getBean(FirebaseTokenVerifier.class)).isNotInstanceOf(DevTokenVerifier.class);
    }

    @Test
    void aDevTokenIsRefusedOutsideTheLocalProfile() {
        client.post().uri("/v1/forge/plan")
                .header(HttpHeaders.AUTHORIZATION, "Bearer dev.anonymous.x")
                .contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange()
                .expectStatus().isUnauthorized()
                .expectBody().json("{\"code\":\"auth\"}");
    }
}
