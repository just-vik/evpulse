import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface LayoutState {
  // Vehicle
  selectedVehicleId: string | null
  setSelectedVehicleId: (id: string) => void

  // Desktop sidebar (collapsed/expanded)
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void

  // Mobile sidebar drawer
  mobileSidebarOpen: boolean
  setMobileSidebarOpen: (open: boolean) => void

  // Unread notifications badge
  unreadCount: number
  setUnreadCount: (n: number) => void
  incrementUnread: () => void
  clearUnread: () => void
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      // ── Vehicle ──
      selectedVehicleId: null,
      setSelectedVehicleId: (id: string) => set({ selectedVehicleId: id }),

      // ── Desktop sidebar ──
      sidebarOpen: true,
      setSidebarOpen: (open: boolean) => set({ sidebarOpen: open }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

      // ── Mobile sidebar drawer ──
      mobileSidebarOpen: false,
      setMobileSidebarOpen: (open: boolean) => set({ mobileSidebarOpen: open }),

      // ── Unread badge ──
      unreadCount: 0,
      setUnreadCount: (n: number) => set({ unreadCount: n }),
      incrementUnread: () => set((s) => ({ unreadCount: s.unreadCount + 1 })),
      clearUnread: () => set({ unreadCount: 0 }),
    }),
    {
      name: 'layout-store',
      // Не персистим мобильный drawer и панель уведомлений — открываем всегда закрытыми
      partialize: (s) => ({
        selectedVehicleId: s.selectedVehicleId,
        sidebarOpen:       s.sidebarOpen,
        unreadCount:       s.unreadCount,
      }),
    }
  )
)
