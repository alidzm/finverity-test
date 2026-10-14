import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { createRemoteJWKSet } from 'jose';
import { TokenVerifier } from '@/auth/application/token-verifier';
import { JoseTokenVerifier, JWKS_KEY_RESOLVER } from '@/auth/infrastructure/jose-token-verifier';
import { AuthGuard } from '@/auth/presentation/auth.guard';
import { AppConfig } from '@/config/app-config';

@Module({
  providers: [
    {
      provide: JWKS_KEY_RESOLVER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        createRemoteJWKSet(new URL(config.auth.jwksUri), {
          timeoutDuration: 5_000,
          cooldownDuration: 30_000,
          cacheMaxAge: 10 * 60_000,
        }),
    },
    { provide: TokenVerifier, useClass: JoseTokenVerifier },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
