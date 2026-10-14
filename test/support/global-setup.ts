import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '@/shared/infrastructure/database/migrations';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    kafkaBrokers: string;
  }
}

/** Starts one PostgreSQL and one Kafka (KRaft) container shared by all e2e test files. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let postgres: StartedPostgreSqlContainer | undefined;
  let kafka: StartedKafkaContainer | undefined;
  try {
    [postgres, kafka] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine')
        .withCommand(['postgres', '-c', 'max_connections=300', '-c', 'fsync=off'])
        .start(),
      new KafkaContainer('confluentinc/cp-kafka:8.2.4').start(),
    ]);
    await runMigrations(postgres.getConnectionUri());
    project.provide('databaseUrl', postgres.getConnectionUri());
    project.provide('kafkaBrokers', `${kafka.getHost()}:${kafka.getMappedPort(9093)}`);
  } catch (error) {
    await Promise.allSettled([postgres?.stop(), kafka?.stop()]);
    throw error;
  }
  return async () => {
    await Promise.allSettled([postgres?.stop(), kafka?.stop()]);
  };
}
