# Security

The built-in server is a local authoring and review service. It has no authentication, authorization, malware scanning or multi-tenant isolation. Bind it to `127.0.0.1` unless a trusted reverse proxy provides those controls.

For hosted use:

- terminate TLS at the reverse proxy;
- require identity-aware authentication;
- restrict authorship/upload separately from review access;
- validate and stage uploads before publishing them;
- run the service with a dedicated low-privilege account;
- put private review content and generated state outside the public repository;
- add backups, retention and audit logging;
- consider serving untrusted prototypes from a sandboxed secondary origin.

Please report security problems privately to the repository owner rather than opening a public issue.

