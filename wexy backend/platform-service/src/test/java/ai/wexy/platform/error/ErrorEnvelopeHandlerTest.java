package ai.wexy.platform.error;

import ai.wexy.common.ErrorCode;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.transaction.CannotCreateTransactionException;

import java.sql.SQLTransientConnectionException;
import java.util.concurrent.RejectedExecutionException;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The platform's envelope (the creations platform design §13): a database the service cannot reach is 503
 * `unavailable`, whichever way Spring reports it, and says nothing of the SQL or the value behind it.
 */
class ErrorEnvelopeHandlerTest {

    private final ErrorEnvelopeHandler handler = new ErrorEnvelopeHandler();

    private MockServerWebExchange answer(Throwable error) {
        MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.post("/v1/me"));
        handler.handle(exchange, error).block();
        return exchange;
    }

    /**
     * The independent W2 review: a transaction that cannot start (no connection within the pool's 2 s) is Spring's
     * TransactionException, not a DataAccessException, with Hikari's own exception under it; it was answered 500.
     */
    @Test
    void aTransactionThatCannotStartIsUnavailable() {
        MockServerWebExchange exchange = answer(new CannotCreateTransactionException("Could not open JDBC Connection for transaction",
                new SQLTransientConnectionException("HikariPool-1 - Connection is not available, request timed out after 2000ms (total=4)")));
        assertThat(exchange.getResponse().getStatusCode().value()).isEqualTo(503);
        String body = exchange.getResponse().getBodyAsString().block();
        assertThat(body).contains("\"code\":\"" + ErrorCode.UNAVAILABLE.code() + "\"").doesNotContain("Hikari", "JDBC");
        assertThat(exchange.getResponse().getHeaders().getFirst(HttpHeaders.CACHE_CONTROL)).isEqualTo("no-store");
    }

    @Test
    void everyOtherWayTheDatabaseIsLostIsUnavailableToo() {
        for (Throwable error : new Throwable[]{
                new DataAccessResourceFailureException("down"),
                new CannotGetJdbcConnectionException("no connection"),
                new SQLTransientConnectionException("raw, untranslated"),
                new RejectedExecutionException("the database scheduler's queue is full")}) {
            assertThat(answer(error).getResponse().getStatusCode().value()).as(error.getClass().getSimpleName()).isEqualTo(503);
        }
    }

    @Test
    void aRefusalKeepsItsCodeAndABugIsInternal() {
        assertThat(answer(new PlatformException(ErrorCode.CONFLICT, "taken")).getResponse().getStatusCode().value()).isEqualTo(409);
        assertThat(answer(new IllegalStateException("a bug")).getResponse().getStatusCode().value()).isEqualTo(500);
    }
}
