/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Service, Characteristic, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SleepMePlatform } from './platform.js';
import axios from 'axios';  // Import axios
import type { AxiosResponse, AxiosError, AxiosRequestConfig, AxiosInstance } from 'axios';

// Make sure we have a proper axios instance with all methods
const axiosInstance: AxiosInstance = axios as any;

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
  private targetHeatingState = 0;
  private firmwareVersion = 'Unknown';
  private requestCount: number;
  private minuteStart: number;
  private apiRateLimitQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.deviceId = accessory.context.device.id;
    
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
        minStep: 0.5
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

    // Initialize request rate limiting
    this.requestCount = 0;
    this.minuteStart = Math.floor(Date.now() / 60000);

    // Initialize device status and set up polling
    this.getDeviceStatus()
      .catch(error => this.platform.log.error(`Error initializing device status: ${error}`));
    
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

    this.isProcessingQueue = false;
  }

  private async rateLimitedApiCall<T>(apiCall: () => Promise<T>): Promise<T> {
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

  async getDeviceStatus(): Promise<void> {
    try {
      const url = `https://api.developer.sleep.me/v1/devices/${this.deviceId}`;
      const headers = {
        Authorization: `Bearer ${this.platform.config.apiToken}`,
        'Content-Type': 'application/json',
      };

      const response = await this.rateLimitedApiCall<AxiosResponse<DeviceStatusResponse>>(
        async () => {
          // Fixed axios call using the axios instance with request method
          return await axiosInstance.request({
            method: 'GET',
            url,
            headers
          });
        }
      );

      this.logAxiosResponse('GET', url, response);
      
      if (response.data) {
        this.currentTemperature = response.data.status.water_temperature_c;
        this.targetTemperature = response.data.control.set_temperature_c;
        this.currentHeatingState = this.mapSleepMeStatusToHomeKit(response.data.control.thermal_control_status);
        this.targetHeatingState = this.currentHeatingState; // Assuming target state matches current state
        this.firmwareVersion = response.data.about.firmware_version || 'Unknown';
        
        this.platform.log.debug(`Device status updated: Temp: ${this.currentTemperature}°C, Target: ${this.targetTemperature}°C, State: ${response.data.control.thermal_control_status}`);
        
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.currentTemperature);
        this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.targetTemperature);
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, this.currentHeatingState);
        this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, this.targetHeatingState);
      }
    } catch (error: any) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        this.platform.log.error(`API Error: ${axiosError.response.status} - ${JSON.stringify(axiosError.response.data)}`);
      } else if (axiosError.request) {
        this.platform.log.error(`API Error: No response received - ${axiosError.message}`);
      } else {
        this.platform.log.error(`Unknown error: ${error}`);
      }
      throw error;
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
    return this.targetHeatingState;
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    this.targetHeatingState = value as number;
    return this.updateDeviceSettings();
  }

  private async updateDeviceSettings(): Promise<void> {
    try {
      const url = `https://api.developer.sleep.me/v1/devices/${this.deviceId}`;
      const headers = {
        Authorization: `Bearer ${this.platform.config.apiToken}`,
        'Content-Type': 'application/json',
      };
      
      const thermalControlStatus = this.mapHomeKitStateToSleepMe(this.targetHeatingState);
      
      const data = {
        set_temperature_c: this.targetTemperature,
        brightness_level: 100,
        thermal_control_status: thermalControlStatus,
      };

      this.platform.log.debug(`Updating device settings: ${JSON.stringify(data)}`);

      await this.rateLimitedApiCall(async () => {
        // Fixed axios call using the axios instance with request method
        const response = await axiosInstance.request({
          method: 'PATCH',
          url,
          headers,
          data
        });
        this.logAxiosResponse('PATCH', url, response);
        this.platform.log.info(`Device updated: Temperature=${this.targetTemperature}°C, State=${thermalControlStatus}`);
      });
    } catch (error: any) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        this.platform.log.error(`API Error: ${axiosError.response.status} - ${JSON.stringify(axiosError.response.data)}`);
      } else if (axiosError.request) {
        this.platform.log.error(`API Error: No response received - ${axiosError.message}`);
      } else {
        this.platform.log.error(`Unknown error: ${error}`);
      }
      throw error;
    }
  }
}