package ai.wexy.gateway.shield;

import io.netty.util.NetUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cloud.gateway.support.ipresolver.RemoteAddressResolver;
import org.springframework.cloud.gateway.support.ipresolver.XForwardedRemoteAddressResolver;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;

import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The single source of truth for "who is this request from". Every limit keys off it, so it must
 * not be something the client can choose.
 *
 * Copied from FlareLink's ClientAddressResolver (pre-existing work); only names changed. Two
 * sources, in order:
 *
 * 1. {@code wexy.shield.trusted-client-ip-header}, when configured: behind Cloudflare,
 *    CF-Connecting-IP, which Cloudflare sets to the true client and strips from inbound requests.
 *    One address, no hop counting.
 * 2. X-Forwarded-For. With {@code trusted-proxy-count} 0 the TCP peer is used; with N, the Nth
 *    entry from the right: the address the gateway's own proxy wrote.
 *
 * A wrong hop count fails silently (every visitor shares a proxy's bucket), so the first
 * resolution of each process is logged. Both sources assume the origin is reachable only through
 * the proxy chain: keep it firewalled to Cloudflare. The result is cached on the exchange.
 */
@Component
public class ClientAddressResolver {

    public static final String CLIENT_IP_ATTRIBUTE = "wexy.shield.clientIp";

    private static final Logger log = LoggerFactory.getLogger(ClientAddressResolver.class);
    private static final String UNKNOWN = "unknown";
    private static final String X_FORWARDED_FOR = "X-Forwarded-For";

    private final RemoteAddressResolver delegate;

    /** Null when none is configured, so the check costs one null test per request. */
    private final String trustedClientIpHeader;

    private final AtomicBoolean loggedFirstResolution = new AtomicBoolean();

    public ClientAddressResolver(GatewayShieldProperties properties) {
        String header = properties.getTrustedClientIpHeader();
        this.trustedClientIpHeader = (header == null || header.isBlank()) ? null : header.trim();

        int hops = properties.getTrustedProxyCount();
        if (hops > 0) {
            this.delegate = XForwardedRemoteAddressResolver.maxTrustedIndex(hops);
        } else {
            this.delegate = new RemoteAddressResolver() {
            };
        }

        if (this.trustedClientIpHeader != null) {
            log.info("Client addresses resolved from the {} header, falling back to X-Forwarded-For trusting "
                            + "{} proxy hop(s). Safe only while the origin refuses connections that did not "
                            + "arrive through the proxy setting that header.",
                    this.trustedClientIpHeader, hops);
        } else if (hops > 0) {
            log.info("Client addresses resolved from X-Forwarded-For, trusting {} proxy hop(s)", hops);
        } else {
            log.info("Client addresses resolved from the socket address (X-Forwarded-For is not trusted). "
                    + "Set wexy.shield.trusted-proxy-count if a proxy sits in front of the gateway.");
        }
    }

    public String resolve(ServerWebExchange exchange) {
        Object cached = exchange.getAttributes().get(CLIENT_IP_ATTRIBUTE);
        if (cached instanceof String ip) {
            return ip;
        }

        String ip = fromTrustedHeader(exchange);
        if (ip == null) {
            ip = fromForwardedChain(exchange);
        }

        logFirstResolution(exchange, ip);
        exchange.getAttributes().put(CLIENT_IP_ATTRIBUTE, ip);
        return ip;
    }

    /**
     * The address in the configured trusted header, or null to fall through. A comma means
     * something upstream has been appending to a single-value header, and guessing which end is
     * real would be inventing a hop count, so it falls through too.
     */
    private String fromTrustedHeader(ServerWebExchange exchange) {
        if (trustedClientIpHeader == null) {
            return null;
        }
        String value = exchange.getRequest().getHeaders().getFirst(trustedClientIpHeader);
        if (value == null) {
            return null;
        }
        value = value.trim();
        if (value.isEmpty() || value.indexOf(',') >= 0) {
            return null;
        }
        return isIpLiteral(value) ? value : null;
    }

    private String fromForwardedChain(ServerWebExchange exchange) {
        String ip = UNKNOWN;
        try {
            InetSocketAddress address = delegate.resolve(exchange);
            if (address != null) {
                ip = address.getAddress() != null
                        ? address.getAddress().getHostAddress()
                        : address.getHostString();
            }
        } catch (RuntimeException e) {
            // A malformed X-Forwarded-For degrades to one shared bucket, never to an error.
            log.debug("Could not resolve the client address, falling back to '{}'", UNKNOWN, e);
        }
        if (ip == null || ip.isBlank()) {
            ip = UNKNOWN;
        }
        return ip;
    }

    /**
     * Netty rather than InetAddress: {@code InetAddress.getByName} resolves anything that is not a
     * literal, which would turn a junk header into a DNS lookup on the request path.
     */
    private static boolean isIpLiteral(String value) {
        String candidate = value;
        // Some proxies bracket IPv6 literals, and Netty's check does not accept brackets.
        if (candidate.length() > 1 && candidate.charAt(0) == '['
                && candidate.charAt(candidate.length() - 1) == ']') {
            candidate = candidate.substring(1, candidate.length() - 1);
        }
        return NetUtil.isValidIpV4Address(candidate) || NetUtil.isValidIpV6Address(candidate);
    }

    /**
     * Logs the raw inputs and the resolved address once per process. If 'resolved' is not a
     * plausible visitor address, the configuration does not match the deployment.
     */
    private void logFirstResolution(ServerWebExchange exchange, String resolved) {
        if (!loggedFirstResolution.compareAndSet(false, true)) {
            return;
        }
        InetSocketAddress peer = exchange.getRequest().getRemoteAddress();
        log.info("Client address on the first request of this process: resolved={}, {}={}, {}={}, socketPeer={}. "
                        + "If 'resolved' is a proxy address rather than a real visitor, "
                        + "wexy.shield.trusted-proxy-count does not match the deployment.",
                resolved,
                trustedClientIpHeader == null ? "(no trusted header configured)" : trustedClientIpHeader,
                trustedClientIpHeader == null ? "-" : exchange.getRequest().getHeaders().getFirst(trustedClientIpHeader),
                X_FORWARDED_FOR,
                exchange.getRequest().getHeaders().get(X_FORWARDED_FOR),
                peer == null ? "-" : peer.getHostString());
    }
}
