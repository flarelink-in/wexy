package ai.wexy.platform.account;

import ai.wexy.common.InternalToken;
import ai.wexy.common.Ulid;
import ai.wexy.platform.GatewayKeys;
import ai.wexy.platform.error.ErrorEnvelopeHandler;
import ai.wexy.platform.identity.InternalTokenFilter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.web.reactive.function.server.HandlerStrategies;
import reactor.core.scheduler.Schedulers;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * W2's account routes through the platform's token filter and error envelope, over the in-memory store (the creations
 * platform design §10; PL-T3's rules at the routes, the store's own races in JdbcAccountStoreTest): the bootstrap, the
 * read, and the profile's claim and edits, for the caller alone, in a closed shape.
 */
class AccountRoutesTest {

    static final String KEY = "7465737474657374746573747465737474657374746573747465737474657374";
    private static final ObjectMapper JSON = new ObjectMapper();

    private final GatewayKeys gateway = new GatewayKeys();
    private final InMemoryAccountStore store = new InMemoryAccountStore();
    private final WebTestClient client = client(new SubjectKey(KEY, 1, true));

    private WebTestClient client(SubjectKey key) {
        Accounts accounts = new Accounts(store, key, Handle.reservedFromResource(), 1,
                Clock.fixed(Instant.parse("2026-11-03T10:00:00Z"), ZoneOffset.UTC));
        AccountHandler handler = new AccountHandler(accounts, Schedulers.boundedElastic());
        return WebTestClient.bindToRouterFunction(new AccountHandler.Routes().accountRoutes(handler))
                .handlerStrategies(HandlerStrategies.builder()
                        .webFilter(new InternalTokenFilter(gateway.keySet()))
                        .exceptionHandler(new ErrorEnvelopeHandler())
                        .build())
                .build();
    }

    private WebTestClient.ResponseSpec post(String token, Object body) {
        WebTestClient.RequestBodySpec spec = client.post().uri("/v1/me");
        if (token != null) {
            spec.header(InternalToken.HEADER, token);
        }
        return body == null ? spec.exchange() : spec.contentType(MediaType.APPLICATION_JSON).bodyValue(body).exchange();
    }

    private WebTestClient.ResponseSpec get(String token) {
        return client.get().uri("/v1/me").header(InternalToken.HEADER, token).exchange();
    }

    private WebTestClient.ResponseSpec patch(String token, Object body) {
        return client.patch().uri("/v1/me/profile").header(InternalToken.HEADER, token)
                .contentType(MediaType.APPLICATION_JSON).bodyValue(body).exchange();
    }

