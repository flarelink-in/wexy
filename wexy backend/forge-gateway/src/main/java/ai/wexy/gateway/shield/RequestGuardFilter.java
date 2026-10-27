package ai.wexy.gateway.shield;

import ai.wexy.common.ErrorCode;
import ai.wexy.gateway.error.ErrorResponses;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.core.io.buffer.DataBufferUtils;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.http.server.reactive.ServerHttpRequestDecorator;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Caps how much of the gateway one client can occupy at once.
 *
 * Adapted from FlareLink's RequestGuardFilter (pre-existing work): one body limit (no upload
 * routes), and Wexy's envelope. Rate limits bound how often requests arrive; they do nothing about
 * a client that opens hundreds of connections and trickles bytes, or streams a huge body. So:
 *  - a per-client and per-instance in-flight ceiling (a bulkhead);
 *  - a body ceiling enforced from Content-Length and while streaming, since a chunked upload can
 *    omit the header.
 */
@Component
public class RequestGuardFilter implements WebFilter, Ordered {

    private static final Logger log = LoggerFactory.getLogger(RequestGuardFilter.class);

    private static final Set<HttpMethod> BODY_METHODS = Set.of(HttpMethod.POST, HttpMethod.PUT, HttpMethod.PATCH);

    private final ClientAddressResolver addressResolver;
    private final GatewayShieldProperties properties;

    private final ConcurrentHashMap<String, Integer> inFlightPerClient = new ConcurrentHashMap<>();
    private final AtomicInteger inFlightTotal = new AtomicInteger();
    private final AtomicLong lastSaturationLogMillis = new AtomicLong();

    public RequestGuardFilter(ClientAddressResolver addressResolver, GatewayShieldProperties properties) {
        this.addressResolver = addressResolver;
        this.properties = properties;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        if (!properties.isEnabled()) {
            return chain.filter(exchange);
        }

        ServerWebExchange guarded = applyBodyLimit(exchange);
        if (guarded == null) {
            return ErrorResponses.write(exchange, ErrorCode.TOO_LARGE,
                    "The request body exceeds the " + properties.getBody().getMaxBytes() + " byte limit.", 0);
        }

        GatewayShieldProperties.Concurrency concurrency = properties.getConcurrency();
        if (!concurrency.isEnabled()) {
            return chain.filter(guarded);
        }

        String clientIp = addressResolver.resolve(guarded);
        Acquisition acquisition = acquire(clientIp, concurrency);
        if (acquisition == Acquisition.INSTANCE_SATURATED) {
            logSaturation(clientIp);
            return ErrorResponses.write(guarded, ErrorCode.UNAVAILABLE,
                    "The gateway is at capacity. Please retry shortly.", 2);
        }
        if (acquisition == Acquisition.CLIENT_SATURATED) {
            return ErrorResponses.write(guarded, ErrorCode.RATE,
                    "Too many concurrent requests from this client.", 1);
        }

        return chain.filter(guarded).doFinally(signal -> release(clientIp));
    }

    private enum Acquisition { ACQUIRED, CLIENT_SATURATED, INSTANCE_SATURATED }

    private Acquisition acquire(String clientIp, GatewayShieldProperties.Concurrency concurrency) {
        if (inFlightTotal.incrementAndGet() > concurrency.getMaxInFlightTotal()) {
            inFlightTotal.decrementAndGet();
            return Acquisition.INSTANCE_SATURATED;
        }

        boolean[] accepted = new boolean[1];
        inFlightPerClient.compute(clientIp, (key, current) -> {
            int held = current == null ? 0 : current;
            if (held >= concurrency.getMaxInFlightPerClient()) {
                accepted[0] = false;
                return current;
            }
            accepted[0] = true;
            return held + 1;
        });

        if (!accepted[0]) {
            inFlightTotal.decrementAndGet();
            return Acquisition.CLIENT_SATURATED;
        }
        return Acquisition.ACQUIRED;
    }

    private void release(String clientIp) {
        inFlightTotal.decrementAndGet();
        // Removing the entry at zero keeps the map bounded by concurrent clients rather than by
        // every client that ever connected.
        inFlightPerClient.computeIfPresent(clientIp, (key, held) -> held <= 1 ? null : held - 1);
    }

    private void logSaturation(String clientIp) {
        long now = System.currentTimeMillis();
        long last = lastSaturationLogMillis.get();
        if (now - last > 5_000 && lastSaturationLogMillis.compareAndSet(last, now)) {
            log.warn("Instance in-flight ceiling of {} reached (most recent client: {})",
                    properties.getConcurrency().getMaxInFlightTotal(), clientIp);
        }
    }

    /**
     * @return the exchange to continue with, or null when Content-Length already proves the body is
     * too large and the request can be refused without reading it.
     */
    private ServerWebExchange applyBodyLimit(ServerWebExchange exchange) {
        GatewayShieldProperties.Body body = properties.getBody();
        if (!body.isEnabled() || !BODY_METHODS.contains(exchange.getRequest().getMethod())) {
            return exchange;
        }

        long limit = body.getMaxBytes();
        long declared = exchange.getRequest().getHeaders().getContentLength();
        if (declared > limit) {
            return null;
        }
        if (declared >= 0) {
            // Netty enforces the declared length, so no streaming check is needed.
            return exchange;
        }

        // Chunked or unknown length: count bytes as they arrive and abort past the ceiling.
        ServerHttpRequest counting = new ServerHttpRequestDecorator(exchange.getRequest()) {
            @Override
            public Flux<DataBuffer> getBody() {
                AtomicLong seen = new AtomicLong();
                return super.getBody().concatMap(buffer -> {
                    if (seen.addAndGet(buffer.readableByteCount()) > limit) {
                        DataBufferUtils.release(buffer);
                        // A ResponseStatusException, so the error handler still answers 413 when the
                        // response has not been committed yet.
                        return Mono.error(new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                                "The request body exceeds the " + limit + " byte limit."));
                    }
                    return Mono.just(buffer);
                });
            }
        };
        return exchange.mutate().request(counting).build();
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 110;
    }
}
