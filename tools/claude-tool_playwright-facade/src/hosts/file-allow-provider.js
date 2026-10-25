// The default allow provider: the [allow] section of config/hosts.ini.
// It adds the exact host of each opened page to [allow], also if a wildcard covers the host.
// "[hosts] record = false" in config/facade.ini stops this, e.g. for a shared host list.
import { AllowProvider } from './allow-provider.js';
import { firstMatch } from './patterns.js';

export class FileAllowProvider extends AllowProvider {
  constructor({ hostsFile, record, logger }) {
    super();
    this.hostsFile = hostsFile;
    this.record = record;
    this.logger = logger;
  }

  async isAllowed(host) {
    this.hostsFile.load();
    return firstMatch(this.hostsFile.allow, host) !== undefined;
  }

  async recordOpened(host) {
    if (!this.record) return;
    if (this.hostsFile.addAllowed(host)) this.logger.info('host_recorded', { host, file: this.hostsFile.file });
  }
}
