import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';

describe('AuthService refresh security', () => {
  it('отклоняет refresh при несовпадении payload.sub и userId', async () => {
    const service = new AuthService(
      {
        findByEmail: jest.fn(),
        findById: jest.fn().mockResolvedValue({ id: 'user-2', email: 'x@test.dev', refreshToken: 'hash' }),
        setRefreshToken: jest.fn(),
      } as any,
      {
        verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-1' }),
        signAsync: jest.fn(),
      } as any,
      { get: jest.fn().mockReturnValue('secret') } as any,
      {} as any,
    );

    await expect(service.refreshTokens('user-2', 'rt')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('отклоняет refresh при отсутствии хэша refreshToken в БД', async () => {
    const service = new AuthService(
      {
        findByEmail: jest.fn(),
        findById: jest.fn().mockResolvedValue({ id: 'user-1', email: 'x@test.dev', refreshToken: null }),
        setRefreshToken: jest.fn(),
      } as any,
      {
        verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-1' }),
        signAsync: jest.fn(),
      } as any,
      { get: jest.fn().mockReturnValue('secret') } as any,
      {} as any,
    );

    await expect(service.refreshTokens('user-1', 'rt')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
