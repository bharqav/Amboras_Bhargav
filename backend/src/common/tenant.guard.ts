import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';

type TenantRequest = Request & { storeId?: string };
type TenantTokenPayload = { store_id?: string; storeId?: string };

const ACCESS_TOKEN_COOKIE = 'amboras_access_token';

function readAccessTokenFromCookie(request: Request): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) {
    return undefined;
  }

  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${ACCESS_TOKEN_COOKIE}=`)) {
      continue;
    }

    const value = trimmed.slice(ACCESS_TOKEN_COOKIE.length + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return undefined;
}

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    // `EventSource` cannot set `Authorization` headers in browsers, so for SSE we also
    // accept a JWT via `?accessToken=...` (trade-off: token can appear in URLs/logs).
    let authHeader = request.header('authorization');
    const accessToken =
      typeof request.query?.accessToken === 'string'
        ? request.query.accessToken
        : typeof (request.query as Record<string, unknown>)?.access_token === 'string'
          ? (request.query as Record<string, unknown>).access_token
          : undefined;
    if ((!authHeader || authHeader.length === 0) && accessToken) {
      authHeader = `Bearer ${accessToken}`;
    }
    if ((!authHeader || authHeader.length === 0) && !accessToken) {
      const cookieToken = readAccessTokenFromCookie(request);
      if (cookieToken) {
        authHeader = `Bearer ${cookieToken}`;
      }
    }
    const secret = this.configService.get<string>('JWT_SECRET');
    const allowInsecureDevToken = this.configService.get<string>('ALLOW_INSECURE_DEV_TOKEN', 'false') === 'true';

    if (!secret) {
      throw new UnauthorizedException('Server is missing JWT_SECRET');
    }

    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = authHeader.slice(7).trim();

    try {
      const payload = jwt.verify(token, secret) as TenantTokenPayload;
      const storeId = payload.store_id ?? payload.storeId;

      if (!storeId) {
        throw new UnauthorizedException('Token does not include store_id');
      }

      request.storeId = storeId;
      return true;
    } catch {
      if (allowInsecureDevToken) {
        const payload = jwt.decode(token) as TenantTokenPayload | null;
        const storeId = payload?.store_id ?? payload?.storeId;

        if (storeId) {
          request.storeId = storeId;
          return true;
        }
      }

      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
