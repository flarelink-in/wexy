package ai.wexy.gateway.shield;

import ai.wexy.common.InternalToken;
import io.netty.util.NetUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.HexFormat;

/**
 * The caller's network as forge's allowances count it (W1; the creations platform design §11): the
 * address {@link ClientAddressResolver} resolved, an IPv4 address whole and an IPv6 address cut to
 * its /64, HMAC-SHA256'd under the network key ({@code WEXY_IP_HMAC_KEY}). It travels in the
 * internal token as {@link InternalToken#CLAIM_IPK}: signed, so a client cannot choose it, and
 * hashed, so forge never sees an address. An IPv6 /64 is one network (a home or a phone gets one
 * whole), so an address-hopping client inside it is still one caller.
 *
 * <p>Fails closed. Without a key, or for an address that is not a literal ({@code unknown}), there
 * is no claim, and forge grants an anonymous caller no prompt. Production refuses to start without
 * the key ({@code wexy.network-key.required}); a key that is not 32 bytes of hex refuses everywhere,
 * since a short or mistyped key is a misconfiguration, never a choice. The key is not rotated on
 * deploy: a new key gives every network a new identity, and so a fresh day of anonymous prompts.
 */
@Component
public class ClientNetworkKey {

    private static final Logger log = LoggerFactory.getLogger(ClientNetworkKey.class);
    private static final String ALGORITHM = "HmacSHA256";
    static final int KEY_BYTES = 32;

    private final ClientAddressResolver resolver;
    /** Null when no key is configured: no request then carries a network key. */
    private final SecretKeySpec key;

    public ClientNetworkKey(ClientAddressResolver resolver,
                            @Value("${wexy.network-key.hmac-hex:}") String hex,
                            @Value("${wexy.network-key.required:false}") boolean required) {
        this.resolver = resolver;
        this.key = parse(hex, required);
    }

    /** The network key of the client that sent this request, or null when there is none to give. */
    public String of(ServerWebExchange exchange) {
        if (key == null) {
            return null;
        }
        byte[] network = network(resolver.resolve(exchange));
        return network == null ? null : hmac(network);
    }

    /** The key, checked: 32 bytes as 64 hex characters, or none at all where none is required. */
    static SecretKeySpec parse(String hex, boolean required) {
        String value = hex == null ? "" : hex.trim();
        if (value.isEmpty()) {
            if (required) {
                throw new IllegalStateException("wexy.network-key.hmac-hex (WEXY_IP_HMAC_KEY) is not set: without it no "
                        + "anonymous caller can be counted, so the gateway refuses to start. Set 32 random bytes as 64 hex characters.");
            }
            log.warn("No network key (wexy.network-key.hmac-hex): requests carry no ipk, so forge grants anonymous callers no prompt.");
            return null;
        }
        byte[] bytes;
        try {
            bytes = HexFormat.of().parseHex(value);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("wexy.network-key.hmac-hex is not hexadecimal: set 32 random bytes as 64 hex characters.");
        }
        if (bytes.length != KEY_BYTES) {
            throw new IllegalStateException("wexy.network-key.hmac-hex holds " + bytes.length + " bytes; it must hold "
                    + KEY_BYTES + " (64 hex characters).");
        }
        return new SecretKeySpec(bytes, ALGORITHM);
    }

    /**
     * What is counted: a family byte (4 or 6), then the IPv4 address's four bytes or the IPv6
     * address's first eight. An IPv4-mapped IPv6 address ({@code ::ffff:a.b.c.d}) is its IPv4
     * address, so one client is one network whichever way its socket reports it. Null for anything
     * that is not an address literal; never a lookup.
     */
    static byte[] network(String address) {
        if (address == null) {
            return null;
        }
        String literal = address.trim();
        if (literal.length() > 1 && literal.charAt(0) == '[' && literal.charAt(literal.length() - 1) == ']') {
            literal = literal.substring(1, literal.length() - 1);
        }
        int zone = literal.indexOf('%');
        if (zone >= 0) {
            literal = literal.substring(0, zone);
        }
        if (!NetUtil.isValidIpV4Address(literal) && !NetUtil.isValidIpV6Address(literal)) {
            return null;
        }
        byte[] bytes = NetUtil.createByteArrayFromIpAddressString(literal);
        if (bytes == null) {
            return null;
        }
        if (bytes.length == 16 && isV4Mapped(bytes)) {
            bytes = Arrays.copyOfRange(bytes, 12, 16);
        }
        byte[] out = new byte[1 + (bytes.length == 4 ? 4 : 8)];
        out[0] = (byte) (bytes.length == 4 ? 4 : 6);
        System.arraycopy(bytes, 0, out, 1, out.length - 1);
        return out;
    }

    private static boolean isV4Mapped(byte[] v6) {
        for (int i = 0; i < 10; i++) {
            if (v6[i] != 0) {
                return false;
            }
        }
        return v6[10] == (byte) 0xff && v6[11] == (byte) 0xff;
    }

    private String hmac(byte[] network) {
        try {
            Mac mac = Mac.getInstance(ALGORITHM);
            mac.init(key);
            return HexFormat.of().formatHex(mac.doFinal(network));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is always present", e);
        }
    }
}
