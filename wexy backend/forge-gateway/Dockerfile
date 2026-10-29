# forge-gateway: the public door (sign-in, App Check, limits, routing) on 8400, and the actuator on 8401, which no
# tunnel ever routes (docs/deploy-design.md §6). Built FlareLink's way (pre-existing work): Maven packages the jar
# outside Docker (deploy.sh) and this file only copies it, so a build costs seconds and no Maven cache. A JRE, not
# a JDK; a non-root user; curl for compose's health check. deploy.sh passes the jar's name; the default is the pom's.
FROM eclipse-temurin:21-jre-jammy

ARG JAR=target/forge-gateway-0.1.0-SNAPSHOT.jar

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --user-group --create-home --home-dir /app wexy

WORKDIR /app
COPY --chown=wexy:wexy ${JAR} /app/forge-gateway.jar
USER wexy

# Measured on 2026-10-28: about 330 MB resident at -Xmx384m. compose.prod.yaml caps the container at 640 MB, and an
# OutOfMemoryError ends the process, so `restart: unless-stopped` brings a clean one back instead of a stalled one.
ENV JAVA_OPTS="-Xmx384m -XX:+ExitOnOutOfMemoryError"

EXPOSE 8400 8401
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/forge-gateway.jar"]
