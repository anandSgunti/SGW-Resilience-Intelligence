// Runtime bindings this Worker expects. `@cloudflare/workers-types` declares an
// empty `Cloudflare.Env`; the real values are injected by the control plane or
// by `.openai/hosting.json`. `DB` stays optional because the D1 scaffold in
// `db/index.ts` is not wired to any screen yet and throws a clear error when the
// binding is absent.
declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB?: D1Database;
  }
}
