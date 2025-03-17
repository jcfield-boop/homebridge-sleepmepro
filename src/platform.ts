import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { SleepMePlatformAccessory } from './platformAccessory.js';
import { SleepMeApi } from './sleepme-api.js';

interface DeviceOverride {
  id: string;
  name: string;
  verbose?: boolean;
}

export interface SleepMePlatformConfig extends PlatformConfig {
  apiToken: string;
  unit?: string;
  verbose?: boolean;
  devices?: DeviceOverride[];
}

export class SleepMePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly apiService!: SleepMeApi;
  private readonly verbose!: boolean;

  constructor(
    public readonly log: Logger,
    public readonly config: SleepMePlatformConfig,
    public readonly api: API,
  ) {
    if (!this.config.apiToken) {
      this.log.error('No API token specified in config. Plugin will not function.');
      return;
    }

    this.verbose = this.config.verbose || false;
    
    if (this.verbose) {
      this.log.debug('Initializing platform with config:', JSON.stringify(this.config));
    }
    
    // Create the API service
    this.apiService = new SleepMeApi(this.config.apiToken, this.log);

    this.api.on('didFinishLaunching', () => {
      if (this.verbose) {
        this.log.debug('Executed didFinishLaunching callback');
      }
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    this.log.info('Starting device discovery...');
    
    try {
      if (this.verbose) {
        this.log.debug('Discovering SleepMe devices...');
      }

      const devices = await this.apiService.getDevices();

      if (this.verbose) {
        this.log.debug(`Found ${devices.length} SleepMe devices:`, JSON.stringify(devices));
      }

      this.log.info(`Devices found: ${devices.length}`);

      // Handle each discovered device
      for (const device of devices) {
        // Apply any config overrides
        const override = this.config.devices?.find(d => d.id === device.deviceId);
        if (override) {
          if (override.name) {
            device.deviceName = override.name;
          }
          if (this.verbose || override.verbose) {
            this.log.debug(`Applied override for device ${device.deviceId}:`, JSON.stringify(override));
          }
        }

        // Generate UUID for the device
        const uuid = this.api.hap.uuid.generate(device.deviceId);
        
        // Check if we already know about this accessory
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

        if (existingAccessory) {
          // The accessory already exists
          this.log.info(`Restoring existing accessory from cache: ${existingAccessory.displayName}`);
          
          // Update context with the latest device info
          existingAccessory.context.device = device;
          
          // Create the accessory handler
          new SleepMePlatformAccessory(this, existingAccessory, this.apiService);
          
          // Update accessory.context.device with the latest data
          this.api.updatePlatformAccessories([existingAccessory]);
        } else {
          // The accessory does not yet exist, so we need to create it
          this.log.info(`Adding new accessory: ${device.deviceName}`);
          
          // Create a new accessory
          const accessory = new this.api.platformAccessory(device.deviceName, uuid);
          
          // Store device information in the accessory context
          accessory.context.device = device;
          
          // Create the accessory handler
          new SleepMePlatformAccessory(this, accessory, this.apiService);
          
          // Register the accessory
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
      
      // Clean up any accessories that are no longer available
      for (const existingAccessory of [...this.accessories]) {
        const isStillAvailable = devices.some(device => 
          this.api.hap.uuid.generate(device.deviceId) === existingAccessory.UUID
        );
        
        if (!isStillAvailable) {
          this.log.info(`Removing accessory no longer available: ${existingAccessory.displayName}`);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
          
          // Remove from our internal accessories array
          const index = this.accessories.indexOf(existingAccessory);
          if (index !== -1) {
            this.accessories.splice(index, 1);
          }
        }
      }
    } catch (error) {
      this.log.error('Error discovering devices:', error);
    }
    
    this.log.info('Device discovery completed.');
  }
}