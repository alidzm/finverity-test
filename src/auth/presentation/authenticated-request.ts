import type { Request } from 'express';
import type { Principal } from '@/auth/domain/principal';

/** Express request after the guard ran (`id` is assigned by the request logger). */
export type AuthenticatedRequest = Request & { principal?: Principal; id?: string };
