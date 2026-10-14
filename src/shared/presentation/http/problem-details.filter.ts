import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError, type ErrorCode } from '@/shared/domain/domain-error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  INVALID_AMOUNT: HttpStatus.BAD_REQUEST,
  UNSUPPORTED_CURRENCY: HttpStatus.UNPROCESSABLE_ENTITY,
  CURRENCY_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  PROGRAM_NOT_FOUND: HttpStatus.NOT_FOUND,
  PROGRAM_SUSPENDED: HttpStatus.UNPROCESSABLE_ENTITY,
  PROGRAM_CURRENCY_IMMUTABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  INSUFFICIENT_CAPACITY: HttpStatus.UNPROCESSABLE_ENTITY,
  RESERVATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  RESERVATION_CONFLICT: HttpStatus.CONFLICT,
  RESERVATION_ALREADY_RELEASED: HttpStatus.UNPROCESSABLE_ENTITY,
  RELEASE_CONFLICT: HttpStatus.CONFLICT,
  RELEASE_EXCEEDS_OUTSTANDING: HttpStatus.UNPROCESSABLE_ENTITY,
  FX_RATE_NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  FX_RATE_STALE: HttpStatus.SERVICE_UNAVAILABLE,
  INVALID_TREASURY_MESSAGE: HttpStatus.UNPROCESSABLE_ENTITY,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  AUTH_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
};

const CODE_BY_HTTP_STATUS: Partial<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  503: 'SERVICE_UNAVAILABLE',
};

interface Problem {
  status: number;
  code: string;
  title: string;
  detail?: string;
  extensions?: Record<string, unknown>;
}

/** Renders every error as an RFC 9457 `application/problem+json` response. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();
    const problem = this.toProblem(exception);

    if (exception instanceof DomainError && problem.status >= 500) {
      // Expected dependency condition (stale FX feed, IdP down): no stack trace needed.
      this.logger.warn({ code: problem.code, details: exception.details }, exception.message);
    } else if (problem.status >= 500) {
      this.logger.error({ err: exception, code: problem.code }, 'Request failed');
    }
    if (response.headersSent) {
      // e.g. an SSE stream that already started; nothing sensible can be sent any more.
      response.end();
      return;
    }
    if (problem.status === HttpStatus.UNAUTHORIZED) {
      response.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
    }
    response
      .status(problem.status)
      .type('application/problem+json')
      .json({
        type: `urn:problem-type:${problem.code.toLowerCase().replaceAll('_', '-')}`,
        title: problem.title,
        status: problem.status,
        detail: problem.detail,
        code: problem.code,
        instance: request.originalUrl,
        requestId: request.id,
        ...problem.extensions,
      });
  }

  private toProblem(exception: unknown): Problem {
    if (exception instanceof DomainError) {
      return {
        status: STATUS_BY_CODE[exception.code],
        code: exception.code,
        title: humanize(exception.code),
        detail: exception.message,
        extensions: exception.details,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_BY_HTTP_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR');
      return {
        status,
        code,
        title: humanize(code),
        detail: status < 500 ? exception.message : undefined,
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      title: 'Internal error',
    };
  }
}

function humanize(code: string): string {
  const words = code.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
