import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { SleepMePlatformAccessory } from './platformAccessory.js';
import { SleepMeApi } from './sleepme-api.js';

interface SleepMePlatformConfig extends PlatformConfig {
  apiToken: string;
  verbose?: boolean;
}

export class SleepMePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly apiService: SleepMeApi;
  private readonly verbose: boolean;

  constructor(
    public readonly log: Logger,
    public readonly config: SleepMePlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);
    this.apiService = new SleepMeApi(this.config.apiToken, this.log);
    this.verbose = this.config.verbose || false;

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    try {
      if (this.verbose) {
        this.log.debug('Discovering SleepMe devices...');
      }

      const devices = await this.apiService.getDevices();

      if (this.verbose) {
        this.log.debug('Found SleepMe devices:', devices);
      }

      for (const device of devices) {
        const uuid = this.api.hap.uuid.generate(device.deviceId);
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

        if (existingAccessory) {
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
          new SleepMePlatformAccessory(this, existingAccessory, this.apiService);
        } else {
          this.log.info('Adding new accessory:', device.deviceName);
          const accessory = new this.api.platformAccessory(device.deviceName, uuid);
          accessory.context.device = device;
          new SleepMePlatformAccessory(this, accessory, this.apiService);
          this.api.registerPlatformAccessories('homebridge-sleepmepro', 'SleepMePlatform', [accessory]);
        }
      }
    } catch (error) {
      this.log.error('Error discovering devices:', error);
    }
  }
}