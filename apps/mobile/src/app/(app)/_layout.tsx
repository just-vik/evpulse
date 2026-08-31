import { Stack } from 'expo-router';
import { BiometricGate } from '@/hooks/useBiometricGate';

// Stack (not Slot) so the new trip-detail screen gets a real native
// push/pop transition + swipe-back gesture. Behaves identically to the
// previous Slot for the default (tabs) route since headerShown is off.
export default function AppGroupLayout() {
  return (
    <BiometricGate>
      <Stack screenOptions={{ headerShown: false }} />
    </BiometricGate>
  );
}
