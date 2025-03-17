import { Logger } from 'homebridge';
import axios, { AxiosResponse, AxiosError } from 'axios';

export interface SleepMeDevice {
  deviceId: string;
  deviceName: string;
  model: string;
  firmwareVersion?: string;
  status?: {
    currentTemperature?: number;
    targetTemperature?: number;
    heatingCoolingState?: string;
  };
}

export interface DeviceResponse {
  id: string;
  name: string;
  model: string;
  status?: {
    water_temperature_c?: number;
  };
  control?: {
    set_temperature_c?: number;
    thermal_control_status?: string;
  };
  about?: {
    firmware_version?: string;
  };
}

export class SleepMeApi {
  private apiToken: string;
  private readonly log: Logger;
  private readonly apiBaseUrl = 'https://api.developer.sleep.me/v1';
  private requestCount = 0;
  private minuteStart = 0;
  private apiRateLimitQueue: Array<() => Promise<any>> = [];
  private isProcessingQueue = false;

  constructor(apiToken: string, log: Logger) {
    this.apiToken = apiToken;
    this.log = log;
    
    // Initialize request rate limiting
    this.requestCount = 0;
    this.minuteStart = Math.floor(Date.now() / 60000);
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
          this.log.debug(`Rate limit reached, waiting ${delay}ms`);
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
            this.log.error(`Error processing queued request: ${error}`);
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
        this.log.error(`Error processing rate limit queue: ${error}`);
      });
    });
  }

  private logAxiosResponse(method: string, url: string, response: AxiosResponse): void {
    if (response.status >= 400) {
      this.log.error(`[API Error] ${method} ${url} - Status: ${response.status}`);
    } else {
      this.log.debug(`[API] ${method} ${url} - Status: ${response.status}`);
    }
  }

  private handleAxiosError(error: unknown, method: string): void {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        this.log.error(
          `API Error in ${method}: ${axiosError.response.status} - ${JSON.stringify(axiosError.response.data)}`,
        );
      } else if (axiosError.request) {
        this.log.error(`API Error in ${method}: No response received - ${axiosError.message}`);
      } else {
        this.log.error(`API Error in ${method}: ${axiosError.message}`);
      }
    } else if (error instanceof Error) {
      this.log.error(`Unknown error in ${method}: ${error.message}`);
    } else {
      this.log.error(`Unknown error occurred in ${method}: ${error}`);
    }
  }

  private mapSleepMeStatusToHomeKit(status: string): number {
    switch (status?.toLowerCase()) {
      case 'heating':
        return 1; // HEAT
      case 'cooling':
        return 2; // COOL
      default:
        return 0; // OFF
    }
  }

  private mapHomeKitStateToSleepMe(state: number): string {
    switch (state) {
      case 1: // HEAT
        return 'heating';
      case 2: // COOL
        return 'cooling';
      default:
        return 'off';
    }
  }

  async getDevices(): Promise<SleepMeDevice[]> {
    try {
      const url = `${this.apiBaseUrl}/devices`;
      this.log.debug(`Fetching devices from: ${url}`);

      const response = await this.rateLimitedApiCall<AxiosResponse<{devices: DeviceResponse[]}>>(
        async () => {
          return await axios({
            method: 'get',
            url,
            headers: {
              Authorization: `Bearer ${this.apiToken}`,
              'Content-Type': 'application/json',
            },
          });
        },
      );

      this.logAxiosResponse('GET', url, response);

      if (!response.data || !response.data.devices) {
        this.log.error('Invalid response format from API');
        return [];
      }

      return response.data.devices.map(device => ({
        deviceId: device.id,
        deviceName: device.name,
        model: device.model || 'Unknown',
        firmwareVersion: device.about?.firmware_version || 'Unknown',
      }));
    } catch (error) {
      this.handleAxiosError(error, 'getDevices');
      return [];
    }
  }

  async getDeviceStatus(deviceId: string): Promise<SleepMeDevice | null> {
    try {
      const url = `${this.apiBaseUrl}/devices/${deviceId}`;
      this.log.debug(`Fetching device status from: ${url}`);

      const response = await this.rateLimitedApiCall<AxiosResponse<DeviceResponse>>(
        async () => {
          return await axios({
            method: 'get',
            url,
            headers: {
              Authorization: `Bearer ${this.apiToken}`,
              'Content-Type': 'application/json',
            },
          });
        },
      );

      this.logAxiosResponse('GET', url, response);

      if (!response.data) {
        this.log.error('Invalid response format from API for device status');
        return null;
      }

      const device = response.data;
      return {
        deviceId: device.id,
        deviceName: device.name,
        model: device.model || 'Unknown',
        firmwareVersion: device.about?.firmware_version || 'Unknown',
        status: {
          currentTemperature: device.status?.water_temperature_c,
          targetTemperature: device.control?.set_temperature_c,
          heatingCoolingState: device.control?.thermal_control_status,
        },
      };
    } catch (error) {
      this.handleAxiosError(error, 'getDeviceStatus');
      return null;
    }
  }

  async setTargetTemperature(deviceId: string, temperature: number): Promise<boolean> {
    try {
      const url = `${this.apiBaseUrl}/devices/${deviceId}`;
      this.log.debug(`Setting target temperature to ${temperature}°C for device ${deviceId}`);

      const response = await this.rateLimitedApiCall<AxiosResponse>(
        async () => {
          return await axios({
            method: 'patch',
            url,
            headers: {
              Authorization: `Bearer ${this.apiToken}`,
              'Content-Type': 'application/json',
            },
            data: {
              set_temperature_c: temperature,
            },
          });
        },
      );

      this.logAxiosResponse('PATCH', url, response);
      return response.status >= 200 && response.status < 300;
    } catch (error) {
      this.handleAxiosError(error, 'setTargetTemperature');
      return false;
    }
  }

  async setHeatingCoolingState(deviceId: string, state: number): Promise<boolean> {
    try {
      const url = `${this.apiBaseUrl}/devices/${deviceId}`;
      const thermalControlStatus = this.mapHomeKitStateToSleepMe(state);
      this.log.debug(`Setting thermal control status to ${thermalControlStatus} for device ${deviceId}`);

      const response = await this.rateLimitedApiCall<AxiosResponse>(
        async () => {
          return await axios({
            method: 'patch',
            url,
            headers: {
              Authorization: `Bearer ${this.apiToken}`,
              'Content-Type': 'application/json',
            },
            data: {
              thermal_control_status: thermalControlStatus,
            },
          });
        },
      );

      this.logAxiosResponse('PATCH', url, response);
      return response.status >= 200 && response.status < 300;
    } catch (error) {
      this.handleAxiosError(error, 'setHeatingCoolingState');
      return false;
    }
  }

  async updateDeviceSettings(deviceId: string, temperature: number, state: number): Promise<boolean> {
    try {
      const url = `${this.apiBaseUrl}/devices/${deviceId}`;
      const thermalControlStatus = this.mapHomeKitStateToSleepMe(state);
      
      this.log.debug(`Updating device settings: Temp=${temperature}°C, State=${thermalControlStatus}`);

      const response = await this.rateLimitedApiCall<AxiosResponse>(
        async () => {
          return await axios({
            method: 'patch',
            url,
            headers: {
              Authorization: `Bearer ${this.apiToken}`,
              'Content-Type': 'application/json',
            },
            data: {
              set_temperature_c: temperature,
              thermal_control_status: thermalControlStatus,
            },
          });
        },
      );

      this.logAxiosResponse('PATCH', url, response);
      return response.status >= 200 && response.status < 300;
    } catch (error) {
      this.handleAxiosError(error, 'updateDeviceSettings');
      return false;
    }
  }

  // Utility method for temperature conversion
  convertTemperature(temp: number, targetUnit: string): number {
    if (targetUnit === 'F') {
      // Convert from C to F
      return (temp * 9/5) + 32;
    } else {
      // Convert from F to C
      return (temp - 32) * 5/9;
    }
  }
}