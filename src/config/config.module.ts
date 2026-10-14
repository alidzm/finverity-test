import { Global, Module } from '@nestjs/common';
import { AppConfig } from './app-config';

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => AppConfig.fromEnv(process.env) }],
  exports: [AppConfig],
})
export class ConfigModule {}
