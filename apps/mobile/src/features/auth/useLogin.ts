import { useMutation } from '@tanstack/react-query';
import { api } from '@/services/api';
import { useAuthStore } from '@/store/authStore';
import type { UserProfile } from '@/store/authStore';

interface LoginBody {
  email: string;
  password: string;
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: UserProfile;
}

export function useLogin() {
  const setSession = useAuthStore((s) => s.setSession);

  return useMutation({
    mutationFn: async (body: LoginBody) => {
      const { data } = await api.post<LoginResponse>('/auth/login', body);
      return data;
    },
    onSuccess: async (data) => {
      await setSession(data);
    },
  });
}
