/**
 * Minimal Feishu / Lark OpenAPI client.
 *
 * Only depends on Node.js built-in modules, so the CLI has no third-party
 * runtime dependencies to install or keep up to date.
 *
 * Requests go through `node:https` rather than the global `fetch`: the CDN in
 * front of open.feishu.cn rejects undici's requests with an HTML `400 Bad
 * Request`, while byte-identical requests from `node:https` succeed.
 */

import https from 'node:https';
import { URL } from 'node:url';

const DEFAULT_DOMAIN = 'https://open.feishu.cn';

/**
 * Perform an HTTPS request and buffer the response body as text.
 *
 * @returns {Promise<{ status: number, headers: Record<string, string>, text: string }>}
 */
function httpsRequest(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (response) => {
        response.setEncoding('utf8');
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text });
        });
        response.on('error', reject);
      },
    );

    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export class FeishuError extends Error {
  constructor(message, { code, httpStatus, requestId } = {}) {
    super(message);
    this.name = 'FeishuError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
  }
}

export class FeishuClient {
  /**
   * @param {{ appId?: string, appSecret?: string, domain?: string }} [options]
   */
  constructor(options = {}) {
    this.appId = options.appId ?? process.env.FEISHU_APP_ID;
    this.appSecret = options.appSecret ?? process.env.FEISHU_APP_SECRET;
    this.domain = (options.domain ?? process.env.FEISHU_DOMAIN ?? DEFAULT_DOMAIN).replace(/\/+$/, '');
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  async getTenantAccessToken() {
    if (!this.appId || !this.appSecret) {
      throw new FeishuError(
        'Missing credentials: set FEISHU_APP_ID and FEISHU_APP_SECRET (see README).',
      );
    }
    // Refresh a minute early to avoid using a token that expires mid-flight.
    if (this._token && Date.now() < this._tokenExpiresAt - 60_000) {
      return this._token;
    }

    const body = await this._fetchJson('/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      body: { app_id: this.appId, app_secret: this.appSecret },
      auth: false,
    });

    this._token = body.tenant_access_token;
    this._tokenExpiresAt = Date.now() + (body.expire ?? 0) * 1000;
    return this._token;
  }

  /**
   * Call an OpenAPI endpoint and return its `data` payload.
   *
   * @param {string} path e.g. `/open-apis/docx/v1/documents/xxx`
   * @param {{ method?: string, body?: unknown, query?: Record<string, unknown> }} [options]
   */
  async request(path, options = {}) {
    const body = await this._fetchJson(path, options);
    return body.data ?? {};
  }

  async _fetchJson(path, { method = 'GET', body, query, auth = true } = {}) {
    const url = new URL(path, this.domain);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (auth) {
      const accessToken = await this.getTenantAccessToken();
      headers.Authorization = ['Bearer', accessToken].join(' ');
    }

    const payloadText = body === undefined ? undefined : JSON.stringify(body);
    if (payloadText !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(payloadText);
    }

    let response;
    try {
      response = await httpsRequest(url, { method, headers, body: payloadText });
    } catch (cause) {
      throw new FeishuError(
        `Network request to ${url.host} failed: ${cause.message}. ` +
          'Check that the Feishu domain is allowed by the firewall (see README).',
        { code: 'NETWORK' },
      );
    }

    const requestId = response.headers['x-tt-logid'] ?? undefined;
    const text = response.text;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new FeishuError(
        `Unexpected non-JSON response (HTTP ${response.status}) from ${url.pathname}: ${text.slice(0, 200)}`,
        { httpStatus: response.status, requestId },
      );
    }

    const ok = response.status >= 200 && response.status < 300;
    if (!ok || (payload.code !== undefined && payload.code !== 0)) {
      throw new FeishuError(
        `Feishu API error on ${method} ${url.pathname}: code=${payload.code} msg=${payload.msg ?? response.status}`,
        { code: payload.code, httpStatus: response.status, requestId },
      );
    }

    return payload;
  }
}
