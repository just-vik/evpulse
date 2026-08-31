import axios, { isAxiosError, type InternalAxiosRequestConfig } from 'axios';
import * as SecureStore from 'expo-secure-store';

const rawBase = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';
export const API_ORIGIN = rawBase.replace(/\/$/, '');

export const api = axios.create({
  baseURL: `${API_ORIGIN}/api/v1`,
  timeout: 20000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Client': 'mobile',
  },
});

api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('access_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = await SecureStore.getItemAsync('refresh_token');
  const userId = await SecureStore.getItemAsync('user_id');
  if (!refreshToken || !userId) return null;
  const { data } = await axios.post<{ accessToken: string; refreshToken: string }>(
    `${API_ORIGIN}/api/v1/auth/refresh`,
    { userId, refreshToken },
    { headers: { 'Content-Type': 'application/json', 'X-Client': 'mobile' } },
  );
  await SecureStore.setItemAsync('access_token', data.accessToken);
  await SecureStore.setItemAsync('refresh_token', data.refreshToken);
  return data.accessToken;
}

api.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!isAxiosError(error)) return Promise.reject(error);
    const status = error.response?.status;
    const original = error.config as
      | (InternalAxiosRequestConfig & { __isRetry?: boolean })
      | undefined;
    if (status === 401 && original && !original.__isRetry) {
      original.__isRetry = true;
      try {
        refreshPromise ??= refreshAccessToken().finally(() => {
          refreshPromise = null;
        });
        const newToken = await refreshPromise;
        if (newToken) {
          if (original.headers?.set) {
            original.headers.set('Authorization', `Bearer ${newToken}`);
          } else if (original.headers) {
            (original.headers as Record<string, string>)['Authorization'] =
              `Bearer ${newToken}`;
          }
          return api(original);
        }
      } catch {
        /* fall through */
      }
      await SecureStore.deleteItemAsync('access_token');
      await SecureStore.deleteItemAsync('refresh_token');
      await SecureStore.deleteItemAsync('user_id');
    }
    return Promise.reject(error);
  },
);
