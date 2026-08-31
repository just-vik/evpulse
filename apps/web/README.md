# Tesla Analytics Frontend

Modern Next.js 15 + React 19 dashboard for Tesla vehicle analytics, trip tracking, and fleet management.

## Stack

- **Next.js 15** - React framework with App Router
- **React 19** - UI library
- **TypeScript 5.3+** - Type safety
- **Tailwind CSS v4** - Styling
- **shadcn/ui** - Component library (built on Radix UI)
- **TanStack Query v5** - Server state management
- **Framer Motion** - Animations
- **Mapbox GL** - Map visualization
- **Socket.io** - Real-time WebSocket
- **NextAuth v5** - Authentication
- **Zustand** - Client state management
- **Zod** - Data validation
- **Recharts** - Charts and graphs

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Backend API running on `http://localhost:4000`

### Installation

1. **Install dependencies**:
```bash
npm install
```

2. **Configure environment**:
```bash
cp .env.example .env.local
# Edit .env.local with your values
```

3. **Start development server**:
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
src/
├── app/                    # Next.js App Router pages
│   ├── layout.tsx         # Root layout with providers
│   ├── page.tsx           # Dashboard home page
│   ├── auth/              # Authentication pages
│   ├── vehicles/          # Vehicle management pages
│   ├── trips/             # Trip history and visualization
│   ├── charging/          # Charging history and analytics
│   └── settings/          # User preferences
├── components/            # Reusable React components
│   ├── ui/               # shadcn/ui components
│   ├── dashboard/        # Dashboard-specific components
│   └── common/           # Shared components (header, sidebar, etc.)
├── hooks/                # Custom React hooks
│   ├── useVehicles.ts    # Vehicle data fetching
│   ├── useWebSocket.ts   # WebSocket connection
│   └── useAuth.ts        # Authentication
├── lib/                  # Utility functions
│   ├── api.ts            # API client (typed)
│   ├── utils.ts          # Helper utilities
│   └── constants.ts      # App constants
├── services/            # Business logic services
│   ├── telemetry.ts     # Telemetry data processing
│   └── cache.ts         # Local caching
├── stores/              # Zustand state stores
│   ├── authStore.ts     # Authentication state
│   ├── uiStore.ts       # UI state (theme, modals, etc.)
│   └── dataStore.ts     # Cached data state
└── types/               # TypeScript type definitions
    ├── api.ts           # API response types
    ├── vehicle.ts       # Vehicle data types
    └── telemetry.ts     # Telemetry types
```

## Development

### Available Scripts

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run TypeScript compiler
npm run type-check

# Run ESLint
npm run lint

# Format code with Prettier
npm run format

# Run all checks
npm run check
```

### Code Style

- **ESLint** - Code linting
- **Prettier** - Code formatting
- **TypeScript** - Type checking

All checks run on commit via Git hooks.

## Features

### Dashboard
- Real-time KPI cards (SOC, Range, Efficiency, Distance, Energy)
- Interactive charts (SOC vs time, Power vs time, Efficiency trends)
- Vehicle list with live status
- Quick actions (lock, charge, climate control)

### Vehicle Management
- Vehicle detail pages with comprehensive telemetry
- Live status display (charging, driving, idle, asleep)
- Vehicle commands (lock/unlock, charging, climate)
- Maintenance history

### Trip Analytics
- Trip history with distance, duration, efficiency
- Trip visualization on map (Mapbox)
- Energy consumption breakdown
- Route replay

### Charging History
- Charging sessions with power curves
- Cost analysis
- Charger type tracking
- Schedule charging

### Battery Analytics
- Battery health tracking
- Degradation trends
- Cycle count
- Predictions (ML model on backend)

### Automations
- Create IF-THEN automation rules
- Conditions: SOC %, time, location, driving status
- Actions: Charging, climate, notifications
- Schedule and triggers

### Notifications
- Email alerts
- Push notifications (Firebase)
- Telegram alerts
- In-app notification center
- Trigger types: Low SOC, charging complete, vehicle unlocked, location-based

### Multi-tenant
- Support for multiple users in a household
- Vehicle ownership verification
- Shared access to vehicles
- User roles (owner, viewer)

## API Integration

The frontend communicates with the NestJS backend via:

1. **REST API** - For CRUD operations
   - `/api/v1/vehicles` - Vehicle list and details
   - `/api/v1/telemetry` - Telemetry data
   - `/api/v1/trips` - Trip history
   - `/api/v1/charging` - Charging sessions
   - `/api/v1/automations` - Automation rules

2. **WebSocket** - For real-time updates
   - Vehicle status changes
   - Live telemetry streams
   - Charging progress updates
   - Notifications

## Real-time Updates

The frontend uses Socket.io to receive real-time updates from the backend:

```typescript
// Hook example
const { data: vehicles } = useVehicles(); // TanStack Query
useWebSocket('vehicle:update', (data) => {
  // Update local state when real-time data arrives
});
```

## Authentication

Authentication uses NextAuth v5 with OAuth integration:

1. User clicks "Sign in with Tesla"
2. OAuth flow redirects to Tesla / backend
3. Backend returns JWT tokens
4. NextAuth securely stores tokens
5. Frontend includes token in API requests

Protected routes automatically redirect to login if not authenticated.

## Deployment

### Vercel Deployment

1. **Push to GitHub**
2. **Connect to Vercel**
3. **Set environment variables** in Vercel dashboard
4. **Deploy** - Automatic on each push to main

### Self-hosted Deployment

```bash
# Build for production
npm run build

# Export as static site (if needed)
npm run export

# Start production server
npm start
```

## Performance

- **Server Components** - Pages render on server by default (faster)
- **Image Optimization** - Next.js auto-optimizes images
- **Code Splitting** - Automatic per-route splitting
- **Caching** - TanStack Query handles data caching
- **Lazy Loading** - Components loaded on-demand

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

## Contributing

1. Follow the code style (ESLint + Prettier)
2. Write TypeScript with strict types
3. Add tests for new features
4. Update types for API changes

## Roadmap

- [ ] Mobile app (React Native)
- [ ] Advanced analytics dashboard
- [ ] SaaS billing integration
- [ ] Admin panel
- [ ] Public API
- [ ] AI-powered insights
- [ ] Voice commands
- [ ] Integration with other services

## Support

For issues and questions:
- GitHub Issues
- Discord community
- Email: support@tesla-analytics.com

## License

MIT
