import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const positiveInt = z.coerce.number().int().positive();

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: booleanFlag.default(false),
    SWAGGER_ENABLED: booleanFlag.default(false),
    DEV_UI_ENABLED: booleanFlag.default(false),

    DATABASE_URL: z.url(),
    DATABASE_POOL_MAX: positiveInt.default(20),

    AUTH_ISSUER: z.url(),
    AUTH_AUDIENCE: z.string().min(1),
    AUTH_JWKS_URI: z.url(),

    KAFKA_BROKERS: z.string().min(1),
    KAFKA_CLIENT_ID: z.string().min(1).default('capacity-service'),
    KAFKA_CONSUMER_GROUP: z.string().min(1).default('capacity-service'),
    KAFKA_SSL: booleanFlag.default(false),
    KAFKA_SASL_MECHANISM: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).optional(),
    KAFKA_SASL_USERNAME: z.string().optional(),
    KAFKA_SASL_PASSWORD: z.string().optional(),
    KAFKA_TOPIC_PROGRAM_CAPACITY: z.string().min(1).default('treasury.program-capacity.v1'),
    KAFKA_TOPIC_FX_RATES: z.string().min(1).default('treasury.fx-rates.v1'),
    KAFKA_TOPIC_CAPACITY_EVENTS: z.string().min(1).default('capacity.events.v1'),
    KAFKA_DLQ_SUFFIX: z.string().min(1).default('.dlq'),

    CONSUMERS_ENABLED: booleanFlag.default(true),
    OUTBOX_RELAY_ENABLED: booleanFlag.default(true),
    OUTBOX_POLL_INTERVAL_MS: positiveInt.default(500),
    OUTBOX_BATCH_SIZE: positiveInt.max(1000).default(100),

    FX_MAX_RATE_AGE_SECONDS: positiveInt.default(86_400),
    RECONCILIATION_GRACE_SECONDS: z.coerce.number().int().min(0).default(300),
    SSE_HEARTBEAT_INTERVAL_MS: positiveInt.default(15_000),
  })
  .refine(
    (env) => !env.KAFKA_SASL_MECHANISM || (env.KAFKA_SASL_USERNAME && env.KAFKA_SASL_PASSWORD),
    {
      message:
        'KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required when KAFKA_SASL_MECHANISM is set',
      path: ['KAFKA_SASL_MECHANISM'],
    },
  );

export type KafkaSaslConfig = {
  mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  username: string;
  password: string;
};

/** Typed, validated application configuration. Built once from the environment at startup. */
export class AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly http: { port: number; swaggerEnabled: boolean; devUiEnabled: boolean };
  readonly log: { level: string; pretty: boolean };
  readonly database: { url: string; poolMax: number };
  readonly auth: { issuer: string; audience: string; jwksUri: string };
  readonly kafka: {
    brokers: string[];
    clientId: string;
    consumerGroup: string;
    ssl: boolean;
    sasl?: KafkaSaslConfig;
    topics: { programCapacity: string; fxRates: string; capacityEvents: string };
    dlqSuffix: string;
    consumersEnabled: boolean;
  };
  readonly outbox: { relayEnabled: boolean; pollIntervalMs: number; batchSize: number };
  readonly fx: { maxRateAgeMs: number };
  readonly reconciliation: { graceMs: number };
  readonly sse: { heartbeatIntervalMs: number };

  private constructor(env: z.output<typeof EnvSchema>) {
    this.env = env.NODE_ENV;
    this.http = {
      port: env.PORT,
      swaggerEnabled: env.SWAGGER_ENABLED,
      devUiEnabled: env.DEV_UI_ENABLED,
    };
    this.log = { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY };
    this.database = { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX };
    this.auth = {
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      jwksUri: env.AUTH_JWKS_URI,
    };
    this.kafka = {
      brokers: env.KAFKA_BROKERS.split(',')
        .map((broker) => broker.trim())
        .filter(Boolean),
      clientId: env.KAFKA_CLIENT_ID,
      consumerGroup: env.KAFKA_CONSUMER_GROUP,
      ssl: env.KAFKA_SSL,
      sasl: env.KAFKA_SASL_MECHANISM
        ? {
            mechanism: env.KAFKA_SASL_MECHANISM,
            username: env.KAFKA_SASL_USERNAME!,
            password: env.KAFKA_SASL_PASSWORD!,
          }
        : undefined,
      topics: {
        programCapacity: env.KAFKA_TOPIC_PROGRAM_CAPACITY,
        fxRates: env.KAFKA_TOPIC_FX_RATES,
        capacityEvents: env.KAFKA_TOPIC_CAPACITY_EVENTS,
      },
      dlqSuffix: env.KAFKA_DLQ_SUFFIX,
      consumersEnabled: env.CONSUMERS_ENABLED,
    };
    this.outbox = {
      relayEnabled: env.OUTBOX_RELAY_ENABLED,
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
    };
    this.fx = { maxRateAgeMs: env.FX_MAX_RATE_AGE_SECONDS * 1000 };
    this.reconciliation = { graceMs: env.RECONCILIATION_GRACE_SECONDS * 1000 };
    this.sse = { heartbeatIntervalMs: env.SSE_HEARTBEAT_INTERVAL_MS };
  }

  /** Fails fast with a readable list of problems if the environment is invalid. */
  static fromEnv(env: Record<string, string | undefined>): AppConfig {
    const result = EnvSchema.safeParse(env);
    if (!result.success) {
      const problems = result.error.issues
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n');
      throw new Error(`Invalid configuration:\n${problems}`);
    }
    return new AppConfig(result.data);
  }
}
