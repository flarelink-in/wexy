package ai.wexy.gateway.shield;

import org.junit.jupiter.api.Test;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;

import java.net.InetSocketAddress;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Copied from FlareLink's ClientAddressResolverTest (pre-existing work). Plain unit tests: the
 * resolver is configured per case, because the point is how it behaves under configurations the
 * test profile does not use.
 */
class ClientAddressResolverTest {

    private static ClientAddressResolver resolver(int hops, String trustedHeader) {
        GatewayShieldProperties properties = new GatewayShieldProperties();
        properties.setTrustedProxyCount(hops);
        properties.setTrustedClientIpHeader(trustedHeader);
        return new ClientAddressResolver(properties);
    }

    private static MockServerWebExchange exchange(String peer, MockServerHttpRequest.BaseBuilder<?> builder) {
        return MockServerWebExchange.from(builder.remoteAddress(new InetSocketAddress(peer, 41234)).build());
    }

    /** nginx resolves the client with realip and writes it as the only X-Forwarded-For entry. */
    @Test
    void singleForwardedEntryWrittenByTheProxyIsTheClient() {
        String ip = resolver(1, "").resolve(exchange("172.18.0.5",
                MockServerHttpRequest.get("/v1/forge/mode").header("X-Forwarded-For", "203.0.113.42")));

        assertThat(ip).isEqualTo("203.0.113.42");
    }

    @Test
    void trustedHeaderIsIgnoredUntilConfigured() {
        String ip = resolver(1, "").resolve(exchange("172.18.0.5",
                MockServerHttpRequest.get("/v1/forge/mode")
                        .header("CF-Connecting-IP", "9.9.9.9")
                        .header("X-Forwarded-For", "203.0.113.42")));

        assertThat(ip).isEqualTo("203.0.113.42");
    }

    @Test
    void trustedHeaderWinsOverForwardedChainWhenConfigured() {
        String ip = resolver(1, "CF-Connecting-IP").resolve(exchange("172.18.0.5",
                MockServerHttpRequest.get("/v1/forge/mode")
                        .header("CF-Connecting-IP", "198.51.100.7")
                        .header("X-Forwarded-For", "203.0.113.42")));

        assertThat(ip).isEqualTo("198.51.100.7");
    }

    /** A list means something upstream appended, so guessing an end would invent a hop count. */
    @Test
    void trustedHeaderCarryingAListFallsBackToForwardedChain() {
        String ip = resolver(1, "CF-Connecting-IP").resolve(exchange("172.18.0.5",
                MockServerHttpRequest.get("/v1/forge/mode")
                        .header("CF-Connecting-IP", "1.2.3.4, 198.51.100.7")
                        .header("X-Forwarded-For", "203.0.113.42")));

        assertThat(ip).isEqualTo("203.0.113.42");
    }

    /** Junk must never become a Redis key, and must never trigger a DNS lookup. */
    @Test
    void trustedHeaderThatIsNotAnAddressFallsBackToForwardedChain() {
        String ip = resolver(1, "CF-Connecting-IP").resolve(exchange("172.18.0.5",
                MockServerHttpRequest.get("/v1/forge/mode")
                        .header("CF-Connecting-IP", "evil.example.com")
                        .header("X-Forwarded-For", "203.0.113.42")));

        assertThat(ip).isEqualTo("203.0.113.42");
    }

    @Test
    void trustedHeaderAcceptsIpv6IncludingBracketedForm() {
        assertThat(resolver(1, "CF-Connecting-IP").resolve(exchange("172.18.0.5",
                MockServerHttpRequest.get("/v1/forge/mode")
                        .header("CF-Connecting-IP", "2606:4700:4700::1111"))))
                .isEqualTo("2606:4700:4700::1111");

        assertThat(resolver(1, "CF-Connecting-IP").resolve(exchange("172.18.0.5",
                MockServerHttpRequest.get("/v1/forge/mode")
                        .header("CF-Connecting-IP", "[2606:4700:4700::1111]"))))
                .isEqualTo("[2606:4700:4700::1111]");
    }

    @Test
    void socketAddressIsUsedWhenNoProxyIsTrusted() {
        String ip = resolver(0, "").resolve(exchange("203.0.113.9",
                MockServerHttpRequest.get("/v1/forge/mode").header("X-Forwarded-For", "1.2.3.4")));

        assertThat(ip).isEqualTo("203.0.113.9");
    }

    /** Resolution happens once per request; later header edits cannot change the key. */
    @Test
    void resolvedAddressIsCachedOnTheExchange() {
        ClientAddressResolver resolver = resolver(1, "CF-Connecting-IP");
        MockServerWebExchange exchange = exchange("172.18.0.5",
                MockServerHttpRequest.get("/v1/forge/mode").header("CF-Connecting-IP", "198.51.100.7"));

        assertThat(resolver.resolve(exchange)).isEqualTo("198.51.100.7");
        assertThat(exchange.getAttributes().get(ClientAddressResolver.CLIENT_IP_ATTRIBUTE))
                .isEqualTo("198.51.100.7");
        assertThat(resolver.resolve(exchange)).isEqualTo("198.51.100.7");
    }
}
