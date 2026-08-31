import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Query,
  Request,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Set access token cookie (shared across subdomains).
   */
  private setCookie(res: Response, token: string): void {
    res.cookie('access_token', token, {
      httpOnly: true,
      secure: this.configService.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      domain: this.configService.get<string>('COOKIE_DOMAIN', '.evpulse.app'),
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
  }

  @Post('register')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: 201, description: 'User registered successfully' })
  @ApiResponse({ status: 409, description: 'User already exists' })
  async register(@Body() registerDto: RegisterDto, @Res() res: Response) {
    const result = await this.authService.register(registerDto);
    this.setCookie(res, result.accessToken);
    return res.json({
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard, LocalAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 300000 } })
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() loginDto: LoginDto, @Request() req, @Res() res: Response) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip;
    const userAgent = req.headers['user-agent'] as string | undefined;
    const result = await this.authService.login(loginDto, { ip, userAgent });
    this.setCookie(res, result.accessToken);
    return res.json({
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current authenticated user' })
  @ApiResponse({ status: 200, description: 'Returns current user' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async me(@Request() req) {
    return req.user;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Tokens refreshed successfully' })
  async refresh(
    @Body() body: { userId: string; refreshToken: string },
    @Res() res: Response,
  ) {
    const tokens = await this.authService.refreshTokens(body.userId, body.refreshToken);
    this.setCookie(res, tokens.accessToken);
    return res.json(tokens);
  }

  @Get('login-history')
  @UseGuards(JwtAuthGuard)
  async loginHistory(
    @Request() req,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.authService.getLoginHistory(req.user.id, limit);
  }

  @Post('logout')
  // No JwtAuthGuard — logout must work even with expired/invalid tokens so the
  // browser always receives the Set-Cookie header that clears the httpOnly cookie.
  async logout(@Req() req: any, @Res({ passthrough: true }) res: Response) {
    // Best-effort: invalidate the refresh token without requiring a valid JWT.
    try {
      const bearer = (req.headers.authorization as string | undefined)
        ?.replace(/^Bearer\s+/i, '');
      if (bearer) {
        const payload = this.jwtService.decode(bearer) as any;
        if (payload?.sub) await this.authService.logout(payload.sub);
      }
    } catch {
      // ignore — we clear the cookie regardless
    }

    // Always clear the httpOnly cookie.
    res.clearCookie('access_token', {
      httpOnly: true,
      secure: this.configService.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      domain: this.configService.get<string>('COOKIE_DOMAIN', 'evpulse.app'),
      path: '/',
    });
    return { success: true };
  }
}
