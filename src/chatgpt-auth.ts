import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─── Sign in with ChatGPT ────────────────────────────────────────────
// Implements OpenAI's "Sign in with ChatGPT" for open-source apps that run on
// the user's own machine, with no SDK and no client secret:
//
//   1. Open the system browser at the authorization endpoint with PKCE,
//      client_id=dynamic_agent_client (OpenAI registers the app on the fly and
//      hands back an issued client id on the callback).
//   2. Receive the code on an http://127.0.0.1:{port}/callback listener.
//   3. Exchange it at the token endpoint, verify the ID token against OpenAI's
//      JWKS, and store the profile (0600) next to the AgentActa config.
//
// The access token can then call the Responses API with the user's own
// ChatGPT plan. AgentActa only uses it when the user explicitly asks for an
// AI brief; nothing is sent automatically.

export const DEFAULT_ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

export interface ChatGPTProfile {
  client_id: string;
  host_id: string;
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  access_token: string;
  refresh_token: string | null;
  id_token: string | null;
  expires_at: string;
  scope: string;
  sharing: boolean;
  connected_at: string;
}

export interface ChatGPTStatus {
  connected: boolean;
  pending: boolean;
  email: string | null;
  name: string | null;
  sharing: boolean;
  expires_at: string | null;
  last_error: string | null;
  issuer: string;
}

export interface SignInStart {
  authorize_url: string;
  port: number;
  expires_at: string;
  reauth: boolean;
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface JwkKey { kid?: string; kty: string; alg?: string; use?: string; n?: string; e?: string; crv?: string; x?: string; y?: string }

export interface ChatGPTAuthOptions {
  profilePath: string;
  appName: string;
  issuer?: string;
  fetchImpl?: typeof fetch;
  /** Skip ID token signature verification. Tests only. */
  insecureSkipIdTokenVerification?: boolean;
  signInTimeoutMs?: number;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(fromB64url(part).toString('utf8')) as Record<string, unknown>;
}

const CALLBACK_HTML = (ok: boolean, message: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>AgentActa · ${ok ? 'Connected' : 'Sign-in failed'}</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#0a0e1a;color:#e4e9f2;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#151b2e;border:1px solid #1c2540;border-radius:14px;padding:32px 36px;max-width:420px;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{color:#8b95ae;margin:0;font-size:14px;line-height:1.5}
.ok{color:#4ade80}.bad{color:#f472b6}</style></head>
<body><div class="card"><h1 class="${ok ? 'ok' : 'bad'}">${ok ? 'ChatGPT connected' : 'Sign-in failed'}</h1><p>${message}</p></div></body></html>`;

export class ChatGPTAuth {
  private readonly opts: Required<Pick<ChatGPTAuthOptions, 'profilePath' | 'appName' | 'issuer' | 'signInTimeoutMs'>> & ChatGPTAuthOptions;
  private readonly fetchImpl: typeof fetch;
  private discovery: OidcDiscovery | null = null;
  private jwksCache: { at: number; keys: JwkKey[] } | null = null;
  private pending: { server: http.Server; timer: NodeJS.Timeout } | null = null;
  private lastError: string | null = null;
  private refreshing: Promise<ChatGPTProfile> | null = null;

  constructor(options: ChatGPTAuthOptions) {
    // Spread after defaults would let an explicit `undefined` wipe them out.
    this.opts = {
      ...options,
      issuer: options.issuer || DEFAULT_ISSUER,
      signInTimeoutMs: options.signInTimeoutMs || 10 * 60_000,
    } as ChatGPTAuth['opts'];
    this.fetchImpl = options.fetchImpl || fetch;
  }

  // ── Profile storage ──

  loadProfile(): ChatGPTProfile | null {
    try {
      const raw = fs.readFileSync(this.opts.profilePath, 'utf8');
      const parsed = JSON.parse(raw) as ChatGPTProfile;
      return parsed && typeof parsed.access_token === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  private saveProfile(profile: ChatGPTProfile): void {
    const dir = path.dirname(this.opts.profilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.opts.profilePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.opts.profilePath);
    try { fs.chmodSync(this.opts.profilePath, 0o600); } catch { /* best effort */ }
  }

  private hostIdPath(): string {
    return path.join(path.dirname(this.opts.profilePath), 'chatgpt-host.json');
  }

  /** Stable per-installation identifier (urn:uuid) OpenAI requires on every authorize request. */
  hostId(): string {
    const p = this.hostIdPath();
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { host_id?: string };
      if (parsed && typeof parsed.host_id === 'string' && parsed.host_id.startsWith('urn:uuid:')) return parsed.host_id;
    } catch { /* create below */ }
    const hostId = `urn:uuid:${crypto.randomUUID()}`;
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify({ host_id: hostId, created_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    return hostId;
  }

  signOut(): boolean {
    this.cancelPending('Sign-in cancelled');
    try { fs.unlinkSync(this.opts.profilePath); return true; } catch { return false; }
  }

  status(): ChatGPTStatus {
    const profile = this.loadProfile();
    return {
      connected: !!profile,
      pending: !!this.pending,
      email: profile?.email || null,
      name: profile?.name || null,
      sharing: !!profile?.sharing,
      expires_at: profile?.expires_at || null,
      last_error: this.lastError,
      issuer: this.opts.issuer,
    };
  }

  // ── Discovery / JWKS ──

  private async discover(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    const fallback: OidcDiscovery = {
      issuer: this.opts.issuer,
      authorization_endpoint: `${this.opts.issuer}/api/accounts/authorize`,
      token_endpoint: `${this.opts.issuer}/api/accounts/oauth/token`,
      jwks_uri: `${this.opts.issuer}/.well-known/jwks.json`,
    };
    try {
      const res = await this.fetchImpl(`${this.opts.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const doc = await res.json() as Partial<OidcDiscovery>;
        this.discovery = {
          issuer: doc.issuer || fallback.issuer,
          authorization_endpoint: doc.authorization_endpoint || fallback.authorization_endpoint,
          token_endpoint: doc.token_endpoint || fallback.token_endpoint,
          jwks_uri: doc.jwks_uri || fallback.jwks_uri,
        };
        return this.discovery;
      }
    } catch { /* use fallback endpoints */ }
    this.discovery = fallback;
    return fallback;
  }

