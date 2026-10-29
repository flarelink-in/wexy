# forge-service: prompts, money, streams and records on 8410, never published (only the gateway reaches it on the
# compose network), with the actuator on 8411 (docs/deploy-design.md §6). Built FlareLink's way (pre-existing work):
# Maven packages the jar outside Docker (deploy.sh) and this file only copies it. The prompts, the host h1, the
# schemas and the mock's recordings are inside the jar. A JRE, a non-root user, curl for the health check.
FROM eclipse-temurin:21-jre-jammy

ARG JAR=target/forge-service-0.1.0-SNAPSHOT.jar

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --user-group --create-home --home-dir /app wexy

WORKDIR /app
COPY --chown=wexy:wexy ${JAR} /app/forge-service.jar
USER wexy

# As the gateway's: about 330 MB resident at -Xmx384m on 2026-10-28; compose caps the container at 640 MB.
ENV JAVA_OPTS="-Xmx384m -XX:+ExitOnOutOfMemoryError"

EXPOSE 8410 8411
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/forge-service.jar"]
