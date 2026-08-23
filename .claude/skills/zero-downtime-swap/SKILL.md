---
name: zero-downtime-swap
description: >
  Building or changing the mosdash deploy pipeline, the health gate, the Caddy
  route switch, rollback, or resource deletion. Load before touching deploy
  ordering — the sequence is the product's core guarantee, and reordering it
  breaks that guarantee silently. Triggers on "deploy pipeline", "health gate",
  "zero downtime", "route switch", "Caddy route", "rollback", "drain",
  "delete a resource", "on-demand TLS".
---

# The zero-downtime swap

## The guarantee

**The old container is never stopped until the new one passes the health gate
_and_ the Caddy route has been switched.** This is a correctness requirement, not
a nicety. Reordering these steps still produces a deploy that appears to work —
it just drops requests on every deploy, and nobody notices until production.

`CLAUDE.md` names this and the log demultiplexer as the two places warranting a
real explanatory comment. Write it.

## The pipeline

Job type `deploy`, payload `{ resourceId, deploymentId, image }`. Each step emits
a log line to the deployment's stream.

1. Mark deployment `running`, set `started_at`.
2. `ensureNetwork("mosdash")`.
3. Pull the image, forwarding progress lines to the log stream.
4. Decrypt env vars. **Never log a decrypted value** — redact in every path,
   including errors.
5. Create the new container, `mosdash-<resourceId>-<short deploymentId>`, on the
   `mosdash` network, with all required labels and the memory limit.
6. Start it.
7. **Health gate**, polling until healthy or timeout (default 60s), in this
   precedence:
   - `health_path` + `container_port` defined → HTTP GET
     `http://<containerName>:<port><health_path>` from inside the network,
     require 2xx.
   - Else the image declares a Docker HEALTHCHECK → poll inspect for
     `health === "healthy"`.
   - Else require the container to still be running after 5 seconds.
8. **On success:** switch the Caddy route to the new container, _then_ stop and
   remove the old one after a 10-second drain. Set `resources.previous_image` to
   the outgoing image so rollback has a target.
9. **On failure:** remove the _new_ container, leave the old one serving, mark
   the deployment `failed` with the error, emit a clear final log line.

Step 9 is what makes a failed deploy a non-event. A pipeline that tears down the
old container before verifying the new one turns every failed deploy into an
outage.

## Caddy routes

Route objects use `@id` so each can be replaced or deleted independently:

- Add — `POST /config/apps/http/servers/srv0/routes/`
- Replace atomically — `PATCH /id/mosdash-<resourceId>`
- Delete — `DELETE /id/mosdash-<resourceId>`

The upstream dials the container **by name** on the `mosdash` network, which is
why the network must be user-defined — the default bridge gives no name
resolution.

### Caddy security

- **The admin API is never published to the host.** Bind it to the mosdash
  network only. Anyone reaching port 2019 can replace the entire config with no
  authentication.
- `/data` (certificates) and `/config` are named volumes. Losing the cert store
  means re-issuing everything and burning rate limit.
- **Use the Let's Encrypt staging endpoint during development.** Production
  limits are 50 certificates per registered domain per week and you will hit them
  while iterating.
- If on-demand TLS is enabled, it **must** have an `ask` endpoint that validates
  the requested domain against the database. Without one, anyone pointing DNS at
  the box triggers unlimited issuance — a rate-limit denial of service.

## Multi-service stacks

Zero-downtime for a Compose stack is genuinely harder than for one container.
Gate the route switch on the designated public service becoming healthy, and
**document that stacks may have brief downtime on redeploy.** Do not fake a
guarantee that cannot be kept.

## Deletion order

Stop container → remove container → delete the Caddy route → remove volumes →
delete the row. A crash mid-sequence must leave something the reconciler can
finish; deleting the row first orphans everything else with no way to find it.
