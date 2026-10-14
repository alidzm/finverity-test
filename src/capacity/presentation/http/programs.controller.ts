import { Controller, Get, type MessageEvent, Param, Query, Sse } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  endWith,
  ignoreElements,
  interval,
  map,
  merge,
  type Observable,
  share,
  takeUntil,
} from 'rxjs';
import { SCOPES } from '@/auth/domain/principal';
import { RequireScopes } from '@/auth/presentation/decorators';
import type { CapacityDto } from '@/capacity/application/dto/capacity.dto';
import type { Page } from '@/capacity/application/dto/page';
import { CapacityQueries } from '@/capacity/application/queries/capacity.queries';
import { WatchCapacityQuery } from '@/capacity/application/queries/watch-capacity.query';
import { AppConfig } from '@/config/app-config';
import { ZodValidationPipe } from '@/shared/presentation/http/zod-validation.pipe';
import {
  type ListProgramsQuery,
  ListProgramsQuerySchema,
  ProgramParamsSchema,
} from './request.schemas';

@ApiTags('Capacity')
@ApiBearerAuth()
@ApiResponse({ status: 401, description: 'Missing, invalid or expired access token' })
@ApiResponse({ status: 403, description: 'Token lacks the `capacity:read` scope' })
@Controller('v1/programs')
export class ProgramsController {
  constructor(
    private readonly queries: CapacityQueries,
    private readonly watchCapacity: WatchCapacityQuery,
    private readonly config: AppConfig,
  ) {}

  @Get()
  @RequireScopes(SCOPES.READ)
  @ApiOperation({ summary: 'List programs with their current capacity' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string' } })
  list(
    @Query(new ZodValidationPipe(ListProgramsQuerySchema)) query: ListProgramsQuery,
  ): Promise<Page<CapacityDto>> {
    return this.queries.listPrograms(query);
  }

  @Get(':programId/capacity')
  @RequireScopes(SCOPES.READ)
  @ApiOperation({ summary: 'Current credit limit, reserved and available capacity of a program' })
  @ApiParam({ name: 'programId', example: 'PRG-USD-001' })
  @ApiResponse({
    status: 200,
    description: 'Capacity snapshot (amounts are decimal strings in program currency)',
  })
  @ApiResponse({ status: 404, description: 'PROGRAM_NOT_FOUND' })
  getCapacity(
    @Param(new ZodValidationPipe(ProgramParamsSchema)) params: { programId: string },
  ): Promise<CapacityDto> {
    return this.queries.getCapacity(params.programId);
  }

  /**
   * Server-Sent Events: the current capacity first, then every committed change
   * (`event: capacity`, `id: <version>`) plus periodic `event: heartbeat` messages.
   */
  @Sse(':programId/capacity/stream')
  @RequireScopes(SCOPES.READ)
  @ApiOperation({ summary: 'Live capacity updates (Server-Sent Events)' })
  @ApiProduces('text/event-stream')
  @ApiParam({ name: 'programId', example: 'PRG-USD-001' })
  @ApiResponse({ status: 404, description: 'PROGRAM_NOT_FOUND' })
  async stream(
    @Param(new ZodValidationPipe(ProgramParamsSchema)) { programId }: { programId: string },
  ): Promise<Observable<MessageEvent>> {
    // Rejects with 404 before the stream (and its 200 status) starts.
    const capacity$ = (await this.watchCapacity.execute(programId)).pipe(share());
    // Heartbeats keep proxies from closing idle streams; they stop when the stream completes.
    const heartbeat$ = interval(this.config.sse.heartbeatIntervalMs).pipe(
      map((): MessageEvent => ({ type: 'heartbeat', data: { at: new Date().toISOString() } })),
      takeUntil(capacity$.pipe(ignoreElements(), endWith(true))),
    );
    return merge(
      capacity$.pipe(
        map((capacity): MessageEvent => ({
          type: 'capacity',
          id: String(capacity.version),
          data: capacity,
        })),
      ),
      heartbeat$,
    );
  }
}
