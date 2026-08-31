import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  UseGuards, Request, HttpCode, HttpStatus, ForbiddenException, Ip, Headers,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('users')
@Controller('users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@Request() req) {
    const user = await this.usersService.findById(req.user.id);
    const { password, refreshToken, ...result } = user as any;
    return result;
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update current user profile' })
  async updateProfile(
    @Request() req,
    @Body() updateData: { firstName?: string; lastName?: string; email?: string },
  ) {
    return this.usersService.update(req.user.id, updateData);
  }

  @Patch('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change current user password' })
  async changePassword(
    @Request() req,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    await this.usersService.changePassword(req.user.id, body.currentPassword, body.newPassword);
  }

  /**
   * GDPR + Apple App Store requirement (mandatory since Nov 2025 with AI features):
   * Records explicit user consent with policy version and audit metadata.
   * POST /api/v1/users/me/consent
   */
  @Post('me/consent')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Record explicit GDPR consent for current user' })
  @ApiBody({ schema: { properties: { policyVersion: { type: 'string', example: '1.0' } }, required: ['policyVersion'] } })
  async recordConsent(
    @Request() req,
    @Body() body: { policyVersion: string },
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Headers('x-channel') channel: string,
  ) {
    if (!body.policyVersion) {
      return { error: 'policyVersion is required' };
    }
    return this.usersService.recordConsent(req.user.id, {
      policyVersion: body.policyVersion,
      ipAddress: ip,
      userAgent,
      channel: channel || 'web',
    });
  }

  /**
   * Returns the latest consent record for the authenticated user.
   * Frontend checks this to decide if consent screen is needed.
   * GET /api/v1/users/me/consent
   */
  @Get('me/consent')
  @ApiOperation({ summary: 'Get latest consent record for current user' })
  async getConsent(@Request() req) {
    return this.usersService.getLatestConsent(req.user.id);
  }

  /**
   * GDPR right to erasure (Art.17) + Apple App Store requirement (2023+):
   * Full account deletion is at DELETE /api/v1/auth/account (AuthController)
   * where TeslaOAuthService is already available without circular deps.
   * This endpoint kept for REST completeness but delegates to the same logic
   * without Tesla revoke (Tesla revoke requires TeslaOAuthService from AuthModule).
   */
  @Delete('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete own account — use DELETE /auth/account for full deletion with Tesla revoke' })
  async deleteMe(@Request() req) {
    return this.usersService.deleteAccount(req.user.id, async () => {});
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID (own account only)' })
  async findOne(@Param('id') id: string, @Request() req: any) {
    if (req.user.id !== id) throw new ForbiddenException('Access denied');
    const user = await this.usersService.findById(id);
    const { password, refreshToken, ...result } = user as any;
    return result;
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete user account by ID — use DELETE /auth/account for full deletion with Tesla revoke' })
  async remove(@Param('id') id: string, @Request() req: any) {
    if (req.user.id !== id) throw new ForbiddenException('Access denied');
    return this.usersService.deleteAccount(id, async () => {});
  }
}
