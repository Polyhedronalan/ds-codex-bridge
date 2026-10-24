# Security

Do not submit API keys, OAuth tokens, DPAPI blobs, local bridge keys, private prompts,
response captures, config backups or databases in issues or pull requests.

The listener is loopback only. The local key is stripped before upstream forwarding;
it can still appear in Codex client URL logs. Local file access is outside its threat model.
DPAPI credentials are scoped to the current Windows user and machine; never copy them.

The default logger allowlists fields and scrubs registered secrets. Diagnostic body
capture modes are for local investigation and may contain private request content.
Review local files before committing. `.gitignore` does not protect previously tracked files.

For a suspected vulnerability, use the repository owner's private security contact or
GitHub private vulnerability reporting if enabled. Do not post working credentials.
