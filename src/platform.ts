/* eslint-disable @typescript-eslint/no-explicit-any */
import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import axios, { AxiosResponse, AxiosError } from 'axios';

import { SleepMeAccessory } from './accessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

interface Device {
  id: string;
  // Add other properties as needed from the API response
  // Example: name: string;
}

interface DeviceStatusResponse {
  about: {
    firmware_version: string;
  };
  // Add other properties as needed
}

export class SleepMePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly apiToken: string;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.apiToken = config.apiToken as string;

    if (!this.apiToken) {
      this.log.error('API Token not provided in config.json.');
      return;
    }

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverDevices() {
    try {
      this.log.info('Discovering Sleepme devices...');
      const devicesUrl = 'https://api.developer.sleep.me/v1/devices';
      const headers = {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      };

      const devicesResponse: AxiosResponse<Device[]> = await axios.get(devicesUrl, { headers });

      if (devicesResponse.data && devicesResponse.data.length > 0) {
        this.log.info(`Found ${devicesResponse.data.length} Sleepme device(s).`);
        for (const device of devicesResponse.data) {
          const uuid = this.api.hap.uuid.generate(device.id);
          const existingAccessory = this.accessories.get(uuid);

          if (existingAccessory) {
            this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
            new SleepMeAccessory(this, existingAccessory);
          } else {
            this.log.info('Adding new accessory:', device.id);
            const accessory = new this.api.platformAccessory(device.id, uuid);
            // Add more device context if needed
            accessory.context.device = device;
            new SleepMeAccessory(this, accessory);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          }

          // Fetch and log device status
          await this.fetchDeviceStatus(device.id);
        }
      } else {
        this.log.warn('No Sleepme devices found.');
      }
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          this.log.error(`[API Error] GET devices - Status: ${axiosError.response.status}`);
          this.log.error(`[API Error Data] ${JSON.stringify(axiosError.response.data)}`);
        } else if (axiosError.request) {
          this.log.error('[API Error] GET devices - No response received');
        } else {
          this.log.error(`[API Error] GET devices - ${axiosError.message}`);
        }
      } else {
        this.log.error(`[API Error] GET devices - An unknown error occurred: ${error}`);
      }
    }
  }

  async fetchDeviceStatus(deviceId: string) {
    try {
      const statusUrl = `https://api.developer.sleep.me/v1/devices/${deviceId}`;
      const headers = {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      };

      const statusResponse: AxiosResponse<DeviceStatusResponse> = await axios.get(statusUrl, { headers });

      this.log.info(`Device ${deviceId} status:`, statusResponse.data);
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          this.log.error(`[API Error] GET device status - Status: ${axiosError.response.status}`);
          this.log.error(`[API Error Data] ${JSON.stringify(axiosError.response.data)}`);
        } else if (axiosError.request) {
          this.log.error('[API Error] GET device status - No response received');
        } else {
          this.log.error(`[API Error] GET device status - ${axiosError.message}`);
        }
      } else {
        this.log.error(`[API Error] GET device status - An unknown error occurred: ${error}`);
      }
    }
  }
}