import { Injectable } from '@nestjs/common';
import {
  catchError,
  defer,
  EMPTY,
  filter,
  merge,
  type Observable,
  switchMap,
  takeUntil,
} from 'rxjs';
import type { CapacityDto } from '@/capacity/application/dto/capacity.dto';
import { CapacityChangeFeed } from '@/capacity/application/ports/capacity-change-feed';
import { CapacityQueries } from './capacity.queries';

/** Live capacity of one program: its current state first, then every committed change. */
@Injectable()
export class WatchCapacityQuery {
  constructor(
    private readonly queries: CapacityQueries,
    private readonly feed: CapacityChangeFeed,
  ) {}

  /** Rejects with PROGRAM_NOT_FOUND before any value is produced. */
  async execute(programId: string): Promise<Observable<CapacityDto>> {
    await this.queries.getCapacity(programId);

    // Subscribe to live changes first, then read the current state, so that no change
    // committed in between can be missed; stale or duplicate versions are filtered out.
    const reread = () =>
      defer(() => this.queries.getCapacity(programId)).pipe(catchError(() => EMPTY));
    let lastVersion = -1;
    return merge(
      this.feed.changes$.pipe(filter((change) => change.programId === programId)),
      this.feed.resync$.pipe(switchMap(reread)),
      reread(),
    ).pipe(
      filter((capacity) => {
        if (capacity.version <= lastVersion) {
          return false;
        }
        lastVersion = capacity.version;
        return true;
      }),
      takeUntil(this.feed.shutdown$),
    );
  }
}
