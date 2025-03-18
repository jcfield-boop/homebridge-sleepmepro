import { Logger, PlatformConfig } from 'homebridge';
import { v4 as uuidv4 } from 'uuid';
import { SleepMeApi } from '../sleepme-api.js';
import { Schedule, TimeEntry, DayOfWeek, JobRef } from './types.js';

export class ScheduleManager {
  private schedules: Map<string, Schedule[]> = new Map(); // deviceId -> schedules
  private jobs: Map<string, JobRef> = new Map(); // jobId -> timeout
  private deviceMap: Map<string, string> = new Map(); // deviceId -> deviceName

  constructor(
    private readonly config: PlatformConfig,
    private readonly apiService: SleepMeApi,
    private readonly log: Logger
  ) {
    this.log.info('Initializing Schedule Manager');
  }

  /**
   * Initialize the scheduler with devices
   */
  public initialize(deviceMap: Map<string, string>): void {
    this.deviceMap = deviceMap;
    this.parseConfig();
    this.setupScheduleJobs();
    this.log.info(`Schedule Manager initialized with ${this.countSchedules()} schedules`);
  }

  /**
   * Shutdown and clear all jobs
   */
  public shutdown(): void {
    this.clearAllJobs();
    this.log.info('Schedule Manager shutdown');
  }

  /**
   * Parse configuration into schedule objects
   */
  private parseConfig(): void {
    // Clear existing schedules
    this.schedules.clear();

    // Parse schedules from config
    const schedulesConfig = this.config.scheduler?.schedules || [];
    
    if (!Array.isArray(schedulesConfig) || schedulesConfig.length === 0) {
      this.log.debug('No schedules found in configuration');
      return;
    }

    // For each device
    this.deviceMap.forEach((deviceName, deviceId) => {
      const deviceSchedules: Schedule[] = [];

      // Parse each schedule in the config
      schedulesConfig.forEach((scheduleConfig: any, index: number) => {
        try {
          // Skip disabled schedules
          if (scheduleConfig.enabled === false) {
            return;
          }

          // Process days
          let days: DayOfWeek[] = scheduleConfig.days || [];
          
          // Handle 'everyday' special case
          if (days.includes('everyday')) {
            days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
          }

          // Skip if no days specified
          if (days.length === 0) {
            this.log.warn(`Schedule ${index + 1} has no days specified, skipping`);
            return;
          }

          // Process times
          const times: TimeEntry[] = [];
          if (Array.isArray(scheduleConfig.times)) {
            scheduleConfig.times.forEach((timeEntry: any) => {
              if (typeof timeEntry.time === 'string' && typeof timeEntry.temperature === 'number') {
                times.push({
                  time: timeEntry.time,
                  temperature: timeEntry.temperature,
                  power: timeEntry.power || 'no_change'
                });
              } else {
                this.log.warn(`Invalid time entry in schedule ${index + 1}, skipping`);
              }
            });
          }

          // Skip if no times specified
          if (times.length === 0) {
            this.log.warn(`Schedule ${index + 1} has no times specified, skipping`);
            return;
          }

          // Create schedule object
          const schedule: Schedule = {
            id: scheduleConfig.id || uuidv4(),
            days: days as DayOfWeek[],
            times,
            enabled: true,
            name: scheduleConfig.name || `Schedule ${index + 1}`
          };

          deviceSchedules.push(schedule);
        } catch (error) {
          this.log.error(`Error parsing schedule ${index + 1}: ${error}`);
        }
      });

      if (deviceSchedules.length > 0) {
        this.schedules.set(deviceId, deviceSchedules);
        this.log.info(`Loaded ${deviceSchedules.length} schedules for device ${deviceName} (${deviceId})`);
      }
    });
  }

