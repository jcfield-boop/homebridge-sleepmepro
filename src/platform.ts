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
 * extract the name from dynamic platform plugin
 * The plugin can register multiple platforms each time when initialize the plugin.
 */
export class SleepMePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  public readonly apiService: SleepMeApi;

  public readonly verbose: boolean;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('Initializing SleepMePlatform platform...');

    this.apiService = new SleepMeApi(this.config.apiToken as string, this.log);
    this.verbose = this.config.verbose === true;

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
   * It should be used to set up event handlers for:
   * - Characteristic get/set events
   * - Service calls (e.g. identify)
   * - Accessory visibility
   *
   * Note that cached accessories may provide old and/or incomplete cached data.
   * You must therefore update your accessories to reflect current values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

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

      if (this.verbose) {
        this.log.debug('Found SleepMe devices:', devices);
      }

      this.log.info('Devices found:', devices.length);

      for (const device of devices) {
        // Use device.id instead of device.deviceId
        const uuid = this.api.hap.uuid.generate(device.id);
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

        if (existingAccessory) {
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
          new SleepMePlatformAccessory(this, existingAccessory, this.apiService);
        } else {
          // Use device.name instead of device.deviceName
          this.log.info(`Adding new accessory: ${device.name}`);
          const accessory = new this.api.platformAccessory(device.name, uuid);
          accessory.context.device = device;
          new SleepMePlatformAccessory(this, accessory, this.apiService);
          this.api.registerPlatformAccessories('homebridge-sleepmepro', 'SleepMePlatform', [accessory]);
        }

        // Add this back if you need it, and adjust accordingly
        if (this.config.devices) {
          interface DeviceConfig {
            id: string;
            name: string;
          }

                    const override: DeviceConfig | undefined = this.config.devices?.find((d: DeviceConfig) => d.id === device.id);
          if (override) {
            device.name = override.name;
            this.log.debug(`Applied override for device ${device.id}:`, JSON.stringify(override));
          }
        }
      }
    } catch (error) {
      this.log.error('Error discovering devices:', error);
    }
    this.log.info('Device discovery completed.');
  }
}