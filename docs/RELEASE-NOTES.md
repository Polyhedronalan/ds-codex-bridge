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
