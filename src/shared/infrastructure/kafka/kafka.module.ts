import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AppConfig } from '@/config/app-config';
import { createKafka, KAFKA } from './kafka.client';
import { KafkaConsumerRunner } from './kafka-consumer.runner';
import { KafkaProducer } from './kafka.producer';

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    { provide: KAFKA, inject: [AppConfig], useFactory: createKafka },
    KafkaProducer,
    KafkaConsumerRunner,
  ],
  exports: [KAFKA, KafkaProducer, KafkaConsumerRunner],
})
export class KafkaModule {}
