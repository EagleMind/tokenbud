declare module "cloudflare:test" {
  interface ProvidedEnv {
    HOSTS: DurableObjectNamespace<import("../src/index").HostRelay>;
  }
}
