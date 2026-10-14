import type { Observable } from 'rxjs';
import type { CapacityDto } from '@/capacity/application/dto/capacity.dto';

/** Port: committed capacity changes of all programs, pushed as they happen. */
export abstract class CapacityChangeFeed {
  /** Every committed change, across all programs, in commit order. */
  abstract readonly changes$: Observable<CapacityDto>;
  /** Changes may have been missed (e.g. after a reconnect): subscribers should re-read. */
  abstract readonly resync$: Observable<void>;
  /** Emits once on shutdown so that long-lived streams can complete. */
  abstract readonly shutdown$: Observable<void>;
}
