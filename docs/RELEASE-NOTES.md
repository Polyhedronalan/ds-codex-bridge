# Package preparation — 2026-10-24

This is a source package extracted from the maintained Bridge, not a production deploy.
Package version 0.1.0 identifies this distribution; `/health.version` comes from Bridge
configuration and is not a claim about the host's installed production version.

- The ten core `.mjs` modules are copied byte for byte. Original hashes are recorded in
  `source-provenance.json`; the release check verifies them. Includes tool history,
  Unicode boundary, tool convention, cancellation and log rotation behavior present
  in that source snapshot. No account, key, real request or business receipt is bundled.
- Production `config.json`, quota policy/cache, logs, runtime, backups, legacy supervisors,
  personal architecture documents and diagnostic tools are excluded.
- Windows lifecycle scripts retain the existing ensurer/identity logic. Their proxy defaults
  now use `HTTPS_PROXY` (empty means direct); private sync mirroring is disabled unless a
  caller supplies `-MirrorRoot`. Historical comments about a live installation are removed.
- Optional quota gate code is retained unchanged but disabled by absence of a local policy.
  Its Alan Router integration is external. The implementation retries failed quota reads
  once and can use an official snapshot for 900 seconds; each subprocess timeout is 25 s.
  This is not an independent, universally portable quota reader.
- Tool-policy tests retain the Bridge assertions and replace the private incident request
  with a synthetic fixture. Catalog-sync tests are excluded because the catalog service
  is a separate project. Other original Bridge tests are included unchanged apart from
  their invocation comment.
- Added initialization, documentation, explicit release allowlist, source hashes and CI.
  No installer writes the global Codex configuration, no new scheduler is installed.

Local validation is described in the delivery report outside this upload directory.
Real DeepSeek/GPT sends, global provider activation, Windows background lifecycle and
the remote CI matrix require their own environment acceptance; unit/mock checks do not
establish those outcomes.

## Health probe repair — 2026-10-25

- Preserve historical request failure counts, but clear recovered transport, capacity,
  5xx and billing alerts only after three later completed successes for the same
  upstream and model. Header diagnostics and other routes cannot prove recovery.
- Keep caller-specific authentication and payload failures active. Show HTTP 402 as
  an upstream billing/balance issue; a Bridge restart cannot replenish the account.
- Add isolated Windows PowerShell regression checks and include them in Windows CI.
  This changes the health probe only; the ten core module hashes remain unchanged.

## Manual repair outcomes — 2026-10-29

- Classify local process faults separately from upstream authentication, billing,
  proxy/TLS and request faults; provide targeted guidance instead of a repeat-click loop.
- Confirm a manual wedge in one invocation, keeping the same listener identity across probes.
- Preserve stop/start exit codes and stop after a failed stop. Mark recovery only after
  the post-action probe has no remaining active problem; expose local readiness separately.
- Manual transport diagnostics use an unauthenticated HEAD and enforce TLS validation.
  Any HTTP response proves transport only, not account/model access. Scheduled checks do
  not send upstream probes. No proxy, credential, routing or system network settings change.
- Include isolated decision/lifecycle regression tests and credential-free transport tests.
