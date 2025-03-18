/**
 * Scheduler type definitions
 */

export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday' | 'everyday';

export interface TimeEntry {
  time: string; // Format: "HH:MM" (24-hour)
  temperature: number;
  power?: 'on' | 'off' | 'no_change';
}

export interface Schedule {
  id: string;
  days: DayOfWeek[];
  times: TimeEntry[];
  enabled: boolean;
  name?: string;
}

export interface WarmAwakeAlarm {
  id: string;
  days: DayOfWeek[];
  time: string; // Format: "HH:MM" (24-hour)
  targetTemperature: number;
  duration: number; // minutes
  enabled: boolean;
  name?: string;
}

export interface WarmAwakeSettings {
  enabled: boolean;
  alarms: WarmAwakeAlarm[];
}

export interface WarmAwakeSequence {
  id: string;
  startTime: Date;
  endTime: Date;
  currentStep: number;
  totalSteps: number;
  startTemp: number;
  endTemp: number;
  tempIncrement: number;
  intervalId: NodeJS.Timeout | null;
}

export interface DeviceScheduling {
  deviceId: string;
  deviceName: string;
  schedules: Schedule[];
  warmAwake: WarmAwakeSettings;
}

export interface SchedulerConfig {
  enableScheduling: boolean;
  schedules: any[]; // Raw config schedule objects
  warmAwake: any; // Raw config warm awake object
}

export interface JobRef {
  type: 'schedule' | 'warmAwake';
  id: string;
  timeoutId: NodeJS.Timeout;
}