  private async jwks(force: boolean = false): Promise<JwkKey[]> {
    if (!force && this.jwksCache && Date.now() - this.jwksCache.at < 6 * 3_600_000) return this.jwksCache.keys;
    const { jwks_uri } = await this.discover();
    const res = await this.fetchImpl(jwks_uri, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
    const doc = await res.json() as { keys?: JwkKey[] };
    this.jwksCache = { at: Date.now(), keys: doc.keys || [] };
    return this.jwksCache.keys;
  }

  async verifyIdToken(idToken: string, expected: { clientId: string; nonce: string }): Promise<Record<string, unknown>> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('Malformed ID token');
    const header = decodeJwtPart(parts[0]) as { alg?: string; kid?: string };
    const claims = decodeJwtPart(parts[1]);

    if (!this.opts.insecureSkipIdTokenVerification) {
      const alg = header.alg || '';
      if (alg !== 'RS256' && alg !== 'ES256') throw new Error(`Unsupported ID token algorithm: ${alg}`);
      let keys = await this.jwks();
      let jwk = keys.find(k => k.kid === header.kid) || null;
      if (!jwk) { keys = await this.jwks(true); jwk = keys.find(k => k.kid === header.kid) || null; }
      if (!jwk) throw new Error('ID token signed with an unknown key');
      const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
      const data = Buffer.from(`${parts[0]}.${parts[1]}`);
      const sig = fromB64url(parts[2]);
      const ok = alg === 'RS256'
        ? crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig)
        : crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
      if (!ok) throw new Error('ID token signature invalid');
    }

