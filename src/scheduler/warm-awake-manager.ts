import { Logger, PlatformConfig } from 'homebridge';
import { v4 as uuidv4 } from 'uuid';
import { SleepMeApi } from '../sleepme-api.js';
import { WarmAwakeAlarm, WarmAwakeSettings, WarmAwakeSequence, DayOfWeek, JobRef } from './types.js';

export class WarmAwakeManager {
  private warmAwakeSettings: Map<string, WarmAwakeSettings> = new Map(); // deviceId -> settings
  private activeSequences: Map<string, WarmAwakeSequence> = new Map(); // sequenceId -> sequence
  private jobs: Map<string, JobRef> = new Map(); // jobId -> timeout
  private deviceMap: Map<string, string> = new Map(); // deviceId -> deviceName

  constructor(
    private readonly config: PlatformConfig,
    private readonly apiService: SleepMeApi,
    private readonly log: Logger
  ) {
    this.log.info('Initializing Warm Awake Manager');
  }

  /**
   * Initialize the warm awake manager with devices
   */
  public initialize(deviceMap: Map<string, string>): void {
    this.deviceMap = deviceMap;
    this.parseConfig();
    this.setupWarmAwakeJobs();
    this.log.info(`Warm Awake Manager initialized with settings for ${this.warmAwakeSettings.size} devices`);
  }

  /**
   * Shutdown and clear all jobs
   */
  public shutdown(): void {
    this.clearAllJobs();
    this.stopAllSequences();
    this.log.info('Warm Awake Manager shutdown');
  }

  /**
   * Parse configuration into warm awake settings
   */
  private parseConfig(): void {
    // Clear existing settings
    this.warmAwakeSettings.clear();

    // Get warm awake configuration
    const warmAwakeConfig = this.config.scheduler?.warmAwake;
    
    if (!warmAwakeConfig || warmAwakeConfig.enabled !== true) {
      this.log.debug('Warm Awake feature is disabled or not configured');
      return;
    }

    // For each device
    this.deviceMap.forEach((deviceName, deviceId) => {
      try {
        // Parse alarms
        const alarms: WarmAwakeAlarm[] = [];
        
        if (Array.isArray(warmAwakeConfig.alarms)) {
          warmAwakeConfig.alarms.forEach((alarmConfig: any, index: number) => {
            try {
              // Skip disabled alarms
              if (alarmConfig.enabled === false) {
                return;
              }

              // Process days
              let days: DayOfWeek[] = alarmConfig.days || [];
              
              // Handle 'everyday' special case
              if (days.includes('everyday')) {
                days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
              }

              // Skip if no days specified
              if (days.length === 0) {
                this.log.warn(`Warm Awake alarm ${index + 1} has no days specified, skipping`);
                return;
              }

              // Validate time
              if (!alarmConfig.time || typeof alarmConfig.time !== 'string') {
                this.log.warn(`Warm Awake alarm ${index + 1} has invalid time, skipping`);
                return;
              }

              // Validate temperature
              if (typeof alarmConfig.targetTemperature !== 'number') {
                this.log.warn(`Warm Awake alarm ${index + 1} has invalid target temperature, skipping`);
                return;
              }

              // Create alarm object
              const alarm: WarmAwakeAlarm = {
                id: alarmConfig.id || uuidv4(),
                days: days as DayOfWeek[],
                time: alarmConfig.time,
                targetTemperature: alarmConfig.targetTemperature,
                duration: typeof alarmConfig.duration === 'number' ? alarmConfig.duration : 15,
                enabled: true,
                name: alarmConfig.name || `Warm Awake ${index + 1}`
              };

              // Validate duration (5-60 minutes)
              alarm.duration = Math.max(5, Math.min(60, alarm.duration));

              alarms.push(alarm);
            } catch (error) {
              this.log.error(`Error parsing Warm Awake alarm ${index + 1}: ${error}`);
            }
          });
        }

        if (alarms.length > 0) {
          this.warmAwakeSettings.set(deviceId, {
            enabled: true,
            alarms
          });
          
          this.log.info(`Loaded ${alarms.length} Warm Awake alarms for device ${deviceName} (${deviceId})`);
        }
      } catch (error) {
        this.log.error(`Error parsing Warm Awake settings for device ${deviceName}: ${error}`);
      }
    });
  }

