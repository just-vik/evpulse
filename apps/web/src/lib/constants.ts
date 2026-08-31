/**
 * Application constants
 */

// Vehicle states
export const VEHICLE_STATES = {
  ONLINE: 'Online',
  ASLEEP: 'Asleep',
  OFFLINE: 'Offline',
} as const;

export const CHARGE_STATES = {
  CHARGING: 'Charging',
  DISCHARGING: 'Discharging',
  IDLE: 'Idle',
} as const;

export const DRIVING_STATES = {
  DRIVING: 'Driving',
  IDLE: 'Idle',
  CHARGING: 'Charging',
} as const;

// Vehicle models
export const TESLA_MODELS = {
  S: 'S',
  '3': '3',
  X: 'X',
  Y: 'Y',
  ROADSTER: 'Roadster',
  CYBERTRUCK: 'Cybertruck',
} as const;

// Vehicle commands
export const VEHICLE_COMMANDS = {
  LOCK: 'lock',
  UNLOCK: 'unlock',
  START_CHARGE: 'start_charge',
  STOP_CHARGE: 'stop_charge',
  CLIMATE_ON: 'climate_on',
  CLIMATE_OFF: 'climate_off',
  SET_TEMP: 'set_temp',
  OPEN_TRUNK: 'open_trunk',
  OPEN_FRUNK: 'open_frunk',
  HONK: 'honk',
  FLASH_LIGHTS: 'flash_lights',
  WAKE_UP: 'wake_up',
  SET_CHARGE_LIMIT: 'set_charge_limit',
  SET_CHARGING_AMPS: 'set_charging_amps',
} as const;

// Subscription plans
export const SUBSCRIPTION_PLANS = {
  FREE: 'free',
  PRO: 'pro',
  FLEET: 'fleet',
} as const;

export const PLAN_FEATURES = {
  free: {
    maxVehicles: 1,
    historicalDataDays: 7,
    pricePerMonth: 0,
    features: ['Real-time tracking', 'Trip history', 'Basic analytics'],
  },
  pro: {
    maxVehicles: 2,
    historicalDataDays: 90,
    pricePerMonth: 9.99,
    features: [
      'Real-time tracking',
      'Advanced analytics',
      'Trip sharing',
      'Charging optimization',
      'Automations',
    ],
  },
  fleet: {
    maxVehicles: 999,
    historicalDataDays: 365,
    pricePerMonth: 49.99,
    features: [
      'Unlimited vehicles',
      'Advanced analytics',
      'Team management',
      'Fleet dashboards',
      'API access',
      'Priority support',
    ],
  },
} as const;

// Notification types
export const NOTIFICATION_TYPES = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
} as const;

export const NOTIFICATION_TRIGGERS = {
  LOW_BATTERY: 'low-battery',
  CHARGING_COMPLETE: 'charging-complete',
  VEHICLE_UNLOCKED: 'vehicle-unlocked',
  LOCATION_ALERT: 'location-alert',
  AUTOMATION: 'automation',
  SYSTEM: 'system',
} as const;

// Charger types
export const CHARGER_TYPES = {
  WALL_CONNECTOR: 'Wall Connector',
  SUPERCHARGER: 'Supercharger',
  MOBILE_CONNECTOR: 'Mobile Connector',
  THIRD_PARTY: 'Third-Party',
} as const;

// Automation operators
export const AUTOMATION_OPERATORS = {
  EQUALS: '=',
  NOT_EQUALS: '!=',
  GREATER_THAN: '>',
  LESS_THAN: '<',
  GREATER_EQUAL: '>=',
  LESS_EQUAL: '<=',
  IN: 'in',
  NOT_IN: 'not-in',
} as const;

// Automation conditions
export const AUTOMATION_CONDITION_FIELDS = {
  BATTERY_LEVEL: 'batteryLevel',
  SPEED: 'speed',
  TEMPERATURE: 'temperature',
  CHARGING_STATE: 'chargingState',
  TIME_OF_DAY: 'timeOfDay',
  LOCATION: 'location',
} as const;

// Automation actions
export const AUTOMATION_ACTIONS = {
  START_CHARGE: 'start-charge',
  STOP_CHARGE: 'stop-charge',
  CLIMATE_ON: 'climate-on',
  CLIMATE_OFF: 'climate-off',
  LOCK: 'lock',
  UNLOCK: 'unlock',
  EMAIL: 'email',
  PUSH: 'push',
  TELEGRAM: 'telegram',
} as const;

// UI Settings
export const UI_DEFAULTS = {
  pageSize: 20,
  chartRefreshInterval: 5000, // 5 seconds
  websocketReconnectInterval: 3000,
  telemetryUpdateInterval: 10000, // 10 seconds
  animationDuration: 300, // milliseconds
} as const;

// Chart colors
export const CHART_COLORS = {
  primary: '#3b82f6', // blue
  secondary: '#8b5cf6', // purple
  success: '#10b981', // green
  warning: '#f59e0b', // amber
  danger: '#ef4444', // red
  info: '#06b6d4', // cyan
  neutral: '#6b7280', // gray
} as const;

