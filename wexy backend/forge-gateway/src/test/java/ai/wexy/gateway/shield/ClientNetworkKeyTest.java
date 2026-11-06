package ai.wexy.gateway.shield;

import org.junit.jupiter.api.Test;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;

import java.net.InetSocketAddress;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PL-T17's ipk (W1; the creations platform design §11): the network forge counts an anonymous
 * caller by is the address the gateway resolved, an IPv4 address whole and an IPv6 address's /64,
 * keyed, never readable back to an address, and never one a client can write.
 */
public class ClientNetworkKeyTest {

    /** A test key, not a secret; AuthorizationFilterTest mints with it too. */
    public static final String KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    static final String OTHER_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

    private static ClientNetworkKey key(String hex, int hops, String trustedHeader) {
        GatewayShieldProperties properties = new GatewayShieldProperties();
        properties.setTrustedProxyCount(hops);
        properties.setTrustedClientIpHeader(trustedHeader);
        return new ClientNetworkKey(new ClientAddressResolver(properties), hex, false);
    }

    private static MockServerWebExchange from(String peer, MockServerHttpRequest.BaseBuilder<?> builder) {
        return MockServerWebExchange.from(builder.remoteAddress(new InetSocketAddress(peer, 41234)).build());
    }

    private static String of(ClientNetworkKey key, String peer) {
        return key.of(from(peer, MockServerHttpRequest.post("/v1/agent/turn")));
    }

    @Test
    void anIpv4AddressIsCountedWholeAndKeyed() {
        ClientNetworkKey key = key(KEY, 0, "");

        String a = of(key, "203.0.113.42");
        assertThat(a).as("its family named, for forge's own limit (Q98)").matches("v4\\.[0-9a-f]{64}");
        assertThat(of(key, "203.0.113.42")).as("stable").isEqualTo(a);
        assertThat(of(key, "203.0.113.43")).as("the next address is another network").isNotEqualTo(a);
        assertThat(a).doesNotContain("203").doesNotContain("cb00712a");
        // Another key, another identity: what forge holds cannot be joined across deployments.
        assertThat(of(key(OTHER_KEY, 0, ""), "203.0.113.42")).isNotEqualTo(a);
    }

    @Test
    void anIpv6AddressIsCountedByItsSlash64() {
        ClientNetworkKey key = key(KEY, 0, "");

        String home = of(key, "2001:db8:abcd:12::1");
        assertThat(home).matches("v6\\.[0-9a-f]{64}");
        assertThat(of(key, "2001:db8:abcd:12:ffff:ffff:ffff:fffe")).as("the same /64").isEqualTo(home);
        assertThat(of(key, "2001:0db8:abcd:0012:0000:0000:0000:0007")).as("written out in full").isEqualTo(home);
        assertThat(of(key, "2001:db8:abcd:13::1")).as("the next /64").isNotEqualTo(home);
    }

    @Test
    void anIpv4MappedIpv6AddressIsItsIpv4Address() {
        ClientNetworkKey key = key(KEY, 0, "");

        assertThat(of(key, "::ffff:203.0.113.42")).isEqualTo(of(key, "203.0.113.42"));
        // A family byte keeps an IPv4 address and an IPv6 prefix with the same bytes apart.
        assertThat(ClientNetworkKey.network("203.0.113.42")).containsExactly(4, 203, 0, 113, 42);
        assertThat(ClientNetworkKey.network("cb00:712a::1")[0]).isEqualTo((byte) 6);
    }

    @Test
    void theTrustedHeaderIsReadAsTheResolverReadsIt() {
        ClientNetworkKey behindCloudflare = key(KEY, 1, "CF-Connecting-IP");

        String key = behindCloudflare.of(from("172.18.0.5", MockServerHttpRequest.post("/v1/agent/turn")
                .header("CF-Connecting-IP", "[2001:db8:abcd:12::9]")));
        assertThat(key).isEqualTo(of(key(KEY, 0, ""), "2001:db8:abcd:12::1"));
    }

    /** A client cannot choose its network: a header the gateway does not trust changes nothing. */
    @Test
    void aSpoofedForwardedForChangesNothing() {
        ClientNetworkKey key = key(KEY, 0, "");

        String spoofed = key.of(from("203.0.113.42", MockServerHttpRequest.post("/v1/agent/turn")
                .header("X-Forwarded-For", "198.51.100.1").header("CF-Connecting-IP", "198.51.100.1")));
        assertThat(spoofed).isEqualTo(of(key, "203.0.113.42"));
    }

    @Test
    void anAddressThatIsNotALiteralGivesNoKey() {
        ClientNetworkKey key = key(KEY, 0, "");

        assertThat(ClientNetworkKey.network("unknown")).isNull();
        assertThat(ClientNetworkKey.network("evil.example.com")).isNull();
        assertThat(ClientNetworkKey.network("")).isNull();
        assertThat(ClientNetworkKey.network(null)).isNull();
        assertThat(key.of(MockServerWebExchange.from(MockServerHttpRequest.post("/v1/agent/turn")))).as("no peer at all").isNull();
    }

    @Test
    void withoutAKeyNoRequestCarriesOne() {
        assertThat(of(key("", 0, ""), "203.0.113.42")).isNull();
        assertThat(of(key("   ", 0, ""), "203.0.113.42")).isNull();
    }

    /** Prod refuses to start without the key; a key that is not 32 bytes of hex refuses everywhere. */
    @Test
    void aMissingRequiredKeyOrABadKeyRefusesToStart() {
        assertThatThrownBy(() -> ClientNetworkKey.parse("", true)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("WEXY_IP_HMAC_KEY");
        assertThatThrownBy(() -> ClientNetworkKey.parse(KEY.substring(2), false)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("31 bytes");
        assertThatThrownBy(() -> ClientNetworkKey.parse("zz" + KEY.substring(2), false)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("not hexadecimal");
        assertThat(ClientNetworkKey.parse(KEY, true)).isNotNull();
        assertThat(ClientNetworkKey.parse(" " + KEY.toUpperCase() + " ", true)).as("trimmed, any case").isNotNull();
    }
}
