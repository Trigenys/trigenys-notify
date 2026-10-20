# Architecture

```text
HTTP transport
     |
     v
application/domain core
     |
     +--> ports/interfaces
              |
              +--> persistence adapter
              +--> external provider adapter
              +--> queue/worker adapter
```

The initial blueprint ships only a health endpoint. Product-specific capabilities should preserve these boundaries rather than coupling the domain to a framework, database or cloud runtime.

## Defaults

- runtime: Node.js 24
- language: TypeScript
- HTTP: native Node server for a dependency-light bootstrap
- persistence: intentionally unspecified
- hosting: intentionally unspecified
- secrets: runtime/environment-specific, never committed

## Evolution

Adopt a framework, persistence layer or hosting target only when requirements justify it. Public contracts should be versioned before external consumers depend on them.