// Map settings
export const MAP_DEFAULTS = {
  zoomLevel: 12,
  center: { lat: 37.7749, lng: -122.4194 }, // San Francisco
  style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  minZoom: 2,
  maxZoom: 20,
} as const;

// Time-based constants
export const TIME_CONSTANTS = {
  ONE_SECOND: 1000,
  ONE_MINUTE: 60 * 1000,
  FIVE_MINUTES: 5 * 60 * 1000,
  FIFTEEN_MINUTES: 15 * 60 * 1000,
  ONE_HOUR: 60 * 60 * 1000,
  ONE_DAY: 24 * 60 * 60 * 1000,
  ONE_WEEK: 7 * 24 * 60 * 60 * 1000,
  ONE_MONTH: 30 * 24 * 60 * 60 * 1000,
  ONE_YEAR: 365 * 24 * 60 * 60 * 1000,
} as const;

// Default thresholds
export const THRESHOLDS = {
  lowBatteryDefault: 20, // %
  lowBatteryWarning: 30, // %
  efficientDriving: 250, // Wh/mile
  highConsumption: 300, // Wh/mile
  tempComfort: 72, // Fahrenheit
} as const;

// Tesla API endpoints
export const TESLA_API_ENDPOINTS = {
  vehicleList: '/api/v1/vehicles',
  vehicleData: '/api/v1/vehicles/:id/data',
  vehicleCharge: '/api/v1/vehicles/:id/command/charge',
  vehicleClimate: '/api/v1/vehicles/:id/command/climate',
  vehicleLocation: '/api/v1/vehicles/:id/data/location',
} as const;

// Error messages
export const ERROR_MESSAGES = {
  NETWORK_ERROR: 'Network error. Please check your connection.',
  API_ERROR: 'API error. Please try again later.',
  AUTH_ERROR: 'Authentication failed. Please log in again.',
  VEHICLE_OFFLINE: 'Vehicle is offline or asleep.',
  INVALID_TOKEN: 'Your session has expired. Please log in again.',
  INSUFFICIENT_PERMISSIONS: 'You do not have permission to perform this action.',
  QUOTA_EXCEEDED: 'You have exceeded your usage quota for this month.',
} as const;

// Success messages
export const SUCCESS_MESSAGES = {
  COMMAND_SENT: 'Command sent successfully.',
  SETTINGS_UPDATED: 'Settings updated successfully.',
  AUTOMATION_CREATED: 'Automation created successfully.',
  AUTOMATION_DELETED: 'Automation deleted successfully.',
  NOTIFICATION_PREFERENCES_UPDATED: 'Notification preferences updated.',
} as const;

// Local storage keys
export const STORAGE_KEYS = {
  AUTH_TOKEN: 'auth_token',
  REFRESH_TOKEN: 'refresh_token',
  USER_PREFERENCES: 'user_preferences',
  THEME: 'theme',
  LANGUAGE: 'language',
  RECENT_VEHICLES: 'recent_vehicles',
  SAVED_LOCATIONS: 'saved_locations',
  AUTOMATIONS_CACHE: 'automations_cache',
} as const;

// API endpoints
export const API_ENDPOINTS = {
  // Auth
  LOGIN: '/auth/login',
  LOGOUT: '/auth/logout',
  REFRESH: '/auth/refresh',
  
  // Vehicles
  VEHICLES: '/vehicles',
  VEHICLE: '/vehicles/:id',
  VEHICLE_COMMAND: '/vehicles/:id/command',
  VEHICLE_STATUS: '/vehicles/:id/status',
  
  // Telemetry
  TELEMETRY_LATEST: '/telemetry/:id/latest',
  TELEMETRY_RANGE: '/telemetry/:id/range',
  TELEMETRY_STATS: '/telemetry/:id/stats',
  
  // Trips
  TRIPS: '/trips',
  TRIP: '/trips/:id',
  TRIP_POINTS: '/trips/:id/points',
  
  // Charging
  CHARGING: '/charging',
  CHARGING_SESSION: '/charging/:id',
  CHARGING_ACTIVE: '/charging/:id/active',
  
  // Battery
  BATTERY_HEALTH: '/battery/:id/health',
  BATTERY_HISTORY: '/battery/:id/history',
  
  // Automations
  AUTOMATIONS: '/automations',
  AUTOMATION: '/automations/:id',
  AUTOMATION_EXECUTIONS: '/automations/:id/executions',
  
  // Notifications
  NOTIFICATIONS: '/notifications',
  NOTIFICATION: '/notifications/:id',
  NOTIFICATION_PREFERENCES: '/notifications/preferences',
  
  // User
  USER_PROFILE: '/users/me',
  USER_PREFERENCES: '/users/me/preferences',
} as const;

// Regex patterns
export const REGEX_PATTERNS = {
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  URL: /^https?:\/\/.+/,
  PHONE: /^[\d\s\-\+\(\)]+$/,
  HEX_COLOR: /^#[0-9a-f]{6}$/i,
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
} as const;