    const { issuer } = await this.discover();
    const iss = String(claims.iss || '');
    if (iss.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) throw new Error(`ID token issuer mismatch (${iss})`);
    const aud = claims.aud;
    const audOk = Array.isArray(aud) ? aud.includes(expected.clientId) : aud === expected.clientId;
    if (!audOk) throw new Error('ID token audience mismatch');
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('ID token expired');
    if (claims.nonce !== expected.nonce) throw new Error('ID token nonce mismatch');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('ID token missing subject');
    return claims;
  }

  // ── Sign-in flow ──

  private cancelPending(reason: string): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    try { this.pending.server.close(); } catch { /* ignore */ }
    this.pending = null;
    if (reason) this.lastError = reason;
  }

  /**
   * Start a sign-in: binds a loopback callback listener and returns the URL the
   * browser must open. Resolves once the listener is bound; the exchange itself
   * completes asynchronously when the browser hits the callback.
   */
  async startSignIn(opts: { loginHint?: string } = {}): Promise<SignInStart> {
    this.cancelPending('');
    this.lastError = null;

    const existing = this.loadProfile();
    const reauth = !!existing?.client_id;
    const clientId = existing?.client_id || DYNAMIC_CLIENT_ID;
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const discovery = await this.discover();

    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ext_agent_host_id: this.hostId(),
    });
    if (!reauth) params.set('agent_name_hint', this.opts.appName);
    if (reauth && existing?.id_token) params.set('id_token_hint', existing.id_token);
    if (opts.loginHint) params.set('login_hint', opts.loginHint);
    const authorizeUrl = `${discovery.authorization_endpoint}?${params.toString()}`;

    const timer = setTimeout(() => this.cancelPending('Sign-in timed out; please try again.'), this.opts.signInTimeoutMs);
    timer.unref?.();
    this.pending = { server, timer };

    server.on('request', (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const finish = (ok: boolean, message: string): void => {
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(CALLBACK_HTML(ok, message));
        // The flow is over as soon as we answer; let the response flush before
        // tearing the listener down.
        const current = this.pending;
        if (current && current.server === server) {
          clearTimeout(current.timer);
          this.pending = null;
          if (!ok) this.lastError = message;
          setTimeout(() => { try { server.close(); } catch { /* ignore */ } }, 200).unref?.();
        }
      };

      if (url.searchParams.get('state') !== state) return finish(false, 'State mismatch. Start the sign-in again from AgentActa.');
      const oauthError = url.searchParams.get('error');
      if (oauthError) return finish(false, `${oauthError}: ${url.searchParams.get('error_description') || 'the authorization was not granted.'}`);
      const code = url.searchParams.get('code');
      if (!code) return finish(false, 'No authorization code was returned.');
      const issuedClientId = url.searchParams.get('client_id') || clientId;
      if (issuedClientId === DYNAMIC_CLIENT_ID) return finish(false, 'OpenAI did not issue a client id for this app.');

      this.exchangeCode({ code, verifier, redirectUri, clientId: issuedClientId, nonce, tokenEndpoint: discovery.token_endpoint })
        .then(() => finish(true, 'You can close this tab and return to AgentActa.'))
        .catch((err: Error) => finish(false, err.message));
    });

    return { authorize_url: authorizeUrl, port, expires_at: new Date(Date.now() + this.opts.signInTimeoutMs).toISOString(), reauth };
  }

  private async tokenRequest(tokenEndpoint: string, body: URLSearchParams): Promise<TokenResponse> {
    const res = await this.fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const desc = (data.error_description as string) || (data.error as string) || text.slice(0, 200) || `HTTP ${res.status}`;
      throw new Error(`Token request failed: ${desc}`);
    }
    if (typeof data.access_token !== 'string') throw new Error('Token response had no access_token');
    return data as unknown as TokenResponse;
  }

  private async exchangeCode(input: { code: string; verifier: string; redirectUri: string; clientId: string; nonce: string; tokenEndpoint: string }): Promise<ChatGPTProfile> {
    const token = await this.tokenRequest(input.tokenEndpoint, new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      resource: RESOURCE,
    }));
    if (!token.id_token) throw new Error('Token response had no ID token');
    const claims = await this.verifyIdToken(token.id_token, { clientId: input.clientId, nonce: input.nonce });
    const scope = token.scope || SCOPES;
    const profile: ChatGPTProfile = {
      client_id: input.clientId,
      host_id: this.hostId(),
      sub: String(claims.sub),
      email: typeof claims.email === 'string' ? claims.email : null,
      name: typeof claims.name === 'string' ? claims.name : null,
      picture: typeof claims.picture === 'string' ? claims.picture : null,
      access_token: token.access_token,
      refresh_token: token.refresh_token || null,
      id_token: token.id_token,
      expires_at: new Date(Date.now() + Math.max(60, token.expires_in || 3600) * 1000).toISOString(),
      scope,
      sharing: scope.split(/\s+/).includes(PLAN_SCOPE),
      connected_at: new Date().toISOString(),
    };
    this.saveProfile(profile);
    this.lastError = null;
    return profile;
  }

  private async refresh(profile: ChatGPTProfile): Promise<ChatGPTProfile> {
    if (!profile.refresh_token) throw new Error('Session expired and no refresh token is available; sign in again.');
    const { token_endpoint } = await this.discover();
    const token = await this.tokenRequest(token_endpoint, new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: profile.client_id,
      refresh_token: profile.refresh_token,
      resource: RESOURCE,
    }));
    const scope = token.scope || profile.scope;
    const next: ChatGPTProfile = {
      ...profile,
      access_token: token.access_token,
      refresh_token: token.refresh_token || profile.refresh_token,
      id_token: token.id_token || profile.id_token,
      expires_at: new Date(Date.now() + Math.max(60, token.expires_in || 3600) * 1000).toISOString(),
      scope,
      sharing: scope.split(/\s+/).includes(PLAN_SCOPE),
    };
    this.saveProfile(next);
    return next;
  }

  /** Returns a valid access token, refreshing when it is within 60s of expiry. */
  async getAccessToken(): Promise<{ token: string; profile: ChatGPTProfile }> {
    const profile = this.loadProfile();
    if (!profile) throw new Error('Not connected to ChatGPT');
    const expiresMs = Date.parse(profile.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs - Date.now() > 60_000) return { token: profile.access_token, profile };
    if (!this.refreshing) {
      this.refreshing = this.refresh(profile).finally(() => { this.refreshing = null; });
    }
    const fresh = await this.refreshing;
    return { token: fresh.access_token, profile: fresh };
  }
}
