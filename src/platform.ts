import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { SleepMePlatformAccessory } from './platformAccessory.js';
import { HumidityAccessory } from './humidity-accessory.js';
import { SleepMeApi } from './sleepme-api.js';
import { SchedulerService } from './scheduler/index.js';

export interface Device {
  id: string;
  name: string;
  attachments: string;
}

/**
 * HomebridgePlatform
 * This class is the main constructor function for your plugin.
 */
export class SleepMePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // Used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  
  // API service
  public readonly apiService: SleepMeApi;
  
  // Scheduler service
  private scheduler?: SchedulerService;
  
  // Configuration options
  public readonly verbose: boolean;
  public readonly enableHumidity: boolean;
  public readonly enableScheduling: boolean;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('Initializing SleepMePlatform platform...');

    // Initialize with default values
    this.apiService = new SleepMeApi(
      (this.config.apiToken as string) || '', 
      this.log
    );
    this.verbose = this.config.verbose === true;
    this.enableHumidity = this.config.enableHumidity === true;
    this.enableScheduling = this.config.enableScheduling === true;

    // Check for configuration errors
    if (!this.config.apiToken) {
      this.log.error('API Token is missing from configuration! Please add it to your config.json.');
      return;
    }

    // Create scheduler if enabled
    if (this.enableScheduling) {
      this.scheduler = new SchedulerService(this.config, this.apiService, this.log);
      this.log.info('Scheduler service created');
    }

    // When this event is fired, homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge twice.
    this.api.on('didFinishLaunching', () => {
      this.log.info('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
    
    // Handle shutdown
    this.api.on('shutdown', () => {
      this.log.info('Shutting down SleepMePlatform...');
      if (this.scheduler) {
        this.scheduler.shutdown();
      }
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // Ensure device context has necessary information
    if (!accessory.context.device || !accessory.context.device.id) {
      this.log.warn(`Cached accessory ${accessory.displayName} missing device ID. Will rediscover.`);
    } else {
      this.log.debug(`Cached accessory device ID: ${accessory.context.device.id}`);
    }

    // add the restored accessory to the accessories cache so we can track it later
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    this.log.info('Starting device discovery...');
    try {
      if (this.verbose) {
        this.log.debug('Discovering SleepMe devices...');
      }

      const devices = await this.apiService.getDevices();

      if (!devices || devices.length === 0) {
        this.log.error('No SleepMe devices found. Check your API token and connectivity.');
        return;
      }

      if (this.verbose) {
        this.log.debug('Found SleepMe devices:', JSON.stringify(devices));
      }

      this.log.info('Devices found:', devices.length);

      // Store a map of existing accessories by device ID for easy lookup
      const existingAccessories = new Map<string, PlatformAccessory>();
      this.accessories.forEach(accessory => {
        if (accessory.context.device && accessory.context.device.id) {
          existingAccessories.set(accessory.context.device.id, accessory);
        }
      });

      // Store map of device IDs to names for scheduler
      const deviceMap = new Map<string, string>();

      // Track which accessories are still in use
      const activeAccessories = new Set<string>();

      for (const device of devices) {
        if (!device.id) {
          this.log.warn(`Skipping device with missing ID: ${JSON.stringify(device)}`);
          continue;
        }

        // Get customized name if available
        let customName = device.name;
        if (this.config.devices) {
          const override = this.config.devices.find((d: { id: string }) => d.id === device.id);
          if (override && override.name) {
            customName = override.name;
            this.log.debug(`Using custom name for device ${device.id}: ${customName}`);
          }
        }

        // Store device name for scheduler
        deviceMap.set(device.id, customName);

        // Create thermostat accessory
        const uuid = this.api.hap.uuid.generate(device.id);
        activeAccessories.add(device.id);

        // Check if an accessory with this UUID already exists
        const existingAccessory = existingAccessories.get(device.id);

        if (existingAccessory) {
          this.log.info(`Restoring accessory from cache: ${existingAccessory.displayName} (ID: ${device.id})`);
          
          // Update the accessory context with fresh data
          existingAccessory.context.device = device;
          existingAccessory.displayName = customName;
          
          this.api.updatePlatformAccessories([existingAccessory]);
          new SleepMePlatformAccessory(this, existingAccessory, this.apiService);
          
        } else {
          // Create a new accessory
          this.log.info(`Adding new accessory: ${customName} (ID: ${device.id})`);
          const accessory = new this.api.platformAccessory(customName, uuid);
          
          // Store device info in the accessory context
          accessory.context.device = device;
          
          // Create the accessory handler
          new SleepMePlatformAccessory(this, accessory, this.apiService);
          
          // Register the accessory
          this.api.registerPlatformAccessories('homebridge-sleepmepro', 'SleepMePlatform', [accessory]);
        }

        // Create humidity accessory if enabled
        if (this.enableHumidity) {
          const humidityUuid = this.api.hap.uuid.generate(`${device.id}-humidity`);
          const humidityName = `${customName} Humidity`;
          
          // Check if a humidity accessory already exists
          const existingHumidityAccessory = this.accessories.find(accessory => 
            accessory.UUID === humidityUuid);
          
          if (existingHumidityAccessory) {
            this.log.info(`Restoring humidity accessory from cache: ${existingHumidityAccessory.displayName}`);
            
            // Update context
            existingHumidityAccessory.context.device = device;
            existingHumidityAccessory.displayName = humidityName;
            
            this.api.updatePlatformAccessories([existingHumidityAccessory]);
            new HumidityAccessory(this, existingHumidityAccessory, this.apiService);
            
            // Mark as active
            activeAccessories.add(`${device.id}-humidity`);
          } else {
            this.log.info(`Adding new humidity accessory: ${humidityName}`);
            const humidityAccessory = new this.api.platformAccessory(humidityName, humidityUuid);
            
            // Store device info in context
            humidityAccessory.context.device = device;
            
            // Create the accessory handler
            new HumidityAccessory(this, humidityAccessory, this.apiService);
            
            // Register the accessory
            this.api.registerPlatformAccessories('homebridge-sleepmepro', 'SleepMePlatform', [humidityAccessory]);
            
            // Mark as active
            activeAccessories.add(`${device.id}-humidity`);
          }
        }
      }

      // Initialize scheduler if enabled
      if (this.enableScheduling && this.scheduler && deviceMap.size > 0) {
        this.log.info('Initializing scheduler with discovered devices');
        this.scheduler.initialize(deviceMap);
      }

      // Remove accessories that no longer exist
      for (const accessory of this.accessories) {
        if (accessory.context.device && accessory.context.device.id) {
          const accessoryId = accessory.context.device.id;
          const isHumidity = accessory.UUID.includes('-humidity');
          
          // For humidity accessories, check the combined ID
          const activeId = isHumidity ? `${accessoryId}-humidity` : accessoryId;
          
          if (!activeAccessories.has(activeId)) {
            this.log.info(`Removing accessory no longer found: ${accessory.displayName}`);
            this.api.unregisterPlatformAccessories('homebridge-sleepmepro', 'SleepMePlatform', [accessory]);
          }
        }
      }

    } catch (error) {
      if (error instanceof Error) {
        this.log.error(`Error discovering devices: ${error.message}`);
      } else {
        this.log.error('Unknown error discovering devices');
      }
    }
    this.log.info('Device discovery completed.');
  }
}