import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChatGPTAuth, DYNAMIC_CLIENT_ID, RESOURCE, SCOPES } from '../src/chatgpt-auth.js';
import { AiBriefs } from '../src/ai.js';

// A tiny fake OpenAI authorization server: discovery, JWKS, token endpoint,
// plus /v1/models and /v1/responses so the brief pipeline can be exercised
// end to end without the network.

interface Captured { tokenBodies: URLSearchParams[]; responsesBodies: Array<Record<string, unknown>>; authHeaders: string[] }

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function startFakeOpenAI(): Promise<{ server: http.Server; base: string; captured: Captured; signIdToken: (claims: Record<string, unknown>) => string; close: () => Promise<void> }> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const kid = 'test-key-1';
  const captured: Captured = { tokenBodies: [], responsesBodies: [], authHeaders: [] };
  let base = '';

  const signIdToken = (claims: Record<string, unknown>): string => {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const payload = b64url(JSON.stringify({ iss: base, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims }));
    const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
    return `${header}.${payload}.${b64url(sig)}`;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', base);
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, { issuer: base, authorization_endpoint: `${base}/api/accounts/authorize`, token_endpoint: `${base}/api/accounts/oauth/token`, jwks_uri: `${base}/jwks` });
    }
    if (url.pathname === '/jwks') return send(200, { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
    if (url.pathname === '/api/accounts/oauth/token') {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        captured.tokenBodies.push(body);
        if (body.get('grant_type') === 'authorization_code') {
          if (body.get('code') !== 'good-code') return send(400, { error: 'invalid_grant', error_description: 'bad code' });
          const nonce = (globalThis as Record<string, unknown>).__expectedNonce as string;
          return send(200, {
            access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: SCOPES,
            id_token: signIdToken({ aud: body.get('client_id'), sub: 'user_123', email: 'dev@example.com', name: 'Dev', nonce }),
          });
        }
        if (body.get('grant_type') === 'refresh_token') {
          return send(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, scope: SCOPES });
        }
        return send(400, { error: 'unsupported_grant_type' });
      });
      return;
    }
    if (url.pathname === '/v1/models') {
      captured.authHeaders.push(req.headers.authorization || '');
      return send(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-5-mini' }, { id: 'tts-1' }] });
    }
    if (url.pathname === '/v1/responses') {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        captured.authHeaders.push(req.headers.authorization || '');
        captured.responsesBodies.push(JSON.parse(raw) as Record<string, unknown>);
        send(200, { output: [{ type: 'message', content: [{ type: 'output_text', text: '**Brief** generated.' }] }] });
      });
      return;
    }
    send(404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      base = `http://127.0.0.1:${addr.port}`;
      resolve({
        server, base, captured, signIdToken,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function fetchOk(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { redirect: 'manual' });
  return { status: res.status, body: await res.text() };
}

describe('Sign in with ChatGPT', () => {
  let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
  let dir: string;

  before(async () => {
    fake = await startFakeOpenAI();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentacta-siwc-'));
  });
  after(async () => {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('builds a spec-compliant authorize URL and persists a host id', async () => {
    const auth = new ChatGPTAuth({ profilePath: path.join(dir, 'p1', 'chatgpt-profile.json'), appName: 'AgentActa', issuer: fake.base });
    const start = await auth.startSignIn();
    const u = new URL(start.authorize_url);
    assert.strictEqual(u.origin + u.pathname, `${fake.base}/api/accounts/authorize`);
    assert.strictEqual(u.searchParams.get('client_id'), DYNAMIC_CLIENT_ID);
    assert.strictEqual(u.searchParams.get('response_type'), 'code');
    assert.strictEqual(u.searchParams.get('scope'), SCOPES);
    assert.strictEqual(u.searchParams.get('resource'), RESOURCE);
    assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
    assert.strictEqual(u.searchParams.get('agent_name_hint'), 'AgentActa');
    assert.match(u.searchParams.get('ext_agent_host_id') || '', /^urn:uuid:[0-9a-f-]{36}$/);
    assert.match(u.searchParams.get('redirect_uri') || '', /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.ok(u.searchParams.get('state'));
    assert.ok(u.searchParams.get('nonce'));
    assert.strictEqual(start.reauth, false);
    assert.strictEqual(auth.status().pending, true);

    // Host id is stable across instances.
    const again = new ChatGPTAuth({ profilePath: path.join(dir, 'p1', 'chatgpt-profile.json'), appName: 'AgentActa', issuer: fake.base });
    assert.strictEqual(again.hostId(), u.searchParams.get('ext_agent_host_id'));
    auth.signOut();
  });

  test('rejects a callback with the wrong state', async () => {
    const auth = new ChatGPTAuth({ profilePath: path.join(dir, 'p2', 'chatgpt-profile.json'), appName: 'AgentActa', issuer: fake.base });
    const start = await auth.startSignIn();
    const r = await fetchOk(`http://127.0.0.1:${start.port}/callback?state=nope&code=good-code&client_id=oaiapp_x`);
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /State mismatch/);
    auth.signOut();
  });

  test('completes the code exchange, verifies the ID token and stores the profile 0600', async () => {
    const profilePath = path.join(dir, 'p3', 'chatgpt-profile.json');
    const auth = new ChatGPTAuth({ profilePath, appName: 'AgentActa', issuer: fake.base });
    const start = await auth.startSignIn();
    const u = new URL(start.authorize_url);
    (globalThis as Record<string, unknown>).__expectedNonce = u.searchParams.get('nonce');

    const r = await fetchOk(`http://127.0.0.1:${start.port}/callback?state=${u.searchParams.get('state')}&code=good-code&client_id=oaiapp_issued`);
    assert.strictEqual(r.status, 200, r.body);
    assert.match(r.body, /ChatGPT connected/);

    const tokenBody = fake.captured.tokenBodies.at(-1)!;
    assert.strictEqual(tokenBody.get('grant_type'), 'authorization_code');
    assert.strictEqual(tokenBody.get('client_id'), 'oaiapp_issued');
    assert.strictEqual(tokenBody.get('redirect_uri'), u.searchParams.get('redirect_uri'));
    assert.strictEqual(tokenBody.get('resource'), RESOURCE);
    // PKCE: verifier must hash to the challenge we sent.
    const expectedChallenge = b64url(crypto.createHash('sha256').update(tokenBody.get('code_verifier') || '').digest());
    assert.strictEqual(expectedChallenge, u.searchParams.get('code_challenge'));

    const status = auth.status();
    assert.strictEqual(status.connected, true);
    assert.strictEqual(status.email, 'dev@example.com');
    assert.strictEqual(status.sharing, true);
    assert.strictEqual(status.pending, false);
    const profile = auth.loadProfile()!;
    assert.strictEqual(profile.client_id, 'oaiapp_issued');
    assert.strictEqual(profile.sub, 'user_123');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(profilePath).mode & 0o777, 0o600);

    // Re-auth uses the issued client id and an id_token_hint.
    const second = await auth.startSignIn();
    const u2 = new URL(second.authorize_url);
    assert.strictEqual(u2.searchParams.get('client_id'), 'oaiapp_issued');
    assert.ok(u2.searchParams.get('id_token_hint'));
    assert.strictEqual(u2.searchParams.has('agent_name_hint'), false);
    assert.strictEqual(second.reauth, true);
    auth.signOut();
    assert.strictEqual(auth.status().connected, false);
  });

  test('rejects an ID token whose nonce does not match', async () => {
    const auth = new ChatGPTAuth({ profilePath: path.join(dir, 'p4', 'chatgpt-profile.json'), appName: 'AgentActa', issuer: fake.base });
    const start = await auth.startSignIn();
    const u = new URL(start.authorize_url);
    (globalThis as Record<string, unknown>).__expectedNonce = 'something-else';
    const r = await fetchOk(`http://127.0.0.1:${start.port}/callback?state=${u.searchParams.get('state')}&code=good-code&client_id=oaiapp_issued`);
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /nonce mismatch/);
    assert.strictEqual(auth.status().connected, false);
  });

  test('refreshes an expired access token and calls the Responses API with the user token', async () => {
    const profilePath = path.join(dir, 'p5', 'chatgpt-profile.json');
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify({
      client_id: 'oaiapp_issued', host_id: 'urn:uuid:x', sub: 'user_123', email: 'dev@example.com', name: 'Dev', picture: null,
      access_token: 'stale', refresh_token: 'refresh-1', id_token: null,
      expires_at: new Date(Date.now() - 1000).toISOString(), scope: SCOPES, sharing: true, connected_at: new Date().toISOString(),
    }));
    const auth = new ChatGPTAuth({ profilePath, appName: 'AgentActa', issuer: fake.base });
    const ai = new AiBriefs({ auth, apiBase: `${fake.base}/v1` });

    const model = await ai.resolveModel();
    assert.strictEqual(model, 'gpt-5-mini');
    const refreshBody = fake.captured.tokenBodies.find(b => b.get('grant_type') === 'refresh_token')!;
    assert.ok(refreshBody, 'refresh grant was sent');
    assert.strictEqual(refreshBody.get('client_id'), 'oaiapp_issued');
    assert.strictEqual(auth.loadProfile()!.access_token, 'access-2');

    const out = await ai.complete('instructions', 'input');
    assert.strictEqual(out.text, '**Brief** generated.');
    assert.strictEqual(out.model, 'gpt-5-mini');
    assert.strictEqual(fake.captured.authHeaders.at(-1), 'Bearer access-2');
    const body = fake.captured.responsesBodies.at(-1)!;
    assert.strictEqual(body.model, 'gpt-5-mini');
    assert.strictEqual(body.store, false);
    assert.strictEqual(body.instructions, 'instructions');
  });
});
