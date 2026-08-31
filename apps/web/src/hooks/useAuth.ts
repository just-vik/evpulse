'use client';

import { useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/authStore';
import { apiClient } from '@/lib/api';

export function useAuth() {
  const { accessToken, refreshToken, user, isAuthenticated, setTokens, setUser, login, logout } =
    useAuthStore();

  const refreshAccessToken = useCallback(async () => {
    if (!refreshToken || !user?.id) {
      logout();
      return false;
    }
    try {
      const response = await apiClient.refreshToken(user.id, refreshToken);
      setTokens(response.accessToken, response.refreshToken);
      if (response.user) setUser(response.user);
      return true;
    } catch {
      logout();
      return false;
    }
  }, [refreshToken, user, setTokens, setUser, logout]);

  const loginWithCredentials = useCallback(
    async (email: string, password: string) => {
      const response = await apiClient.login(email, password);
      login(response.accessToken, response.refreshToken, response.user);
      return response;
    },
    [login]
  );

  const registerUser = useCallback(
    async (firstName: string, lastName: string, email: string, password: string) => {
      const response = await apiClient.register(firstName, lastName, email, password);
      login(response.accessToken, response.refreshToken, response.user);
      return response;
    },
    [login]
  );

  const handleLogout = useCallback(async () => {
    if (accessToken) {
      await apiClient.logout(accessToken);
    }
    logout();
  }, [accessToken, logout]);

  const getCurrentUser = useCallback(async () => {
    if (!accessToken) return null;
    try {
      const userProfile = await apiClient.getMe(accessToken);
      setUser(userProfile);
      return userProfile;
    } catch {
      return null;
    }
  }, [accessToken, setUser]);

  return {
    accessToken,
    refreshToken,
    user,
    isAuthenticated,
    login: loginWithCredentials,
    register: registerUser,
    logout: handleLogout,
    refreshAccessToken,
    getCurrentUser,
  };
}

export function useRequireAuth() {
  const { isAuthenticated } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/login');
    }
  }, [isAuthenticated, router]);

  return isAuthenticated;
}

export function useCurrentUser() {
  const user = useAuthStore((state) => state.user);
  const { getCurrentUser } = useAuth();

  useEffect(() => {
    if (!user) {
      getCurrentUser();
    }
  }, [user, getCurrentUser]);

  return user;
}
