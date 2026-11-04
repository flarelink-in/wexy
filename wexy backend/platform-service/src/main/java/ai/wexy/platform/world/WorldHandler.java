package ai.wexy.platform.world;

import ai.wexy.common.ErrorCode;
import ai.wexy.platform.account.Accounts;
import ai.wexy.platform.error.PlatformException;
import ai.wexy.platform.identity.PlatformCaller;
import ai.wexy.platform.storage.ObjectStore;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;

import java.time.Clock;
import java.util.concurrent.Callable;

/**
 * The world routes (W3.2; the creations platform design §10's W3 note), every answer the caller's own and never stored
 * ({@code no-store}). A save and a revision's read touch B2, so they run on the storage scheduler; every other call is the
 * database's alone and runs on its scheduler. Both are bounded, and a full queue is 503 at once.
 */
public class WorldHandler {

    static final String IDEMPOTENCY_KEY = "Idempotency-Key";

    private final Worlds worlds;
    private final Scheduler database;
    private final Scheduler storage;

    public WorldHandler(Worlds worlds, Scheduler database, Scheduler storage) {
        this.worlds = worlds;
        this.database = database;
        this.storage = storage;
    }

    public Mono<ServerResponse> create(ServerRequest request) {
        PlatformCaller caller = PlatformCaller.of(request.exchange());
        String key = request.headers().firstHeader(IDEMPOTENCY_KEY);
        return body(request).flatMap(body -> run(storage, () -> worlds.create(caller, key, body)));
    }

    public Mono<ServerResponse> revise(ServerRequest request) {
        PlatformCaller caller = PlatformCaller.of(request.exchange());
        String key = request.headers().firstHeader(IDEMPOTENCY_KEY);
        String id = request.pathVariable("id");
        return body(request).flatMap(body -> run(storage, () -> worlds.revise(caller, id, key, body)));
    }

    public Mono<ServerResponse> rename(ServerRequest request) {
        PlatformCaller caller = PlatformCaller.of(request.exchange());
        String id = request.pathVariable("id");
        return body(request).flatMap(body -> run(database, () -> worlds.rename(caller, id, body)));
    }

    public Mono<ServerResponse> delete(ServerRequest request) {
        PlatformCaller caller = PlatformCaller.of(request.exchange());
        String key = request.headers().firstHeader(IDEMPOTENCY_KEY);
        String expected = request.queryParam("expectedVersion").orElse(null);
        return run(database, () -> worlds.delete(caller, request.pathVariable("id"), key, expected));
    }

    public Mono<ServerResponse> read(ServerRequest request) {
        PlatformCaller caller = PlatformCaller.of(request.exchange());
        return run(database, () -> worlds.read(caller, request.pathVariable("id")));
    }

    public Mono<ServerResponse> list(ServerRequest request) {
        PlatformCaller caller = PlatformCaller.of(request.exchange());
        String limit = request.queryParam("limit").orElse(null);
        String cursor = request.queryParam("cursor").orElse(null);
        return run(database, () -> worlds.list(caller, limit, cursor));
    }

    public Mono<ServerResponse> revision(ServerRequest request) {
        PlatformCaller caller = PlatformCaller.of(request.exchange());
        return run(storage, () -> worlds.revision(caller, request.pathVariable("id"), request.pathVariable("revisionId")));
    }

    public Mono<ServerResponse> usage(ServerRequest request) {
        PlatformCaller caller = PlatformCaller.of(request.exchange());
        return run(database, () -> worlds.usage(caller));
    }

    public Mono<ServerResponse> operation(ServerRequest request) {
        PlatformCaller caller = PlatformCaller.of(request.exchange());
        return run(database, () -> worlds.operation(caller, request.pathVariable("id")));
    }

    private static Mono<JsonNode> body(ServerRequest request) {
        return request.bodyToMono(JsonNode.class)
                .switchIfEmpty(Mono.error(new PlatformException(ErrorCode.BAD_REQUEST, "This request takes a JSON object.")));
    }

    private static Mono<ServerResponse> run(Scheduler scheduler, Callable<Worlds.Reply> call) {
        return Mono.fromCallable(call).subscribeOn(scheduler)
                .flatMap(reply -> ServerResponse.status(reply.status()).contentType(MediaType.APPLICATION_JSON)
                        .header(HttpHeaders.CACHE_CONTROL, "no-store").bodyValue(reply.json()));
    }

    /** The routes and what they need; the internal token is required on every one (none is public). */
    @Configuration
    public static class Routes {

        @Bean
        public WorldCheck worldCheck() {
            return new WorldCheck();
        }

        @Bean
        public JdbcWorldStore worldStore(JdbcClient jdbc, PlatformTransactionManager transactions, WorldProperties limits) {
            return new JdbcWorldStore(jdbc, transactions, limits);
        }

        @Bean
        public Worlds worlds(Accounts accounts, JdbcWorldStore store, ObjectStore objects, WorldCheck check) {
            return new Worlds(accounts, store, objects, check, Clock.systemUTC());
        }

        @Bean
        public WorldHandler worldHandler(Worlds worlds, @Qualifier("database") Scheduler database, @Qualifier("storage") Scheduler storage) {
            return new WorldHandler(worlds, database, storage);
        }

        @Bean
        public RouterFunction<ServerResponse> worldRoutes(WorldHandler handler) {
            return RouterFunctions.route()
                    .POST("/v1/worlds", handler::create)
                    .GET("/v1/me/worlds", handler::list)
                    .GET("/v1/me/usage", handler::usage)
                    .GET("/v1/me/operations/{id}", handler::operation)
                    .GET("/v1/worlds/{id}", handler::read)
                    .PATCH("/v1/worlds/{id}", handler::rename)
                    .DELETE("/v1/worlds/{id}", handler::delete)
                    .POST("/v1/worlds/{id}/revisions", handler::revise)
                    .GET("/v1/worlds/{id}/revisions/{revisionId}", handler::revision)
                    .build();
        }
    }
}
