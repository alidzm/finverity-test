import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from '@/auth/auth.module';
import type { AuthenticatedRequest } from '@/auth/presentation/authenticated-request';
import { CapacityModule } from '@/capacity/capacity.module';
import { AppConfig } from '@/config/app-config';
import { ConfigModule } from '@/config/config.module';
import { HealthModule } from '@/health/health.module';
import { FxModule } from '@/fx/fx.module';
import { DatabaseModule } from '@/shared/infrastructure/database/database.module';
import { ProblemDetailsFilter } from '@/shared/presentation/http/problem-details.filter';
import { KafkaModule } from '@/shared/infrastructure/kafka/kafka.module';
import { MessagingModule } from '@/shared/infrastructure/messaging/messaging.module';

const REQUEST_ID_PATTERN = /^[\w.-]{1,128}$/;

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.log.level,
          transport: config.log.pretty
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
          // Propagate a caller-supplied request id (if sane) or mint one; echoed back to the client.
          genReqId: (request: IncomingMessage, response: ServerResponse) => {
            const header = request.headers['x-request-id'];
            const id =
              typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
            response.setHeader('x-request-id', id);
            return id;
          },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          customProps: (request: IncomingMessage) => ({
            clientId: (request as AuthenticatedRequest).principal?.clientId ?? undefined,
          }),
          autoLogging: {
            ignore: (request: IncomingMessage) => request.url?.startsWith('/health') ?? false,
          },
        },
      }),
    }),
    // platform (global): database, Kafka transport, reliable messaging
    DatabaseModule,
    KafkaModule,
    MessagingModule,
    // feature modules
    AuthModule,
    FxModule,
    CapacityModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule {}
