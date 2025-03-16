 
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SleepMePlatform } from './platform';
import axios, { AxiosResponse, AxiosError } from 'axios';

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
}

export class SleepMeAccessory {
  private service: Service;
  private readonly deviceId: string;
  private currentTemperature = 0;
  private targetTemperature = 0;
  private currentHeatingState = 0;
  private firmwareVersion = 'Unknown';
  private requestCount: number;
  private minuteStart: number;

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.deviceId = accessory.context.device.id;
    
    // Add or get the thermostat service
    this.service = this.accessory.getService(platform.Service.Thermostat) || 
      this.accessory.addService(platform.Service.Thermostat);
    
    // Set basic characteristics
    this.service.setCharacteristic(platform.Characteristic.Name, accessory.displayName);
    
    // Set up temperature display units
    this.service.setCharacteristic(
      this.platform.Characteristic.TemperatureDisplayUnits,
      this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
    );
    
    // Configure current temperature
    this.service.getCharacteristic(platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));
    
    // Configure target temperature with valid range
    this.service.getCharacteristic(platform.Characteristic.TargetTemperature)
      .setProps({
        minValue: 15,  // Adjust based on device capabilities
        maxValue: 45,
        minStep: 1,
      })
      .onSet(this.setTargetTemperature.bind(this))
      .onGet(this.getTargetTemperature.bind(this));
    
    // Configure current heating/cooling state
    this.service.getCharacteristic(platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));
    
    // Configure target heating/cooling state with valid values
    const targetStateChar = this.service.getCharacteristic(platform.Characteristic.TargetHeatingCoolingState);
    targetStateChar.setProps({
      validValues: [
        this.platform.Characteristic.TargetHeatingCoolingState.OFF,
        this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
        // Add COOL if your device supports cooling
        // this.platform.Characteristic.TargetHeatingCoolingState.COOL,
        // Add AUTO if your device supports auto mode
        // this.platform.Characteristic.TargetHeatingCoolingState.AUTO,
      ],
    });
    targetStateChar.onSet(this.setTargetHeatingCoolingState.bind(this))
      .onGet(this.getTargetHeatingCoolingState.bind(this));
    
    // Set up information service
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation) || 
      this.accessory.addService(this.platform.Service.AccessoryInformation);
    
    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'SleepMe')
      .setCharacteristic(this.platform.Characteristic.Model, 'Pro')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.deviceId)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.firmwareVersion);
    
    // Initialize state
    this.getDeviceStatus();
    
    // Set up polling
    setInterval(() => this.getDeviceStatus(), 60000); // Update every minute
    
    // Initialize rate limiting
    this.requestCount = 0;
    this.minuteStart = Math.floor(Date.now() / 60000);
  }

  private logAxiosResponse(method: string, url: string, response: AxiosResponse): void {
    if (response.status >= 400) {
      this.platform.log.error(`[API Error] ${method} ${url} - Status: ${response.status}`);
    }
  }

  private async rateLimitedApiCall<T>(apiCall: () => Promise<T>): Promise<T> {
    const currentMinute = Math.floor(Date.now() / 60000);
    
    // Reset counter for a new minute
    if (currentMinute > this.minuteStart) {
      this.minuteStart = currentMinute;
      this.requestCount = 0;
    }
    
    // If we've hit the rate limit, wait until the next minute
    if (this.requestCount >= 10) {
      // Add small random jitter to prevent all accessories from resetting at the same time
      const jitter = Math.floor(Math.random() * 500);
      const delay = (this.minuteStart + 1) * 60000 - Date.now() + jitter;
      this.platform.log.debug(`Rate limit reached, waiting ${delay}ms`);
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      this.minuteStart++;
      this.requestCount = 0;
    }
    
    this.requestCount++;
    return apiCall();
  }

  async getDeviceStatus(): Promise<void> {
    try {
      const url = `https://api.developer.sleep.me/v1/devices/${this.deviceId}`;
      const headers = {
        Authorization: `Bearer ${this.platform.config.apiToken}`,
        'Content-Type': 'application/json',
      };
      
      const response: AxiosResponse<DeviceStatusResponse> = await this.rateLimitedApiCall(async () => {
        return axios.get(url, { headers });
      });
      
      this.logAxiosResponse('GET', url, response);
      
      // Update local state
      this.currentTemperature = response.data.status.water_temperature_c;
      this.targetTemperature = response.data.control.set_temperature_c;
      this.currentHeatingState = response.data.control.thermal_control_status === 'heating' ? 1 : 0;
      this.firmwareVersion = response.data.about.firmware_version || 'Unknown';
      
      // Update firmware version
      const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation);
      if (infoService) {
        infoService.updateCharacteristic(
          this.platform.Characteristic.FirmwareRevision, 
          this.firmwareVersion,
        );
      }
      
      // Update HomeKit characteristics
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.currentTemperature);
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.targetTemperature);
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState, 
        this.currentHeatingState,
      );
      
      const tempMsg = `Updated device ${this.deviceId}: Temp: ${this.currentTemperature}°C, `;
      const stateMsg = `Target: ${this.targetTemperature}°C, State: ${this.currentHeatingState}`;
      this.platform.log.debug(tempMsg + stateMsg);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          this.platform.log.error(`[API Error] GET device status - Status: ${axiosError.response.status}`);
          if (axiosError.response.data) {
            this.platform.log.error(`[API Error Data] ${JSON.stringify(axiosError.response.data)}`);
          }
        } else if (axiosError.request) {
          this.platform.log.error('[API Error] GET device status - No response received');
        } else {
          this.platform.log.error(`[API Error] GET device status - ${axiosError.message}`);
        }
      } else {
        this.platform.log.error(`An unknown error occurred: ${error}`);
      }
      
      // Implement retry logic for transient failures
      this.platform.log.debug('Scheduling retry in 30 seconds...');
      setTimeout(() => {
        void this.getDeviceStatus();
      }, 30000);
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
    try {
      const url = `https://api.developer.sleep.me/v1/devices/${this.deviceId}`;
      const headers = {
        Authorization: `Bearer ${this.platform.config.apiToken}`,
        'Content-Type': 'application/json',
      };
      const data = {
        set_temperature_c: this.targetTemperature,
        brightness_level: 100,
        thermal_control_status: this.currentHeatingState === 1 ? 'heating' : 'cooling',
      };
      
      await this.rateLimitedApiCall(async () => {
        const response = await axios.patch(url, data, { headers });
        this.logAxiosResponse('PATCH', url, response);
        this.platform.log.info(`Temperature set to ${this.targetTemperature}°C for device ${this.deviceId}`);
        return response;
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          this.platform.log.error(`[API Error] PATCH temperature - Status: ${axiosError.response.status}`);
          if (axiosError.response.data) {
            this.platform.log.error(`[API Error Data] ${JSON.stringify(axiosError.response.data)}`);
          }
        } else if (axiosError.request) {
          this.platform.log.error('[API Error] PATCH temperature - No response received');
        } else {
          this.platform.log.error(`[API Error] PATCH temperature - ${axiosError.message}`);
        }
      } else {
        this.platform.log.error(`An unknown error occurred: ${error}`);
      }
    }
  }

  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.currentHeatingState;
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.currentHeatingState;
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    this.currentHeatingState = value as number;
    try {
      const url = `https://api.developer.sleep.me/v1/devices/${this.deviceId}`;
      const headers = {
        Authorization: `Bearer ${this.platform.config.apiToken}`,
        'Content-Type': 'application/json',
      };
      
      // Map HomeKit states to API values
      let thermalControlStatus = 'cooling';
      if (this.currentHeatingState === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
        thermalControlStatus = 'heating';
      } else if (this.currentHeatingState === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
        thermalControlStatus = 'off';
      }
      
      const data = {
        set_temperature_c: this.targetTemperature,
        brightness_level: 100,
        thermal_control_status: thermalControlStatus,
      };
      
      await this.rateLimitedApiCall(async () => {
        const response = await axios.patch(url, data, { headers });
        this.logAxiosResponse('PATCH', url, response);
        const logMsg = `Heating/Cooling state set to ${thermalControlStatus} for device ${this.deviceId}`;
        this.platform.log.info(logMsg);
        return response;
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          this.platform.log.error(`[API Error] PATCH state - Status: ${axiosError.response.status}`);
          if (axiosError.response.data) {
            this.platform.log.error(`[API Error Data] ${JSON.stringify(axiosError.response.data)}`);
          }
        } else if (axiosError.request) {
          this.platform.log.error('[API Error] PATCH state - No response received');
        } else {
          this.platform.log.error(`[API Error] PATCH state - ${axiosError.message}`);
        }
      } else {
        this.platform.log.error(`An unknown error occurred: ${error}`);
      }
    }
  }
}