    private static JsonNode json(WebTestClient.ResponseSpec response) {
        try {
            return JSON.readTree(response.expectBody(String.class).returnResult().getResponseBody());
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static void refused(WebTestClient.ResponseSpec response, int status, String code) {
        response.expectStatus().isEqualTo(status)
                .expectHeader().valueEquals(HttpHeaders.CACHE_CONTROL, "no-store")
                .expectBody().jsonPath("$.code").isEqualTo(code);
    }

    /** The account ids {@link #bootstrap} made, by uid. */
    private final Map<String, String> ids = new java.util.HashMap<>();

    /** A bootstrapped account for `uid`, its profile at version 0. */
    private JsonNode bootstrap(String uid) {
        JsonNode made = json(post(gateway.account(uid), Map.of()).expectStatus().isCreated());
        ids.put(uid, made.get("accountId").asText());
        return made;
    }

    /**
     * A profile change as the studio sends it: by `uid`, for `uid`'s own account (the W2 review's precondition; an
     * account never made gets a fresh id), with `fields`.
     */
    private WebTestClient.ResponseSpec change(String uid, Map<String, ?> fields) {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("accountId", ids.getOrDefault(uid, Ulid.next(Instant.now())));
        body.putAll(fields);
        return patch(gateway.account(uid), body);
    }

    @Test
    void aFirstBootstrapMakesTheAccountAndAnotherFindsIt() {
        JsonNode made = json(post(gateway.account("uid-1"), Map.of()).expectStatus().isCreated()
                .expectHeader().valueEquals(HttpHeaders.CACHE_CONTROL, "no-store"));

        assertThat(names(made)).containsExactly("accountId", "status", "policyVersion", "profile");
        assertThat(Ulid.looksLikeOne(made.get("accountId").asText())).as("a ULID, never the uid or its HMAC").isTrue();
        assertThat(made.get("status").asText()).isEqualTo("ACTIVE");
        assertThat(made.get("policyVersion").asInt()).isEqualTo(1);
        JsonNode profile = made.get("profile");
        assertThat(names(profile)).containsExactly("handle", "displayName", "bio", "publicEnabled", "rowVersion");
        assertThat(profile.get("handle").isNull()).isTrue();
        assertThat(profile.get("displayName").isNull()).isTrue();
        assertThat(profile.get("bio").isNull()).isTrue();
        assertThat(profile.get("publicEnabled").asBoolean()).isFalse();
        assertThat(profile.get("rowVersion").asLong()).isZero();

        // Idempotent for the subject: the same account, 200 not 201; an empty body is the same as {}.
        JsonNode again = json(post(gateway.account("uid-1"), null).expectStatus().isOk());
        assertThat(again.get("accountId").asText()).isEqualTo(made.get("accountId").asText());
        assertThat(store.size()).isEqualTo(1);
    }

    @Test
    void readingBeforeTheBootstrapIsNotFoundAndMakesNothing() {
        refused(get(gateway.account("uid-1")), 404, "not-found");
        assertThat(store.size()).isZero();

        String id = bootstrap("uid-1").get("accountId").asText();
        assertThat(json(get(gateway.account("uid-1")).expectStatus().isOk()).get("accountId").asText()).isEqualTo(id);
    }

    /** PL-T3: no field picks the account; a client-chosen uid, owner, status or role is refused, and nothing is made. */
    @Test
    void aBootstrapTakesNoFields() {
        for (Object body : List.of(Map.of("uid", "uid-2"), Map.of("status", "ACTIVE"), Map.of("accountId", Ulid.next(Instant.now())),
                Map.of("role", "admin"), List.of())) {
            refused(post(gateway.account("uid-1"), body), 400, "bad-request");
        }
        assertThat(store.size()).isZero();
    }

    /** I1: the caller's own account and nobody else's, whatever the request says. */
    @Test
    void eachCallerHasItsOwnAccount() {
        String first = bootstrap("uid-1").get("accountId").asText();
        String second = bootstrap("uid-2").get("accountId").asText();
        assertThat(second).isNotEqualTo(first);
        assertThat(json(get(gateway.account("uid-2")).expectStatus().isOk()).get("accountId").asText()).isEqualTo(second);
    }

    @Test
    void aHandleIsClaimedOnceAndStoredLowercase() {
        bootstrap("uid-1");
        JsonNode claimed = json(change("uid-1", Map.of("expectedVersion", 0, "handle", "Nova_7")).expectStatus().isOk());
        assertThat(claimed.at("/profile/handle").asText()).isEqualTo("nova_7");
        assertThat(claimed.at("/profile/rowVersion").asLong()).isEqualTo(1);

        refused(change("uid-1", Map.of("expectedVersion", 1, "handle", "other")), 400, "bad-request");
        // The same handle again, in another case, changes nothing about it.
        JsonNode same = json(change("uid-1", Map.of("expectedVersion", 1, "handle", "NOVA_7")).expectStatus().isOk());
        assertThat(same.at("/profile/handle").asText()).isEqualTo("nova_7");
        assertThat(json(get(gateway.account("uid-1")).expectStatus().isOk()).at("/profile/handle").asText()).isEqualTo("nova_7");
    }

    /** A write based on a version that has moved on is a conflict: two tabs never write over each other. */
    @Test
    void aStaleVersionIsAConflict() {
        bootstrap("uid-1");
        change("uid-1", Map.of("expectedVersion", 0, "displayName", "Nova")).expectStatus().isOk();
        refused(change("uid-1", Map.of("expectedVersion", 0, "handle", "nova")), 409, "conflict");
        assertThat(json(get(gateway.account("uid-1")).expectStatus().isOk()).at("/profile/handle").isNull()).isTrue();
    }

    /**
     * Two tabs, one account: the second tab's claim, made from what it read before the first claimed, is a stale read
     * (409: read again and see the handle), not a change of a claimed handle (400).
     */
    @Test
    void aSecondTabsClaimAfterTheFirstsIsAConflict() {
        bootstrap("uid-1");
        change("uid-1", Map.of("expectedVersion", 0, "handle", "nova")).expectStatus().isOk();
        refused(change("uid-1", Map.of("expectedVersion", 0, "handle", "other")), 409, "conflict");
        assertThat(json(get(gateway.account("uid-1")).expectStatus().isOk()).at("/profile/handle").asText()).isEqualTo("nova");
    }

    /** PL-T3: one owner per handle, whatever its case. */
    @Test
    void aTakenHandleIsAConflictInAnyCase() {
        bootstrap("uid-1");
        bootstrap("uid-2");
        change("uid-1", Map.of("expectedVersion", 0, "handle", "nova")).expectStatus().isOk();
        refused(change("uid-2", Map.of("expectedVersion", 0, "handle", "NOVA")), 409, "conflict");
        assertThat(json(get(gateway.account("uid-2")).expectStatus().isOk()).at("/profile/handle").isNull()).isTrue();
    }

    @Test
    void handlesOutsideTheRulesAreRefused() {
        bootstrap("uid-1");
        for (String handle : List.of("ab", "a".repeat(31), "nova!", "no va", "növa", "ｎｏｖａ", "novaİ", "admin", "Wexy_Team",
                "wexy", "support", "")) {
            refused(change("uid-1", Map.of("expectedVersion", 0, "handle", handle)), 400, "bad-request");
        }
        assertThat(json(get(gateway.account("uid-1")).expectStatus().isOk()).at("/profile/rowVersion").asLong()).isZero();
    }

    /**
     * The W2 review: a change names the account it was prepared for. Another tab's sign-in can put another account's
     * token under a claim typed for the first; that claim is refused, whatever its version, and both accounts are left
     * as they were. Without the id, or with one that is no account id, the change is not understood.
     */
    @Test
    void aChangeIsForTheAccountItWasPreparedForAndNoOther() {
        bootstrap("uid-1");
        bootstrap("uid-2");
        Map<String, Object> preparedForOne = Map.of("accountId", ids.get("uid-1"), "expectedVersion", 0, "handle", "alice");
        refused(patch(gateway.account("uid-2"), preparedForOne), 409, "conflict");
        assertThat(json(get(gateway.account("uid-2")).expectStatus().isOk()).at("/profile/handle").isNull()).isTrue();
        assertThat(json(get(gateway.account("uid-1")).expectStatus().isOk()).at("/profile/handle").isNull()).isTrue();

        refused(patch(gateway.account("uid-1"), Map.of("expectedVersion", 0, "handle", "alice")), 400, "bad-request");
        for (Object id : List.of("uid-1", "", 7, ids.get("uid-1").toLowerCase())) {
            refused(patch(gateway.account("uid-1"), Map.of("accountId", id, "expectedVersion", 0, "handle", "alice")), 400, "bad-request");
        }
        assertThat(json(change("uid-1", Map.of("expectedVersion", 0, "handle", "alice")).expectStatus().isOk())
                .at("/profile/handle").asText()).isEqualTo("alice");
    }

    /** PL-T3: a status, a role, a tier or a public flag cannot ride along a profile change. */
    @Test
    void fieldsOutsideTheProfileChangeAreRefused() {
        bootstrap("uid-1");
        for (String field : List.of("status", "owner", "tier", "role", "admin", "publicEnabled", "subject", "rowVersion")) {
            refused(change("uid-1", Map.of("expectedVersion", 0, "handle", "nova", field, true)), 400, "bad-request");
        }
        JsonNode account = json(get(gateway.account("uid-1")).expectStatus().isOk());
        assertThat(account.at("/profile/handle").isNull()).isTrue();
        assertThat(account.get("status").asText()).isEqualTo("ACTIVE");
    }

    @Test
    void aChangeNeedsAVersionAndSomethingToChange() {
        bootstrap("uid-1");
        refused(change("uid-1", Map.of("expectedVersion", 0)), 400, "bad-request");
        refused(change("uid-1", Map.of("handle", "nova")), 400, "bad-request");
        refused(change("uid-1", Map.of("expectedVersion", -1, "handle", "nova")), 400, "bad-request");
        refused(change("uid-1", Map.of("expectedVersion", 0.5, "handle", "nova")), 400, "bad-request");
        refused(change("uid-1", Map.of("expectedVersion", "0", "handle", "nova")), 400, "bad-request");
        refused(patch(gateway.account("uid-1"), List.of()), 400, "bad-request");
    }

    /** Display text is bounded by the columns and is text: no controls, no direction overrides; empty clears. */
    @Test
    void textIsBoundedAndShowableAsText() {
        bootstrap("uid-1");
        long version = 0;
        JsonNode named = json(change("uid-1", Map.of("expectedVersion", version++, "displayName",
                "  " + "é".repeat(50) + " ", "bio", "line one\nline two")).expectStatus().isOk());
        assertThat(named.at("/profile/displayName").asText()).isEqualTo("é".repeat(50));
        assertThat(named.at("/profile/bio").asText()).isEqualTo("line one\nline two");

        for (Map<String, Object> body : List.of(
                Map.<String, Object>of("expectedVersion", version, "displayName", "é".repeat(51)),
                Map.<String, Object>of("expectedVersion", version, "bio", "x".repeat(281)),
                Map.<String, Object>of("expectedVersion", version, "displayName", "two\nlines"),
                Map.<String, Object>of("expectedVersion", version, "displayName", "bell\u0007"),
                Map.<String, Object>of("expectedVersion", version, "displayName", "evil‮gnp.exe"),
                Map.<String, Object>of("expectedVersion", version, "bio", "isolate⁦x⁩"),
                Map.<String, Object>of("expectedVersion", version, "displayName", 7))) {
            refused(change("uid-1", body), 400, "bad-request");
        }
        // An emoji is one code point of fifty; an empty name clears the field.
        String fifty = "🌌".repeat(50);
        assertThat(json(change("uid-1", Map.of("expectedVersion", version++, "displayName", fifty)).expectStatus().isOk())
                .at("/profile/displayName").asText()).isEqualTo(fifty);
        JsonNode cleared = json(change("uid-1", Map.of("expectedVersion", version, "displayName", "   ")).expectStatus().isOk());
        assertThat(cleared.at("/profile/displayName").isNull()).isTrue();
        assertThat(cleared.at("/profile/bio").asText()).as("an absent field is left as it was").isEqualTo("line one\nline two");
    }

    /** I10: a suspended account reads its own status, and changes nothing. */
    @Test
    void aSuspendedAccountReadsItsStatusButChangesNothing() {
        String id = bootstrap("uid-1").get("accountId").asText();
        store.setStatus(id, Account.Status.SUSPENDED);
        refused(change("uid-1", Map.of("expectedVersion", 0, "handle", "nova")), 403, "forbidden");
        JsonNode read = json(get(gateway.account("uid-1")).expectStatus().isOk());
        assertThat(read.get("status").asText()).isEqualTo("SUSPENDED");
        assertThat(read.at("/profile/handle").isNull()).isTrue();
    }

    @Test
    void aProfileChangeBeforeTheBootstrapIsNotFound() {
        refused(change("uid-1", Map.of("expectedVersion", 0, "handle", "nova")), 404, "not-found");
        assertThat(store.size()).isZero();
    }

    /** Only the gateway's token for the platform, from a real account, reaches an account; nothing else reads or makes one. */
    @Test
    void withoutThePlatformsTokenFromARealAccountNothingIsReadOrMade() {
        refused(post(null, Map.of()), 401, "auth");
        refused(post(gateway.token("uid-1", false, false, InternalToken.AUDIENCE_FORGE), Map.of()), 401, "auth");
        refused(post(gateway.token("uid-1", false, false, null), Map.of()), 401, "auth");
        refused(post(gateway.token("uid-1", true, false, InternalToken.AUDIENCE_PLATFORM), Map.of()), 403, "account-required");
        assertThat(store.size()).isZero();
    }

    /** No account key outside prod (prod refuses to start): the accounts are unavailable, never keyed by nothing. */
    @Test
    void withoutAnAccountKeyAccountsAreUnavailable() {
        WebTestClient keyless = client(new SubjectKey("", 1, false));
        keyless.post().uri("/v1/me").header(InternalToken.HEADER, gateway.account("uid-1"))
                .contentType(MediaType.APPLICATION_JSON).bodyValue(Map.of())
                .exchange()
                .expectStatus().isEqualTo(503)
                .expectBody().jsonPath("$.code").isEqualTo("unavailable");
        assertThat(store.size()).isZero();
    }

    private static List<String> names(JsonNode node) {
        List<String> names = new java.util.ArrayList<>();
        node.fieldNames().forEachRemaining(names::add);
        return names;
    }
}
