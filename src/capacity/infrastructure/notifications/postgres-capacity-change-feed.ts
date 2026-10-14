import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { type Observable, Subject } from 'rxjs';
import type { CapacityDto } from '@/capacity/application/dto/capacity.dto';
import { CapacityChangeFeed } from '@/capacity/application/ports/capacity-change-feed';
import { CAPACITY_CHANGED_CHANNEL } from '@/capacity/infrastructure/persistence/postgres-capacity-journal';
import { AppConfig } from '@/config/app-config';

const RECONNECT_DELAY_MS = 2_000;

/**
 * `CapacityChangeFeed` over PostgreSQL LISTEN/NOTIFY: one dedicated connection per
 * instance fans committed changes out to in-process subscribers. Works across
 * horizontally scaled instances because every instance listens to the same channel.
 */
@Injectable()
export class PostgresCapacityChangeFeed
  extends CapacityChangeFeed
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PostgresCapacityChangeFeed.name);
  private readonly changesSubject = new Subject<CapacityDto>();
  private readonly resyncSubject = new Subject<void>();
  private readonly shutdownSubject = new Subject<void>();
  private client?: pg.Client;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private hasConnected = false;

  readonly changes$: Observable<CapacityDto> = this.changesSubject.asObservable();
  readonly resync$: Observable<void> = this.resyncSubject.asObservable();
  readonly shutdown$: Observable<void> = this.shutdownSubject.asObservable();

  constructor(private readonly config: AppConfig) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.connect().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'LISTEN connection failed; retrying');
      this.scheduleReconnect();
    });
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.config.database.url,
      application_name: 'capacity-service-listener',
      keepAlive: true,
    });
    client.on('notification', (message) => {
      if (message.channel !== CAPACITY_CHANGED_CHANNEL || !message.payload) {
        return;
      }
      try {
        this.changesSubject.next(JSON.parse(message.payload) as CapacityDto);
      } catch (error) {
        this.logger.warn({ err: error }, 'Ignoring malformed capacity notification');
      }
    });
    client.on('error', (error) => {
      this.logger.warn({ err: error }, 'LISTEN connection lost');
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    });
    await client.connect();
    await client.query(`LISTEN ${CAPACITY_CHANGED_CHANNEL}`);
    this.client = client;
    if (this.hasConnected) {
      // Notifications sent while disconnected are lost; tell subscribers to re-read.
      this.resyncSubject.next();
    }
    this.hasConnected = true;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.client = undefined;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'LISTEN reconnect failed; retrying');
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.shutdownSubject.next();
    this.shutdownSubject.complete();
    this.changesSubject.complete();
    await this.client?.end().catch(() => undefined);
  }
}
