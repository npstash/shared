// API of an allow provider. The facade checks the deny-list first, then asks the provider.
// To add a provider: extend AllowProvider and select it in config/facade.ini ([hosts] provider).
//
// ctx = { url, tool }: the URL that the page opens or opened, and the tool that caused it.

export class AllowProvider {
  // Give true if the facade can open the host.
  async isAllowed(host, ctx) {
    throw new Error('not implemented');
  }

  // The facade opened a page of the host. The provider can record it.
  async recordOpened(host, ctx) {}
}
