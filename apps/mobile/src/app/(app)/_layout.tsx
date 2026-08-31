import { Slot } from 'expo-router';
import { BiometricGate } from '@/hooks/useBiometricGate';

export default function AppGroupLayout() {
  return (
    <BiometricGate>
      <Slot />
    </BiometricGate>
  );
}
