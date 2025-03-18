import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SleepMePlatform } from './platform.js';
import { SleepMeApi, DeviceSettings as ApiDeviceSettings } from './sleepme-api.js';

// Constants for temperature and state management
const VALID_TEMP_RANGE = {
  min: 13.0,
  max: 48.0,
  defaultTemp: 21.0,
  step: 0.5,
} as const;

const THERMAL_STATES = {
  OFF: 'off',
  AUTO: 'auto',
  HEATING: 'heating',
  COOLING: 'cooling',
} as const;

type ThermalState = typeof THERMAL_STATES[keyof typeof THERMAL_STATES];

interface DeviceResponse {
  id: string;
  name: string;
  control: {
    set_temperature_c: number;
    target_temperature_c: number;
    current_temperature_c: number;
    thermal_control_status: ThermalState;
    brightness_level?: number;
  };
  status: {
    water_temperature_c: number;
    connection_status: string;
  };
  about: {
    firmware_version: string;
    model: string;
    serial_number: string;
  };
}

interface DeviceStatus extends DeviceResponse {}

// Define local settings type for internal use
interface LocalDeviceSettings {
  control: {
    set_temperature_c: number;
    thermal_control_status: ThermalState;
  };
}

// Convert local settings to API format
function convertToApiSettings(settings: LocalDeviceSettings): ApiDeviceSettings {
  return {
    'control.set_temperature_c': settings.control.set_temperature_c,
    'control.thermal_control_status': settings.control.thermal_control_status,
  };
}

export interface DeviceSettings {
  'control.set_temperature_c': number;
  'control.thermal_control_status': ThermalState;
}

