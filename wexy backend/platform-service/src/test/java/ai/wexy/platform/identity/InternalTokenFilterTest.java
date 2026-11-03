package ai.wexy.platform.identity;

import ai.wexy.common.ErrorCode;
import ai.wexy.common.InternalToken;
import ai.wexy.platform.GatewayKeys;
import ai.wexy.platform.error.PlatformException;
import org.junit.jupiter.api.Test;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;

import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** W2: only the gateway's token for the platform, from a real account, makes a caller here. */
class InternalTokenFilterTest {

    private final GatewayKeys gateway = new GatewayKeys();
    private final GatewayKeys other = new GatewayKeys();
    private final InternalTokenFilter filter = new InternalTokenFilter(gateway.keySet());

    private final AtomicReference<ServerWebExchange> reached = new AtomicReference<>();
    private final WebFilterChain chain = exchange -> {
        reached.set(exchange);
        return Mono.empty();
    };

    private void get(String path, String token) {
        MockServerHttpRequest.BaseBuilder<?> request = MockServerHttpRequest.get(path);
        if (token != null) {
            request.header(InternalToken.HEADER, token);
        }
        filter.filter(MockServerWebExchange.from(request), chain).block();
    }

    private void refused(ErrorCode code, Runnable call) {
        assertThatThrownBy(call::run)
                .isInstanceOfSatisfying(PlatformException.class, e -> assertThat(e.code()).isEqualTo(code));
        assertThat(reached.get()).isNull();
    }

    @Test
    void thePlatformsTokenMakesTheCaller() {
        get("/v1/me", gateway.token("uid-1", false, true, InternalToken.AUDIENCE_PLATFORM));
        assertThat(PlatformCaller.of(reached.get())).isEqualTo(new PlatformCaller("uid-1", true, "google.com"));
    }

    @Test
    void forgesTokenNoAudienceAnotherKeyOrNoTokenIsRefused() {
        refused(ErrorCode.AUTH, () -> get("/v1/me", gateway.token("uid-1", false, false, InternalToken.AUDIENCE_FORGE)));
        refused(ErrorCode.AUTH, () -> get("/v1/me", gateway.token("uid-1", false, false, null)));
        refused(ErrorCode.AUTH, () -> get("/v1/me", other.account("uid-1")));
        refused(ErrorCode.AUTH, () -> get("/v1/me", null));
    }

    /** The gateway refuses an anonymous caller on every platform route; so does the platform, should one get through. */
    @Test
    void anAnonymousCallerIsAskedForAnAccount() {
        refused(ErrorCode.ACCOUNT_REQUIRED, () -> get("/v1/me", gateway.token("anon-1", true, false, InternalToken.AUDIENCE_PLATFORM)));
    }

    /**
     * Health, and §10's public rows (the showcase, profiles, publications and the waitlist: P, and the waitlist's own),
     * pass without a token, each by its method alone: the gateway sends them none (the independent W2 review: they were
     * 401 here, though the gateway's table calls them public). Until their stages they answer 404, as no handler serves
     * them. Everything else needs the platform's token.
     */
    @Test
    void healthAndThePublicRowsAloneAreReadWithoutAToken() {
        for (MockServerHttpRequest request : new MockServerHttpRequest[]{
                MockServerHttpRequest.get("/actuator/health").build(),
                MockServerHttpRequest.get("/v1/showcase").build(),
                MockServerHttpRequest.get("/v1/profiles/nova").build(),
                MockServerHttpRequest.get("/v1/profiles/nova/worlds").build(),
                MockServerHttpRequest.get("/v1/publications/01JC3W5F6Q7R8S9T0V1W2X3Y4Z").build(),
                MockServerHttpRequest.post("/v1/waitlist").build()}) {
            reached.set(null);
            filter.filter(MockServerWebExchange.from(request), chain).block();
            assertThat(reached.get()).as("%s %s", request.getMethod(), request.getPath()).isNotNull();
        }
        reached.set(null);
        refused(ErrorCode.AUTH, () -> filter.filter(MockServerWebExchange.from(MockServerHttpRequest.post("/actuator/health")), chain).block());
        refused(ErrorCode.AUTH, () -> filter.filter(MockServerWebExchange.from(MockServerHttpRequest.post("/v1/showcase")), chain).block());
        refused(ErrorCode.AUTH, () -> filter.filter(MockServerWebExchange.from(MockServerHttpRequest.get("/v1/waitlist")), chain).block());
        refused(ErrorCode.AUTH, () -> get("/v1/me", null));
        refused(ErrorCode.AUTH, () -> get("/v1/me/worlds", null));
        refused(ErrorCode.AUTH, () -> get("/v1/worlds/01JC3W5F6Q7R8S9T0V1W2X3Y4Z", null));
    }

    /** The mapping to 401 sits before the handlers: a handler's own failure is not an auth error. */
    @Test
    void aHandlersErrorIsNotTurnedIntoAnAuthRefusal() {
        WebFilterChain failing = exchange -> Mono.error(new IllegalStateException("a bug in a handler"));
        MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.get("/v1/me")
                .header(InternalToken.HEADER, gateway.account("uid-1")));
        assertThatThrownBy(() -> filter.filter(exchange, failing).block())
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("a bug in a handler");
    }
}