  /**
   * Set up schedule jobs for all devices
   */
  private setupScheduleJobs(): void {
    // Clear existing jobs
    this.clearAllJobs();

    // For each device
    this.schedules.forEach((schedules, deviceId) => {
      const deviceName = this.deviceMap.get(deviceId) || deviceId;
      this.log.debug(`Setting up ${schedules.length} schedules for device ${deviceName}`);

      // For each schedule
      schedules.forEach(schedule => {
        // Skip disabled schedules
        if (!schedule.enabled) {
          return;
        }

        this.log.debug(`Setting up schedule "${schedule.name}" (${schedule.id})`);
        
        // For each day and time, calculate next occurrence and set timeout
        schedule.days.forEach(day => {
          schedule.times.forEach(timeEntry => {
            try {
              const nextOccurrence = this.getNextOccurrence(day, timeEntry.time);
              const delay = nextOccurrence.getTime() - Date.now();
              
              if (delay < 0) {
                this.log.warn(`Next occurrence for ${day} ${timeEntry.time} is in the past, skipping`);
                return;
              }

              const jobId = `${schedule.id}-${day}-${timeEntry.time.replace(':', '')}`;
              
              // Create timeout
              const timeoutId = setTimeout(() => {
                this.executeScheduledAction(deviceId, timeEntry);
                
                // Re-schedule for next week
                const nextWeekOccurrence = new Date(nextOccurrence);
                nextWeekOccurrence.setDate(nextWeekOccurrence.getDate() + 7);
                
                const nextWeekDelay = nextWeekOccurrence.getTime() - Date.now();
                const newTimeoutId = setTimeout(() => {
                  this.executeScheduledAction(deviceId, timeEntry);
                }, nextWeekDelay);
                
                // Update job reference
                this.jobs.set(jobId, {
                  type: 'schedule',
                  id: schedule.id,
                  timeoutId: newTimeoutId
                });
                
              }, delay);
              
              // Store job reference
              this.jobs.set(jobId, {
                type: 'schedule',
                id: schedule.id,
                timeoutId
              });
              
              // Log next occurrence for debugging
              const formattedDate = nextOccurrence.toLocaleString();
              this.log.debug(`Scheduled ${timeEntry.temperature}°C for ${deviceName} at ${formattedDate} (${delay}ms from now)`);
            } catch (error) {
              this.log.error(`Error setting up schedule for ${day} ${timeEntry.time}: ${error}`);
            }
          });
        });
      });
    });
    
    this.log.info(`Set up ${this.jobs.size} scheduled jobs`);
  }

  /**
   * Execute a scheduled temperature change
   */
  private async executeScheduledAction(deviceId: string, timeEntry: TimeEntry): Promise<void> {
    const deviceName = this.deviceMap.get(deviceId) || deviceId;
    this.log.info(`Executing scheduled temperature change for ${deviceName}: ${timeEntry.temperature}°C (power: ${timeEntry.power})`);
    
    try {
      // Handle power state if specified
      if (timeEntry.power === 'on') {
        await this.apiService.turnDeviceOn(deviceId, timeEntry.temperature);
      } else if (timeEntry.power === 'off') {
        await this.apiService.turnDeviceOff(deviceId);
      } else {
        // Just update temperature
        await this.apiService.setDeviceSettings(deviceId, {
          "control.set_temperature_c": timeEntry.temperature
        });
      }
      
      this.log.info(`Successfully applied scheduled change for ${deviceName}`);
    } catch (error) {
      this.log.error(`Error executing scheduled change for ${deviceName}: ${error}`);
    }
  }

  /**
   * Calculate the next occurrence of a day+time combination
   */
  private getNextOccurrence(day: DayOfWeek, time: string): Date {
    const dayMap: Record<DayOfWeek, number> = {
      'monday': 1,
      'tuesday': 2,
      'wednesday': 3,
      'thursday': 4,
      'friday': 5,
      'saturday': 6,
      'sunday': 0,
      'everyday': -1 // Special case, handled below
    };
    
    const dayNumber = dayMap[day];
    const [hourStr, minuteStr] = time.split(':');
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);
    
    const now = new Date();
    const result = new Date();
    
    // Set time
    result.setHours(hour, minute, 0, 0);
    
    // If day is 'everyday', use today or tomorrow
    if (day === 'everyday') {
      if (result < now) {
        // If the time has already passed today, schedule for tomorrow
        result.setDate(result.getDate() + 1);
      }
      return result;
    }
    
    // Set to next occurrence of the day
    const currentDay = now.getDay();
    let daysToAdd = 0;
    
    if (dayNumber === currentDay) {
      // If it's the same day, but the time has passed, schedule for next week
      if (result < now) {
        daysToAdd = 7;
      }
    } else if (dayNumber > currentDay) {
      // If the day is later this week
      daysToAdd = dayNumber - currentDay;
    } else {
      // If the day is earlier in the week, schedule for next week
      daysToAdd = 7 - (currentDay - dayNumber);
    }
    
    result.setDate(result.getDate() + daysToAdd);
    return result;
  }

  /**
   * Clear all scheduled jobs
   */
  private clearAllJobs(): void {
    this.jobs.forEach(job => {
      clearTimeout(job.timeoutId);
    });
    this.jobs.clear();
    this.log.debug('Cleared all scheduled jobs');
  }

  /**
   * Count total number of schedules across all devices
   */
  private countSchedules(): number {
    let count = 0;
    this.schedules.forEach(deviceSchedules => {
      count += deviceSchedules.length;
    });
    return count;
  }
}