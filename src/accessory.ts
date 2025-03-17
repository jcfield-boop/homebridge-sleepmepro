// Description: This file contains the SleepMeAccessory class, which is responsible for handling
// the HomeKit thermostat accessory for a SleepMe device. The class is responsible for updating
// the device status, handling rate limiting, and mapping between HomeKit and SleepMe states.
// The class also contains methods for getting and setting the current and target temperature and
// heating state, as well as updating the device settings.
import axios, { AxiosResponse, AxiosError } from 'axios';
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SleepMePlatform } from './platform.js';

interface DeviceStatusResponse {
  status: {
    water_temperature_c: number;
  };
  control: {
    set_temperature_c: number;
    thermal_control_status: string;
  };
  about: {
    firmware_version: string;
  };
  // Add other properties as needed
}

export class SleepMeAccessory {
  private service: Service;
  private readonly deviceId: string;
  private currentTemperature = 0;
  private targetTemperature = 0;
  private currentHeatingState = 0;
  private firmwareVersion = 'Unknown';
  private requestCount = 0;
  private minuteStart = 0;
  private apiRateLimitQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.deviceId = accessory.context.device.id;

    // Initialize request rate limiting
    this.requestCount = 0;
    this.minuteStart = Math.floor(Date.now() / 60000);

    // Set up the service
    this.service = this.accessory.getService(platform.Service.Thermostat) ||
      this.accessory.addService(platform.Service.Thermostat);

    this.service.setCharacteristic(platform.Characteristic.Name, accessory.displayName);

