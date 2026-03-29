import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

const ACCESS_TOKEN_COOKIE = 'amboras_access_token';

function cookieSecureFlag(req: Request, configService: ConfigService): boolean {
  const wantSecure = configService.get<string>('COOKIE_SECURE', 'false') === 'true';
  const forwarded = req.headers['x-forwarded-proto'];
  const isTls = req.secure === true || forwarded === 'https';
  // Never emit Secure cookies over plain HTTP (browser would drop them → 401 on dashboard).
  return wantSecure && isTls;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post('login')
  login(@Body() input: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { accessToken, owner } = this.authService.login(input);
    const maxAgeMs = 12 * 60 * 60 * 1000;
    const secure = cookieSecureFlag(req, this.configService);

    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: maxAgeMs,
    });

    // Duplicate for the browser: EventSource cannot set headers and cross-origin cookies are
    // often not sent on SSE (SameSite / port). TenantGuard accepts ?accessToken= for streams.
    return { owner, accessToken };
  }

  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const secure = cookieSecureFlag(req, this.configService);
    res.clearCookie(ACCESS_TOKEN_COOKIE, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
    });
    return { ok: true as const };
  }

  @Get('demo-owners')
  demoOwners() {
    return this.authService.listDemoOwners();
  }
}
