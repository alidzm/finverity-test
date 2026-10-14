import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { type Principal, SCOPES } from '@/auth/domain/principal';
import type { AuthenticatedRequest } from '@/auth/presentation/authenticated-request';
import { CurrentPrincipal, RequireScopes } from '@/auth/presentation/decorators';
import type { Page } from '@/capacity/application/dto/page';
import {
  type ReleaseDto,
  type ReservationDto,
  toReleaseDto,
  toReservationDto,
} from '@/capacity/application/dto/reservation.dto';
import { CapacityQueries } from '@/capacity/application/queries/capacity.queries';
import { ReleaseCapacityUseCase } from '@/capacity/application/use-cases/release-capacity.use-case';
import { ReserveCapacityUseCase } from '@/capacity/application/use-cases/reserve-capacity.use-case';
import { openApiSchema } from '@/shared/presentation/http/openapi';
import { ZodValidationPipe } from '@/shared/presentation/http/zod-validation.pipe';
import { apiContext } from './api-context';
import {
  type CreateReleaseBody,
  CreateReleaseBodySchema,
  type CreateReservationBody,
  CreateReservationBodySchema,
  type ListReservationsQueryParams,
  ListReservationsQuerySchema,
  ProgramParamsSchema,
  ReservationParamsSchema,
} from './request.schemas';

@ApiTags('Reservations')
@ApiBearerAuth()
@ApiParam({ name: 'programId', example: 'PRG-USD-001' })
@ApiResponse({ status: 401, description: 'Missing, invalid or expired access token' })
@ApiResponse({ status: 403, description: 'Token lacks the required scope' })
@Controller('v1/programs/:programId/reservations')
export class ReservationsController {
  constructor(
    private readonly reserveCapacity: ReserveCapacityUseCase,
    private readonly releaseCapacity: ReleaseCapacityUseCase,
    private readonly queries: CapacityQueries,
  ) {}

  @Post()
  @RequireScopes(SCOPES.RESERVE)
  @ApiOperation({
    summary: 'Reserve capacity for an approved invoice',
    description:
      'Converts the invoice amount into the program currency at the current treasury rate (rounded up) ' +
      'and locks that rate for the life of the reservation. Idempotent per invoiceId.',
  })
  @ApiBody({ schema: openApiSchema(CreateReservationBodySchema) })
  @ApiResponse({ status: 201, description: 'Reservation created' })
  @ApiResponse({
    status: 200,
    description: 'Identical reservation already existed (idempotent replay)',
  })
  @ApiResponse({ status: 404, description: 'PROGRAM_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'RESERVATION_CONFLICT — invoice already reserved with another amount',
  })
  @ApiResponse({
    status: 422,
    description:
      'INSUFFICIENT_CAPACITY, PROGRAM_SUSPENDED, UNSUPPORTED_CURRENCY, FX_RATE_NOT_FOUND',
  })
  @ApiResponse({ status: 503, description: 'FX_RATE_STALE — no sufficiently recent exchange rate' })
  async create(
    @Param(new ZodValidationPipe(ProgramParamsSchema)) { programId }: { programId: string },
    @Body(new ZodValidationPipe(CreateReservationBodySchema)) body: CreateReservationBody,
    @CurrentPrincipal() principal: Principal,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReservationDto> {
    const result = await this.reserveCapacity.execute(
      { programId, ...body },
      apiContext(principal, request),
    );
    response.status(result.created ? 201 : 200);
    response.location(
      `/v1/programs/${encodeURIComponent(programId)}/reservations/${encodeURIComponent(body.invoiceId)}`,
    );
    return toReservationDto(result.reservation);
  }

  @Get()
  @RequireScopes(SCOPES.READ)
  @ApiOperation({ summary: 'List reservations of a program (oldest first)' })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'RELEASED'] })
  @ApiQuery({ name: 'discrepancy', required: false, enum: ['true', 'false'] })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string' } })
  list(
    @Param(new ZodValidationPipe(ProgramParamsSchema)) { programId }: { programId: string },
    @Query(new ZodValidationPipe(ListReservationsQuerySchema)) query: ListReservationsQueryParams,
  ): Promise<Page<ReservationDto>> {
    return this.queries.listReservations(programId, query);
  }

  @Get(':invoiceId')
  @RequireScopes(SCOPES.READ)
  @ApiOperation({ summary: 'Get a reservation, including its releases' })
  @ApiParam({ name: 'invoiceId', example: 'INV-2026-000123' })
  @ApiResponse({ status: 404, description: 'PROGRAM_NOT_FOUND or RESERVATION_NOT_FOUND' })
  get(
    @Param(new ZodValidationPipe(ReservationParamsSchema))
    params: {
      programId: string;
      invoiceId: string;
    },
  ): Promise<ReservationDto> {
    return this.queries.getReservation(params.programId, params.invoiceId);
  }

  @Post(':invoiceId/releases')
  @RequireScopes(SCOPES.RELEASE)
  @ApiOperation({
    summary: 'Release capacity after a (partial) repayment',
    description:
      'Releases the repaid share of the reservation at the rate locked when it was created. ' +
      'Omit `amount` to release everything outstanding. Idempotent per releaseId.',
  })
  @ApiParam({ name: 'invoiceId', example: 'INV-2026-000123' })
  @ApiBody({ schema: openApiSchema(CreateReleaseBodySchema) })
  @ApiResponse({ status: 201, description: 'Release applied' })
  @ApiResponse({
    status: 200,
    description: 'Identical release already applied (idempotent replay)',
  })
  @ApiResponse({ status: 404, description: 'PROGRAM_NOT_FOUND or RESERVATION_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'RELEASE_CONFLICT — releaseId already used differently',
  })
  @ApiResponse({
    status: 422,
    description: 'RELEASE_EXCEEDS_OUTSTANDING, RESERVATION_ALREADY_RELEASED, CURRENCY_MISMATCH',
  })
  async release(
    @Param(new ZodValidationPipe(ReservationParamsSchema))
    params: { programId: string; invoiceId: string },
    @Body(new ZodValidationPipe(CreateReleaseBodySchema)) body: CreateReleaseBody,
    @CurrentPrincipal() principal: Principal,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ release: ReleaseDto; reservation: ReservationDto }> {
    const result = await this.releaseCapacity.execute(
      { ...params, ...body },
      apiContext(principal, request),
    );
    response.status(result.created ? 201 : 200);
    return {
      release: toReleaseDto(result.release, result.reservation),
      reservation: toReservationDto(result.reservation),
    };
  }
}