    // Set up characteristic handlers
    this.service.getCharacteristic(platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.service.getCharacteristic(platform.Characteristic.TargetTemperature)
      .setProps({
        minValue: 10,
        maxValue: 46,
        minStep: 0.5,
      })
      .onSet(this.setTargetTemperature.bind(this))
      .onGet(this.getTargetTemperature.bind(this));

    this.service.getCharacteristic(platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    this.service.getCharacteristic(platform.Characteristic.TargetHeatingCoolingState)
      .onSet(this.setTargetHeatingCoolingState.bind(this))
      .onGet(this.getTargetHeatingCoolingState.bind(this));

    this.service.getCharacteristic(platform.Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);

    // Initialize device status and set up polling
    this.getDeviceStatus()
      .catch(error => this.platform.log.error(`Error initializing device status: ${error}`));

    // Set up polling interval
    setInterval(() => {
      this.getDeviceStatus()
        .catch(error => this.platform.log.error(`Error updating device status: ${error}`));
    }, 60000); // Update every minute
  }

  private logAxiosResponse(method: string, url: string, response: AxiosResponse): void {
    if (response.status >= 400) {
      this.platform.log.error(`[API Error] ${method} ${url} - Status: ${response.status}`);
    } else {
      this.platform.log.debug(`[API] ${method} ${url} - Status: ${response.status}`);
    }
  }
  private async processRateLimitQueue(): Promise<void> {
    if (this.isProcessingQueue || this.apiRateLimitQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.apiRateLimitQueue.length > 0) {
        const currentMinute = Math.floor(Date.now() / 60000);

        if (currentMinute > this.minuteStart) {
          this.minuteStart = currentMinute;
          this.requestCount = 0;
        }

        if (this.requestCount >= 10) {
          const delay = (this.minuteStart + 1) * 60000 - Date.now() + 100; // Add 100ms buffer
          this.platform.log.debug(`Rate limit reached, waiting ${delay}ms`);
          await new Promise<void>(resolve => setTimeout(resolve, delay));
          this.minuteStart = Math.floor(Date.now() / 60000);
          this.requestCount = 0;
          continue;
        }

        const nextRequest = this.apiRateLimitQueue.shift();
        if (nextRequest) {
          this.requestCount++;
          try {
            await nextRequest();
          } catch (error) {
            this.platform.log.error(`Error processing queued request: ${error}`);
          }
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private rateLimitedApiCall<T>(apiCall: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.apiRateLimitQueue.push(async () => {
        try {
          const result = await apiCall();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      this.processRateLimitQueue().catch(error => {
        this.platform.log.error(`Error processing rate limit queue: ${error}`);
      });
    });
  }

  private mapSleepMeStatusToHomeKit(status: string): number {
    switch (status.toLowerCase()) {
    case 'heating':
      return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
    case 'cooling':
      return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
    default:
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  async getDeviceStatus(): Promise<void> {
    try {
      const url = `https://api.developer.sleep.me/v1/devices/${this.deviceId}`;
      this.platform.log.debug(`Fetching device status from: ${url}`);

      const response = await this.rateLimitedApiCall<AxiosResponse<DeviceStatusResponse>>(
        async () => {
          return await axios<DeviceStatusResponse>({
            method: 'get',
            url: url,
            headers: {
              Authorization: `Bearer ${this.platform.config.apiToken}`,
              'Content-Type': 'application/json',
            },
          });
        },
      );

      this.logAxiosResponse('GET', url, response);

      if (response.data) {
        this.currentTemperature = response.data.status.water_temperature_c;
        this.targetTemperature = response.data.control.set_temperature_c;
        this.currentHeatingState = this.mapSleepMeStatusToHomeKit(response.data.control.thermal_control_status);
        this.firmwareVersion = response.data.about.firmware_version || 'Unknown';

        this.platform.log.debug(
          `Device status updated: Temp: ${this.currentTemperature}°C, ` +
          `Target: ${this.targetTemperature}°C, State: ${response.data.control.thermal_control_status}`,
        );

        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.currentTemperature);
        this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.targetTemperature);
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, this.currentHeatingState);
      }
    } catch (error: unknown) {
      this.handleAxiosError(error, 'getDeviceStatus');
      throw error;
    }
  }

  private handleAxiosError(error: unknown, method: string): void {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        this.platform.log.error(
          `API Error in ${method}: ${axiosError.response.status} - ${JSON.stringify(axiosError.response.data)}`,
        );
      } else if (axiosError.request) {
        this.platform.log.error(`API Error in ${method}: No response received - ${axiosError.message}`);
      } else {
        this.platform.log.error(`API Error in ${method}: ${axiosError.message}`);
      }
    } else if (error instanceof Error) {
      this.platform.log.error(`Unknown error in ${method}: ${error.message}`);
    } else {
      this.platform.log.error(`Unknown error occurred in ${method}: ${error}`);
    }
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    return this.currentTemperature;
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    return this.targetTemperature;
  }

  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    this.targetTemperature = value as number;
    return this.updateDeviceSettings();
  }

  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.currentHeatingState;
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.currentHeatingState;
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    this.currentHeatingState = value as number;
    return this.updateDeviceSettings();
  }

  private async updateDeviceSettings(): Promise<void> {
    try {
      const url = `https://api.developer.sleep.me/v1/devices/${this.deviceId}`;
      const thermalControlStatus = this.mapHomeKitStateToSleepMe(this.currentHeatingState);

      const data = {
        set_temperature_c: this.targetTemperature,
        brightness_level: 100,
        thermal_control_status: thermalControlStatus,
      };

      this.platform.log.debug(`Updating device settings: ${JSON.stringify(data)}`);

      await this.rateLimitedApiCall(async () => {
        const response = await axios.patch(url, data, {
          headers: {
            Authorization: `Bearer ${this.platform.config.apiToken}`,
            'Content-Type': 'application/json',
          },
        });
        this.logAxiosResponse('PATCH', url, response);
        this.platform.log.info(`Device updated: Temperature=${this.targetTemperature}°C, State=${thermalControlStatus}`);
      });
    } catch (error: unknown) {
      this.handleAxiosError(error, 'updateDeviceSettings');
      throw error;
    }
  }

  private mapHomeKitStateToSleepMe(state: number): string {
    switch (state) {
    case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
      return 'heating';
    case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
      return 'cooling';
    default:
      return 'off';
    }
  }
}