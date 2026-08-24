FROM node:22-alpine
WORKDIR /app
COPY server.js .
# Deliberately echoes a build arg: this fixture is the DoD-9 redaction evidence,
# so the secret has to actually reach the build log for redaction to be proven.
ARG CANARY_TOKEN=unset
RUN echo "build-time canary was ${CANARY_TOKEN}"
EXPOSE 3000
CMD ["node", "server.js"]
