# Changelog

## 1.0.0 (2026-11-11)

First release.

- Create, update, reply to, read, list, send, and delete Gmail drafts from Claude Desktop.
- Plain text and formatted (HTML) emails, saved with both versions so links and formatting show correctly.
- Link cleaner: Google redirect links (google.com/url?q=...) are replaced with the real address before any draft is saved or sent. A redirect link that cannot be repaired stops the save with a clear error.
- Each person signs in with their own Google credentials. The sign-in stays on their own computer.
- One-file install for Claude Desktop (.mcpb). No Docker.
