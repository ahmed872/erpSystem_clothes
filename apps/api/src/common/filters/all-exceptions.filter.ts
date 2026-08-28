import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { DomainError } from '../errors/domain-error';

const DOMAIN_ERROR_HTTP_STATUS: Record<string, number> = {
  VALIDATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
};

/**
 * Translates every thrown error into the standard API error envelope
 * documented in docs/architecture/PHASE-0-ARCHITECTURE.md §13:
 * `{ error: { code, message, details, requestId } }`. Never leaks stack
 * traces or raw DB/Prisma errors to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = request.requestId ?? 'unknown';

    const { status, code, message, details } = this.resolve(exception);

    if (status >= 500) {
      this.logger.error(`[${requestId}] ${message}`, exception instanceof Error ? exception.stack : undefined);
    }

    response.status(status).json({
      error: { code, message, details, requestId },
    });
  }

  private resolve(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof DomainError) {
      return {
        status: DOMAIN_ERROR_HTTP_STATUS[exception.code] ?? HttpStatus.BAD_REQUEST,
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          status: HttpStatus.CONFLICT,
          code: 'CONFLICT',
          message: 'A record with the same unique value already exists',
          details: exception.meta,
        };
      }
      if (exception.code === 'P2025') {
        return { status: HttpStatus.NOT_FOUND, code: 'NOT_FOUND', message: 'Record not found' };
      }
      return { status: HttpStatus.BAD_REQUEST, code: 'DATABASE_ERROR', message: 'Database request failed' };
    }

    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      const message = typeof res === 'string' ? res : ((res as { message?: string }).message ?? exception.message);
      return {
        status: exception.getStatus(),
        code: HttpStatus[exception.getStatus()] ?? 'HTTP_ERROR',
        message: Array.isArray(message) ? message.join(', ') : message,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    };
  }
}
