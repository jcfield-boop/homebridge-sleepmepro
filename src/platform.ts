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
import { SleepMeApi } from './sleepme-api.js';

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

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  
  // Initialize with default values to fix linting errors
  public readonly apiService: SleepMeApi;
  public readonly verbose: boolean;

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

    // Check for configuration errors
    if (!this.config.apiToken) {
      this.log.error('API Token is missing from configuration! Please add it to your config.json.');
      return;
    }

    // When this event is fired, homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge twice.
    this.api.on('didFinishLaunching', () => {
      this.log.info('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
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
      }

      // Remove accessories that no longer exist
      for (const accessory of this.accessories) {
        if (accessory.context.device && accessory.context.device.id && !activeAccessories.has(accessory.context.device.id)) {
          this.log.info(`Removing accessory no longer found: ${accessory.displayName}`);
          this.api.unregisterPlatformAccessories('homebridge-sleepmepro', 'SleepMePlatform', [accessory]);
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