  /**
   * Set up Warm Awake jobs for all devices
   */
  private setupWarmAwakeJobs(): void {
    // Clear existing jobs
    this.clearAllJobs();

    // For each device
    this.warmAwakeSettings.forEach((settings, deviceId) => {
      if (!settings.enabled || settings.alarms.length === 0) {
        return;
      }

      const deviceName = this.deviceMap.get(deviceId) || deviceId;
      this.log.debug(`Setting up ${settings.alarms.length} Warm Awake alarms for device ${deviceName}`);

      // For each alarm
      settings.alarms.forEach(alarm => {
        // Skip disabled alarms
        if (!alarm.enabled) {
          return;
        }

        this.log.debug(`Setting up Warm Awake alarm "${alarm.name}" (${alarm.id})`);
        
        // For each day, calculate next occurrence and set timeout
        alarm.days.forEach(day => {
          try {
            // Calculate when to start the warm-up sequence
            // We need to start it "duration" minutes before the target time
            const targetTime = alarm.time;
            const startTime = this.subtractMinutes(targetTime, alarm.duration);
            
            // Get next occurrence of the start time
            const nextOccurrence = this.getNextOccurrence(day, startTime);
            const delay = nextOccurrence.getTime() - Date.now();
            
            if (delay < 0) {
              this.log.warn(`Next occurrence for ${day} ${startTime} is in the past, skipping`);
              return;
            }

            const jobId = `warmAwake-${alarm.id}-${day}-${targetTime.replace(':', '')}`;
            
            // Create timeout
            const timeoutId = setTimeout(() => {
              this.startWarmAwakeSequence(deviceId, alarm);
              
              // Re-schedule for next week
              const nextWeekOccurrence = new Date(nextOccurrence);
              nextWeekOccurrence.setDate(nextWeekOccurrence.getDate() + 7);
              
              const nextWeekDelay = nextWeekOccurrence.getTime() - Date.now();
              const newTimeoutId = setTimeout(() => {
                this.startWarmAwakeSequence(deviceId, alarm);
              }, nextWeekDelay);
              
              // Update job reference
              this.jobs.set(jobId, {
                type: 'warmAwake',
                id: alarm.id,
                timeoutId: newTimeoutId
              });
              
            }, delay);
            
            // Store job reference
            this.jobs.set(jobId, {
              type: 'warmAwake',
              id: alarm.id,
              timeoutId
            });
            
            // Log next occurrence for debugging
            const formattedDate = nextOccurrence.toLocaleString();
            this.log.debug(`Scheduled Warm Awake for ${deviceName} at ${formattedDate} (${delay}ms from now)`);
          } catch (error) {
            this.log.error(`Error setting up Warm Awake for ${day} ${alarm.time}: ${error}`);
          }
        });
      });
    });
    
    this.log.info(`Set up ${this.jobs.size} Warm Awake jobs`);
  }