export class SleepMePlatformAccessory {
  private service!: Service;
  private targetTemperature: number;
  private currentTemperature: number;
  private currentHeaterCoolerState: number;
  private targetHeaterCoolerState: number;
  private deviceId: string;
  private firmwareVersion: string;
  private isOnline: boolean;

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
    private apiService: SleepMeApi,
  ) {
    // Set initial values
    this.targetTemperature = VALID_TEMP_RANGE.defaultTemp;
    this.currentTemperature = VALID_TEMP_RANGE.defaultTemp;
    this.currentHeaterCoolerState = this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
    this.targetHeaterCoolerState = this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
    this.deviceId = this.accessory.context.device.id;
    this.firmwareVersion = 'Unknown';
    this.isOnline = false;

    // Initialize services and characteristics
    this.initializeServices();
    
    // Start periodic updates
    this.updateDeviceStatus();
    setInterval(() => {
      this.updateDeviceStatus();
    }, 30000);
  }

  private initializeServices(): void {
    // Set accessory information
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation) ||
      this.accessory.addService(this.platform.Service.AccessoryInformation);
    
    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Sleepme Inc.')
      .setCharacteristic(this.platform.Characteristic.Model, 'ChiliPad')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.deviceId)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.firmwareVersion);

    // Set up HeaterCooler service
    this.service = this.accessory.getService(this.platform.Service.HeaterCooler) || 
      this.accessory.addService(this.platform.Service.HeaterCooler);

    // Configure characteristics
    this.setupCharacteristics();
  }

  private setupCharacteristics(): void {
    const tempProps = {
      minValue: VALID_TEMP_RANGE.min,
      maxValue: VALID_TEMP_RANGE.max,
      minStep: VALID_TEMP_RANGE.step,
    };

    // Active characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    // HeaterCooler state characteristics
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.getCurrentHeaterCoolerState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .onSet(this.setTargetHeaterCoolerState.bind(this))
      .onGet(this.getTargetHeaterCoolerState.bind(this))
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
          this.platform.Characteristic.TargetHeaterCoolerState.HEAT,
          this.platform.Characteristic.TargetHeaterCoolerState.COOL,
        ],
      });

    // Temperature characteristics
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this))
      .setProps(tempProps);

    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .onSet(this.setCoolingThresholdTemperature.bind(this))
      .onGet(this.getCoolingThresholdTemperature.bind(this))
      .setProps(tempProps);

    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .onSet(this.setHeatingThresholdTemperature.bind(this))
      .onGet(this.getHeatingThresholdTemperature.bind(this))
      .setProps(tempProps);
  }

  async setActive(value: CharacteristicValue): Promise<void> {
    try {
      const isActive = value as boolean;
      this.platform.log.debug(`Setting active state to: ${isActive}`);
      
      const settings: LocalDeviceSettings = {
        control: {
          thermal_control_status: isActive ? THERMAL_STATES.AUTO : THERMAL_STATES.OFF,
          set_temperature_c: this.targetTemperature,
        },
      };

      await this.updateDeviceWithRetry(settings);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.platform.log.error('Error setting active state:', errorMessage);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  getActive(): CharacteristicValue {
    return this.currentHeaterCoolerState !== this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
  }

  async setCoolingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    try {
      const temperature = this.validateTemperature(value as number);
      this.platform.log.debug(`Setting cooling threshold temperature to: ${temperature}°C`);
      
      const settings: LocalDeviceSettings = {
        control: {
          set_temperature_c: temperature,
          thermal_control_status: THERMAL_STATES.COOLING,
        },
      };

      await this.updateDeviceWithRetry(settings);
      this.targetTemperature = temperature;
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.platform.log.error('Error setting cooling threshold:', errorMessage);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  getCoolingThresholdTemperature(): CharacteristicValue {
    return this.targetTemperature;
  }

  async setHeatingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    try {
      const temperature = this.validateTemperature(value as number);
      this.platform.log.debug(`Setting heating threshold temperature to: ${temperature}°C`);
      
      const settings: LocalDeviceSettings = {
        control: {
          set_temperature_c: temperature,
          thermal_control_status: THERMAL_STATES.HEATING,
        },
      };

      await this.updateDeviceWithRetry(settings);
      this.targetTemperature = temperature;
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.platform.log.error('Error setting heating threshold:', errorMessage);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  getHeatingThresholdTemperature(): CharacteristicValue {
    return this.targetTemperature;
  }

  getCurrentTemperature(): CharacteristicValue {
    return this.currentTemperature;
  }

  getCurrentHeaterCoolerState(): CharacteristicValue {
    return this.currentHeaterCoolerState;
  }

  getTargetHeaterCoolerState(): CharacteristicValue {
    return this.targetHeaterCoolerState;
  }

  async setTargetHeaterCoolerState(value: CharacteristicValue): Promise<void> {
    try {
      const state = value as number;
      this.platform.log.debug(`Setting target heater cooler state to: ${state}`);
      
      const thermalState = this.mapHomeKitStateToThermalControl(state);
      
      const settings: LocalDeviceSettings = {
        control: {
          thermal_control_status: thermalState,
          set_temperature_c: this.targetTemperature,
        },
      };

      await this.updateDeviceWithRetry(settings);
      this.targetHeaterCoolerState = state;
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.platform.log.error('Error setting target heater cooler state:', errorMessage);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  /**
   * Updates the device status by fetching the latest state from the API
   * and updating the HomeKit characteristics accordingly.
   */
  private async updateDeviceStatus(): Promise<void> {
    try {
      this.platform.log.debug(`Updating status for device: ${this.deviceId}`);
      
      const deviceStatus = await this.apiService.getDeviceStatus(this.deviceId);
      
      if (!deviceStatus) {
        this.isOnline = false;
        return;
      }
      this.isOnline = true;

      // Update temperatures
      if (deviceStatus.water_temperature_c !== undefined) {
        this.currentTemperature = deviceStatus.water_temperature_c;
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentTemperature,
          this.currentTemperature
        );
      }

      if (deviceStatus.control.set_temperature_c !== undefined) {
        this.targetTemperature = deviceStatus.control.set_temperature_c;
        this.service.updateCharacteristic(
          this.platform.Characteristic.CoolingThresholdTemperature,
          this.targetTemperature
        );
        this.service.updateCharacteristic(
          this.platform.Characteristic.HeatingThresholdTemperature,
          this.targetTemperature
        );
      }

      // Update thermal state
      if (deviceStatus.control.thermal_control_status) {
        const thermalStatus = deviceStatus.control.thermal_control_status;
        switch (thermalStatus) {
          case THERMAL_STATES.HEATING:
            this.currentHeaterCoolerState = this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
            break;
          case THERMAL_STATES.COOLING:
            this.currentHeaterCoolerState = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
            break;
          case THERMAL_STATES.OFF:
            this.currentHeaterCoolerState = this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
            break;
          default:
            this.currentHeaterCoolerState = this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
        }

        // Update characteristics
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentHeaterCoolerState,
          this.currentHeaterCoolerState
        );

        this.service.updateCharacteristic(
          this.platform.Characteristic.Active,
          thermalStatus !== THERMAL_STATES.OFF
        );
      }

      // Update firmware version if available
      if (deviceStatus?.about?.firmware_version) {
        this.firmwareVersion = deviceStatus.about.firmware_version;
        const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation);
        if (infoService) {
          infoService.updateCharacteristic(
            this.platform.Characteristic.FirmwareRevision,
            this.firmwareVersion
          );
        }
      }

      this.platform.log.debug(
        `Status updated: Temp=${this.currentTemperature}°C, ` +
        `Target=${this.targetTemperature}°C, ` +
        `State=${deviceStatus.control?.thermal_control_status}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.platform.log.error('Error updating device status:', errorMessage);
      this.isOnline = false;
    }
  }

  // ... rest of the existing methods ...

  private validateTemperature(temperature: number): number {
    const validTemp = Math.round(temperature / VALID_TEMP_RANGE.step) * VALID_TEMP_RANGE.step;
    return Math.max(VALID_TEMP_RANGE.min, Math.min(VALID_TEMP_RANGE.max, validTemp));
  }

  private validateThermalState(state: string): ThermalState {
    if (Object.values(THERMAL_STATES).includes(state as ThermalState)) {
      return state as ThermalState;
    }
    throw new Error(`Invalid thermal state: ${state}`);
  }

  private async updateDeviceWithRetry(settings: LocalDeviceSettings): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const apiSettings = convertToApiSettings(settings);
        await this.apiService.setDeviceSettings(this.deviceId, apiSettings);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }

    throw lastError || new Error('Failed to update device after multiple retries');
  }

  private async syncDeviceState(): Promise<void> {
    if (!this.isOnline) {
      throw new Error('Device is offline');
    }

    const settings: LocalDeviceSettings = {
      control: {
        set_temperature_c: this.targetTemperature,
        thermal_control_status: this.validateThermalState(
          this.mapHomeKitStateToThermalControl(this.targetHeaterCoolerState)
        ),
      },
    };

    await this.updateDeviceWithRetry(settings);
  }

  private mapHomeKitStateToThermalControl(state: number): ThermalState {
    switch (state) {
      case this.platform.Characteristic.TargetHeaterCoolerState.HEAT:
        return THERMAL_STATES.HEATING;
      case this.platform.Characteristic.TargetHeaterCoolerState.COOL:
        return THERMAL_STATES.COOLING;
      case this.platform.Characteristic.TargetHeaterCoolerState.AUTO:
        return THERMAL_STATES.AUTO;
      default:
        return THERMAL_STATES.OFF;
    }
  }
}