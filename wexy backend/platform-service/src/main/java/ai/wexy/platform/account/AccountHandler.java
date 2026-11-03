package ai.wexy.platform.account;

import ai.wexy.common.ErrorCode;
import ai.wexy.platform.error.PlatformException;
import ai.wexy.platform.identity.PlatformCaller;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;

import java.io.IOException;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Callable;

/**
 * The account routes (W2; the creations platform design §10): {@code POST /v1/me}, {@code GET /v1/me} and {@code PATCH
 * /v1/me/profile}, each answering the caller's own self DTO, never stored ({@code no-store}):
 *
 * <pre>{"accountId", "status", "policyVersion", "profile": {"handle", "displayName", "bio", "publicEnabled", "rowVersion"}}</pre>
 *
 * The account id is the platform's ULID, never the Firebase uid or its HMAC. Every store call runs on the database
 * scheduler, bounded by the connection pool.
 */
public class AccountHandler {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final Accounts accounts;
    private final Scheduler database;

    public AccountHandler(Accounts accounts, Scheduler database) {
        this.accounts = accounts;
        this.database = database;
    }

    /**
     * {@code POST /v1/me}: 201 with the account this call made, or 200 with the caller's existing one. Its body is {@code
     * {}}, or none at all: read as text, so a bodiless request is not refused for the content type it never needed.
     */
    public Mono<ServerResponse> bootstrap(ServerRequest request) {
        PlatformCaller caller = PlatformCaller.of(request.exchange());
        return request.bodyToMono(String.class)
                .defaultIfEmpty("")
                .flatMap(text -> {
                    // No field picks the account: not a uid, an owner, a status or a role (PL-T3).
                    if (!takesNoFields(text)) {
                        return Mono.<Accounts.Bootstrap>error(new PlatformException(ErrorCode.BAD_REQUEST,
                                "Setting up an account takes no fields."));
                    }
                    return blocking(() -> accounts.bootstrap(caller));
                })
                .flatMap(made -> answer(made.created() ? HttpStatus.CREATED : HttpStatus.OK, made.account()));
    }

    /** No body, or an empty JSON object: the bootstrap's whole input. */
    static boolean takesNoFields(String text) {
        if (text.isBlank()) {
            return true;
        }
        try {
            JsonNode body = JSON.readTree(text);
            return body != null && body.isObject() && body.isEmpty();
        } catch (IOException notJson) {
            return false;
        }
    }

    /** {@code GET /v1/me}: the caller's account, whatever its status; 404 before the bootstrap. */
    public Mono<ServerResponse> read(ServerRequest request) {
        PlatformCaller caller = PlatformCaller.of(request.exchange());
        return blocking(() -> accounts.read(caller)).flatMap(account -> answer(HttpStatus.OK, account));
    }

    /** {@code PATCH /v1/me/profile}: the profile at its next version. */
    public Mono<ServerResponse> patchProfile(ServerRequest request) {
        PlatformCaller caller = PlatformCaller.of(request.exchange());
        return request.bodyToMono(JsonNode.class)
                .switchIfEmpty(Mono.error(new PlatformException(ErrorCode.BAD_REQUEST, "The profile change is a JSON object.")))
                .map(ProfilePatch::parse)
                .flatMap(patch -> blocking(() -> accounts.patchProfile(caller, patch)))
                .flatMap(account -> answer(HttpStatus.OK, account));
    }

    private <T> Mono<T> blocking(Callable<T> call) {
        return Mono.fromCallable(call).subscribeOn(database);
    }

    private static Mono<ServerResponse> answer(HttpStatus status, Account account) {
        return ServerResponse.status(status).contentType(MediaType.APPLICATION_JSON)
                .header(HttpHeaders.CACHE_CONTROL, "no-store").bodyValue(selfDto(account));
    }

    /** The self DTO, every key present, nulls included: the studio holds it to this closed shape. */
    static Map<String, Object> selfDto(Account account) {
        Account.Profile p = account.profile();
        Map<String, Object> profile = new LinkedHashMap<>();
        profile.put("handle", p.handle());
        profile.put("displayName", p.displayName());
        profile.put("bio", p.bio());
        profile.put("publicEnabled", p.publicEnabled());
        profile.put("rowVersion", p.rowVersion());
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("accountId", account.id());
        dto.put("status", account.status().name());
        dto.put("policyVersion", account.policyVersion());
        dto.put("profile", profile);
        return dto;
    }

    /** The routes and what they need; the internal token is required on every one. */
    @Configuration
    public static class Routes {

        @Bean
        public SubjectKey subjectKey(AccountProperties properties) {
            return new SubjectKey(properties.hmacHex(), properties.hmacVersion(), properties.keyRequired());
        }

        @Bean
        public Accounts accounts(AccountStore store, SubjectKey subjectKey, AccountProperties properties) {
            return new Accounts(store, subjectKey, Handle.reservedFromResource(), properties.policyVersion(), Clock.systemUTC());
        }

        @Bean
        public AccountHandler accountHandler(Accounts accounts, @Qualifier("database") Scheduler database) {
            return new AccountHandler(accounts, database);
        }

        @Bean
        public RouterFunction<ServerResponse> accountRoutes(AccountHandler handler) {
            return RouterFunctions.route()
                    .POST("/v1/me", handler::bootstrap)
                    .GET("/v1/me", handler::read)
                    .PATCH("/v1/me/profile", handler::patchProfile)
                    .build();
        }
    }
}
