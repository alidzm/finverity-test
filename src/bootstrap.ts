import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppConfig } from '@/config/app-config';

/** Applies the HTTP-level setup shared by `main.ts` and the e2e tests. */
export function configureApp(app: NestExpressApplication, options = { shutdownHooks: true }): void {
  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  if (options.shutdownHooks) {
    app.enableShutdownHooks();
  }
  const { http } = app.get(AppConfig);
  if (http.swaggerEnabled) {
    setupSwagger(app);
  }
  if (http.devUiEnabled) {
    // Static manual-test console; the page is public, its API calls still need a bearer token.
    app.useStaticAssets(path.resolve('dev-ui'), { prefix: '/ui' });
  }
}

function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Program Capacity API')
      .setDescription(
        'Tracks financing-program capacity: invoice reservations, repayment releases and live availability. ' +
          'Errors are RFC 9457 problem+json documents with a stable `code`.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
}
