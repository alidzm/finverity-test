import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import supertest from 'supertest';
import { inject } from 'vitest';
import { AppModule } from '@/app.module';
import { JWKS_KEY_RESOLVER } from '@/auth/infrastructure/jose-token-verifier';
import { configureApp } from '@/bootstrap';
import { AppConfig } from '@/config/app-config';

export const ISSUER = 'https://idp.test/realms/capacity';
export const AUDIENCE = 'capacity-service';
export const ALL_SCOPES = 'capacity:read capacity:reserve capacity:release';

export interface TokenOptions {
  scope?: string;
  clientId?: string;
  audience?: string;
  issuer?: string;
  expiresIn?: string;
}

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<typeof supertest>;
  /** Signs a token with the test key (accepted by the app unless claims are wrong). */
  token(options?: TokenOptions): Promise<string>;
  /** Shorthand: `Authorization` header value with all scopes. */
  auth: string;
  config: AppConfig;
  close(): Promise<void>;
}

/**
 * Boots the real AppModule against the Testcontainers database/broker. Only the JWKS source
 * is swapped for a local key pair, so the full authentication path is exercised.
 */
export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  const config = AppConfig.fromEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: inject('databaseUrl'),
    DATABASE_POOL_MAX: '20',
    AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: AUDIENCE,
    AUTH_JWKS_URI: 'https://idp.test/certs',
    KAFKA_BROKERS: inject('kafkaBrokers'),
    CONSUMERS_ENABLED: 'false',
    OUTBOX_RELAY_ENABLED: 'false',
    SSE_HEARTBEAT_INTERVAL_MS: '60000',
    ...env,
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppConfig)
    .useValue(config)
    .overrideProvider(JWKS_KEY_RESOLVER)
    .useValue(createLocalJWKSet({ keys: [jwk] }))
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app, { shutdownHooks: false });
  await app.init();

  const token = (options: TokenOptions = {}) =>
    new SignJWT({ scope: options.scope ?? ALL_SCOPES, azp: options.clientId ?? 'test-client' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setSubject(options.clientId ?? 'test-client')
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign(privateKey);

  return {
    app,
    http: supertest(app.getHttpServer()),
    token,
    auth: `Bearer ${await token()}`,
    config,
    close: () => app.close(),
  };
}

export const uniqueId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
