import { Logger, PlatformConfig } from 'homebridge';
import { SleepMeApi } from '../sleepme-api.js';
import { ScheduleManager } from './schedule-manager.js';
import { WarmAwakeManager } from './warm-awake-manager.js';

export class SchedulerService {
  private scheduleManager: ScheduleManager;
  private warmAwakeManager: WarmAwakeManager;
  private initialized = false;

  constructor(
    private readonly config: PlatformConfig,
    private readonly apiService: SleepMeApi,
    private readonly log: Logger
  ) {
    this.log.info('Creating Scheduler Service');
    
    // Create managers
    this.scheduleManager = new ScheduleManager(config, apiService, log);
    this.warmAwakeManager = new WarmAwakeManager(config, apiService, log);
  }

  /**
   * Initialize the scheduler service with available devices
   */
  public initialize(deviceMap: Map<string, string>): void {
    if (this.initialized) {
      this.log.warn('Scheduler Service already initialized, skipping');
      return;
    }

    this.log.info('Initializing Scheduler Service');

    // Check if scheduling is enabled
    if (this.config.enableScheduling !== true) {
      this.log.info('Scheduling is disabled in config, not initializing');
      return;
    }

    // Ensure we have devices
    if (deviceMap.size === 0) {
      this.log.warn('No devices available for scheduling');
      return;
    }

    // Initialize components
    this.scheduleManager.initialize(deviceMap);
    this.warmAwakeManager.initialize(deviceMap);

    this.initialized = true;
    this.log.info('Scheduler Service initialized successfully');
  }

  /**
   * Shutdown the scheduler service
   */
  public shutdown(): void {
    if (!this.initialized) {
      this.log.debug('Scheduler Service not initialized, nothing to shutdown');
      return;
    }

    this.log.info('Shutting down Scheduler Service');

    // Shutdown components
    this.scheduleManager.shutdown();
    this.warmAwakeManager.shutdown();

    this.initialized = false;
    this.log.info('Scheduler Service shutdown complete');
  }
}