  /**
   * Start a Warm Awake sequence
   */
  private async startWarmAwakeSequence(deviceId: string, alarm: WarmAwakeAlarm): Promise<void> {
    const deviceName = this.deviceMap.get(deviceId) || deviceId;
    this.log.info(`Starting Warm Awake sequence for ${deviceName} (${alarm.name})`);
    
    try {
      // Get current device status
      const status = await this.apiService.getDeviceStatus(deviceId);
      
      if (!status) {
        this.log.error(`Unable to get status for device ${deviceName}`);
        return;
      }
      
      const startTemp = status["control.current_temperature_c"];
      const endTemp = alarm.targetTemperature;
      
      // Skip if already at target temperature
      if (Math.abs(startTemp - endTemp) < 0.5) {
        this.log.info(`Device ${deviceName} is already at target temperature (${endTemp}°C), skipping Warm Awake`);
        return;
      }
      
      // Calculate number of steps (one per minute)
      const steps = Math.max(5, Math.min(alarm.duration, 15));
      const tempIncrement = (endTemp - startTemp) / steps;
      
      // Generate a unique ID for this sequence
      const sequenceId = `warmAwake-${deviceId}-${Date.now()}`;
      
      // Create sequence object
      const sequence: WarmAwakeSequence = {
        id: sequenceId,
        startTime: new Date(),
        endTime: new Date(Date.now() + (alarm.duration * 60000)),
        currentStep: 0,
        totalSteps: steps,
        startTemp,
        endTemp,
        tempIncrement,
        intervalId: null
      };
      
      // First turn the device on if it's off
      await this.apiService.turnDeviceOn(deviceId, startTemp);
      
      // Set up interval to gradually change temperature
      const stepDuration = Math.floor(alarm.duration * 60000 / steps);
      sequence.intervalId = setInterval(async () => {
        try {
          sequence.currentStep++;
          
          // Calculate the current temperature based on the step
          const currentTemp = startTemp + (tempIncrement * sequence.currentStep);
          
          // Update device temperature
          await this.apiService.setDeviceSettings(deviceId, {
            "control.set_temperature_c": currentTemp
          });
          
          this.log.info(`Warm Awake step ${sequence.currentStep}/${steps} for ${deviceName}: ${currentTemp.toFixed(1)}°C`);
          
          // Check if the sequence is complete
          if (sequence.currentStep >= steps) {
            this.stopSequence(sequenceId);
            this.log.info(`Warm Awake sequence completed for ${deviceName}`);
          }
        } catch (error) {
          this.log.error(`Error in Warm Awake sequence for ${deviceName}: ${error}`);
        }
      }, stepDuration);
      
      // Store the sequence
      this.activeSequences.set(sequenceId, sequence);
      
      this.log.info(`Warm Awake sequence started for ${deviceName}, will increase from ${startTemp}°C to ${endTemp}°C over ${alarm.duration} minutes`);
    } catch (error) {
      this.log.error(`Error starting Warm Awake sequence for ${deviceName}: ${error}`);
    }
  }

  /**
   * Stop a specific sequence
   */
  private stopSequence(sequenceId: string): void {
    const sequence = this.activeSequences.get(sequenceId);
    
    if (sequence && sequence.intervalId) {
      clearInterval(sequence.intervalId);
      this.activeSequences.delete(sequenceId);
      this.log.debug(`Stopped Warm Awake sequence ${sequenceId}`);
    }
  }

  /**
   * Stop all active sequences
   */
  private stopAllSequences(): void {
    this.activeSequences.forEach(sequence => {
      if (sequence.intervalId) {
        clearInterval(sequence.intervalId);
      }
    });
    
    this.activeSequences.clear();
    this.log.debug('Stopped all Warm Awake sequences');
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
   * Subtract minutes from a time string (HH:MM)
   */
  private subtractMinutes(timeStr: string, minutes: number): string {
    const [hourStr, minuteStr] = timeStr.split(':');
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);
    
    const date = new Date();
    date.setHours(hour, minute, 0, 0);
    
    // Subtract the minutes
    date.setMinutes(date.getMinutes() - minutes);
    
    // Format back to HH:MM
    const newHour = date.getHours().toString().padStart(2, '0');
    const newMinute = date.getMinutes().toString().padStart(2, '0');
    
    return `${newHour}:${newMinute}`;
  }

  /**
   * Clear all scheduled jobs
   */
  private clearAllJobs(): void {
    this.jobs.forEach(job => {
      clearTimeout(job.timeoutId);
    });
    this.jobs.clear();
    this.log.debug('Cleared all Warm Awake jobs');
  }
}