// Approval HTTPS provider (approval): asks an approval service, then gives the values of its
// key-value provider (the entry in server.json that has this provider as "approval"). See REQ-036b
// of sdd/SRS.md.
//
//   "approval": { "type": "approve-https", "address": "https://127.0.0.1:8743",
//                 "fingerprint": "<SHA-256 of the certificate of the service>" }
//
// The provider pins the certificate: it sends nothing until the fingerprint is equal. It sends no
// authentication, and no value or URL: only { host, keys, client }. An empty address or
// fingerprint, an error, or no answer in APPROVAL_TIMEOUT refuses the fill.
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { ApprovalProviderOptions, ApprovalRequest } from '../../src/fill/provider.ts';
import { APPROVAL_TIMEOUT, ApprovalProvider } from '../../src/fill/provider.ts';
import { errorMessage } from '../../src/json.ts';

// The answer of the approval service.
export interface ServiceAnswer {
  readonly status: number | undefined;
  readonly body: string;
}

export interface ApproveHttpsOptions extends ApprovalProviderOptions {
  // Maximum time of one approval in ms; the tests give a shorter time.
  readonly timeout?: number;
}

// "AB:CD:..." or "abcd..." → "ABCD...".
export function normalizeFingerprint(text: unknown): string {
  return String(text ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();
}

export default class ApproveHttpsProvider extends ApprovalProvider {
  readonly address: string;
  readonly fingerprint: string;
  readonly timeout: number;

  constructor(options: ApproveHttpsOptions) {
    super(options);
    this.address = String(this.settings.address ?? '').trim();
    this.fingerprint = normalizeFingerprint(this.settings.fingerprint);
    this.timeout = options.timeout ?? APPROVAL_TIMEOUT;
  }

  async approve(request: ApprovalRequest): Promise<boolean> {
    if (!this.address || !this.fingerprint) return this.refuse('no address or no fingerprint in server.json');
    let url: URL;
    try {
      url = new URL('approve', this.address.endsWith('/') ? this.address : `${this.address}/`);
    } catch {
      return this.refuse('the address is not a URL');
    }
    if (url.protocol !== 'https:') return this.refuse('the address is not https');
    try {
      const answer = await this.post(url, JSON.stringify(request));
      if (answer.status !== 200) return this.refuse(`the service answered ${answer.status}`);
      return (JSON.parse(answer.body) as { approved?: unknown } | null)?.approved === true || this.refuse('the service refused');
    } catch (error) {
      return this.refuse(errorMessage(error));
    }
  }

  refuse(reason: string): false {
    this.logger?.info('approval_refused', { provider: this.name, reason });
    return false;
  }

  // POST the body after the TLS check of the fingerprint. Give { status, body }.
  post(url: URL, body: string): Promise<ServiceAnswer> {
    return new Promise((resolve, reject) => {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const socket = tls.connect({
        host,
        port: Number(url.port || 443),
        servername: net.isIP(host) ? undefined : host,
        // The certificate is self-signed: the fingerprint check below replaces the CA check.
        rejectUnauthorized: false,
      });
      const fail = (error: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`no answer in ${this.timeout} ms`)), this.timeout);
      socket.once('error', fail);
      socket.once('secureConnect', () => {
        const actual = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256);
        if (actual !== this.fingerprint) {
          fail(new Error('the fingerprint of the certificate is not equal'));
          return;
        }
        const req = https.request(url, {
          method: 'POST',
          createConnection: () => socket,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => {
            clearTimeout(timer);
            socket.destroy();
            resolve({ status: res.statusCode, body: text });
          });
          res.on('error', fail);
        });
        req.on('error', fail);
        req.end(body);
      });
    });
  }
}
